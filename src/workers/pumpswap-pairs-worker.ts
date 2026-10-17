/**
 * PumpSwap pairs worker: WebSocket listener for confirmed transactions that mention
 * the PumpSwap program. On create_pool logs: fetches tx, parses create_pool, resolves
 * base/quote mints and vaults via RPC, and upserts into pairs.
 */

import 'dotenv/config';
import { Redis } from 'ioredis';
import { LRUCache } from 'lru-cache';
import { Connection, PublicKey } from '@solana/web3.js';
import { getHeliusRpcUrl } from '../config.js';
import { db } from '../db.js';
import {
  parsePumpSwapPoolCreationFromTx,
  PUMP_SWAP_PROGRAM_ID,
  WSOL_MINT,
  type ParsedPumpSwapPoolCreation,
} from '../pumpswap-rpc-parser.js';
import { parseMintAccount } from '../pools/pumpswap-pool-state.js';
import { stripPgNul, stripPgNulNullable } from '../db/pg-text.js';
import { getTokenNameSymbolWithFallback } from '../token-metadata.js';
import type { FetchedTxPayload } from './pumpswap-types.js';

const LOG_PREFIX = '[pumpswap-pairs-worker]';
const REDIS_CHANNEL_NEW_PAIRS = 'pairs:new';
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const CHAIN = 'solana';
const DEX = 'pumpswap';
const PAIR_SOURCE_RPC = 'pumpswap_rpc';

/** In-memory LRU cache for seen transaction signatures to avoid duplicate processing after reconnects/slot replays. */
const seenSignatures = new LRUCache<string, boolean>({ max: 50_000 });

/** When set (e.g. DEBUG_PUMPSWAP_PAIRS_FETCH=1), log each failed getTransaction. */
const LOG_FETCH_FAILURES = process.env.DEBUG_PUMPSWAP_PAIRS_FETCH === '1' || process.env.DEBUG_PUMPSWAP_PAIRS_FETCH === 'true';

/** Redis client for publishing new-pair events. Only created when REDIS_URL is set. */
let redis: Redis | null = null;
function getRedis(): Redis | null {
  if (redis != null) return redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    redis = new Redis(url);
    return redis;
  } catch {
    return null;
  }
}

/** Pre-filter: true if any log line contains the given PumpSwap instruction name (e.g. "CreatePool"). */
function hasInstruction(logs: string[], name: string): boolean {
  return logs.some((l) => l.includes(`Instruction: ${name}`));
}

/** Apply ±20% multiplicative jitter to a delay (for reconnect backoff). */
function applyJitter(ms: number): number {
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.floor(ms * jitter);
}

const pairExists = db.prepare(`SELECT 1 FROM pairs WHERE pair_address = $pairAddress LIMIT 1`);

const upsertPairStmt = db.prepare(`
  INSERT INTO pairs (
    pair_address,
    chain,
    dex,
    base_token_address,
    quote_token_address,
    base_symbol,
    quote_symbol,
    base_vault,
    quote_vault,
    pair_created_at,
    creator_wallet,
    method,
    source,
    base_decimals,
    quote_decimals,
    base_has_mint_authority,
    base_has_freeze_authority,
    base_supply_raw
  ) VALUES ($pairAddress, $chain, $dex, $baseTokenAddress, $quoteTokenAddress, $baseSymbol, $quoteSymbol, $baseVault, $quoteVault, $pairCreatedAt, $creatorWallet, 'websocket', $source, $baseDecimals, $quoteDecimals, $baseHasMintAuthority, $baseHasFreezeAuthority, $baseSupplyRaw)
  ON CONFLICT(pair_address) DO UPDATE SET
    base_symbol = CASE
      WHEN (excluded.base_symbol IS NULL OR TRIM(excluded.base_symbol) = '' OR LOWER(TRIM(excluded.base_symbol)) = 'unknown')
       AND (pairs.base_symbol IS NOT NULL AND TRIM(pairs.base_symbol) <> '' AND LOWER(TRIM(pairs.base_symbol)) <> 'unknown')
      THEN pairs.base_symbol
      ELSE excluded.base_symbol
    END,
    quote_symbol = CASE
      WHEN (excluded.quote_symbol IS NULL OR TRIM(excluded.quote_symbol) = '' OR LOWER(TRIM(excluded.quote_symbol)) = 'unknown')
       AND (pairs.quote_symbol IS NOT NULL AND TRIM(pairs.quote_symbol) <> '' AND LOWER(TRIM(pairs.quote_symbol)) <> 'unknown')
      THEN pairs.quote_symbol
      ELSE excluded.quote_symbol
    END,
    base_vault = COALESCE(excluded.base_vault, pairs.base_vault),
    quote_vault = COALESCE(excluded.quote_vault, pairs.quote_vault),
    pair_created_at = COALESCE(excluded.pair_created_at, pairs.pair_created_at),
    creator_wallet = COALESCE(excluded.creator_wallet, pairs.creator_wallet),
    base_decimals = COALESCE(excluded.base_decimals, pairs.base_decimals),
    quote_decimals = COALESCE(excluded.quote_decimals, pairs.quote_decimals),
    base_has_mint_authority = COALESCE(excluded.base_has_mint_authority, pairs.base_has_mint_authority),
    base_has_freeze_authority = COALESCE(excluded.base_has_freeze_authority, pairs.base_has_freeze_authority),
    base_supply_raw = COALESCE(excluded.base_supply_raw, pairs.base_supply_raw),
    method = excluded.method,
    source = excluded.source
`);

/** Fetch base/quote mints and pool token account vaults from pool account via RPC (PumpSwap SDK). */
async function getPoolBaseQuoteFromRpc(
  connection: Connection,
  poolAddress: string
): Promise<{ baseMint: string; quoteMint: string; baseVault: string | null; quoteVault: string | null } | null> {
  try {
    const poolKey = new PublicKey(poolAddress);
    const { OnlinePumpAmmSdk } = await import('@pump-fun/pump-swap-sdk');
    const sdk = new OnlinePumpAmmSdk(connection);
    console.log(`${LOG_PREFIX} RPC call: swapSolanaState pool=${poolAddress.slice(0, 12)}…`);
    const swapState = await sdk.swapSolanaState(poolKey, poolKey);
    const state = swapState as unknown as Record<string, unknown>;
    const poolObj = state.pool as Record<string, unknown> | undefined;
    if (!poolObj) return null;
    const toB58 = (k: unknown): string | null => {
      if (k == null) return null;
      if (typeof k === 'string') return k;
      if (typeof (k as { toBase58?: () => string }).toBase58 === 'function')
        return (k as { toBase58: () => string }).toBase58();
      return null;
    };
    const baseMint = toB58(poolObj.baseMint ?? poolObj.base_mint);
    const quoteMint = toB58(poolObj.quoteMint ?? poolObj.quote_mint);
    if (!baseMint || !quoteMint) return null;
    const baseVault = toB58(
      poolObj.poolBaseTokenAccount ?? poolObj.pool_base_token_account ?? poolObj.baseTokenAccount ?? poolObj.base_token_account
    ) ?? null;
    const quoteVault = toB58(
      poolObj.poolQuoteTokenAccount ?? poolObj.pool_quote_token_account ?? poolObj.quoteTokenAccount ?? poolObj.quote_token_account
    ) ?? null;
    return { baseMint, quoteMint, baseVault, quoteVault };
  } catch {
    return null;
  }
}

/**
 * Parse create_pool from tx, resolve base/quote/vaults from RPC, resolve symbols, upsert pair.
 * Logs and returns; does not throw.
 */
async function processPoolCreation(
  payload: FetchedTxPayload,
  signature: string,
  heliusRpcUrl: string
): Promise<void> {
  const message = payload.message as Parameters<typeof parsePumpSwapPoolCreationFromTx>[0];
  const metaRaw = payload.meta as Record<string, unknown> | null | undefined;
  const meta = metaRaw as Parameters<typeof parsePumpSwapPoolCreationFromTx>[3];
  const loadedAddresses = (metaRaw?.loadedAddresses ?? metaRaw?.loaded_addresses) as
    | { writable?: unknown[]; readonly?: unknown[] }
    | null
    | undefined;

  let parsed: ParsedPumpSwapPoolCreation | null = null;
  try {
    parsed = parsePumpSwapPoolCreationFromTx(
      message,
      loadedAddresses ?? null,
      { checkPumpFunInSameTx: true },
      meta
    );
  } catch (parseErr) {
    console.error(`${LOG_PREFIX} parse threw for signature ${signature}:`, parseErr);
    return;
  }

  if (!parsed) {
    const topIx =
      (message as Record<string, unknown>).instructions ??
      (message as Record<string, unknown>).compiledInstructions ??
      (message as Record<string, unknown>).compiled_instructions ??
      [];
    const topLen = Array.isArray(topIx) ? topIx.length : 0;
    const inner = (metaRaw?.innerInstructions ?? metaRaw?.inner_instructions) as
      | Array<{ instructions?: unknown[] }>
      | undefined;
    const innerLen = (inner ?? []).reduce(
      (n, b) => n + (Array.isArray(b.instructions) ? b.instructions.length : 0),
      0
    );
    const keyHint = Object.keys(message as object)
      .filter((k) => /account|instruction/i.test(k))
      .join(', ') || '(none)';
    console.error(
      `${LOG_PREFIX} parser returned null for signature: ${signature} (message keys: ${keyHint}, top instructions: ${topLen}, inner: ${innerLen}). Set DEBUG_PUMPSWAP_PARSER=1 for details.`
    );
    return;
  }

  const quoteLabel = parsed.quoteMint === WSOL_MINT ? 'SOL' : 'quote';
  console.log(`${LOG_PREFIX} pool: ${parsed.poolAddress}`);
  console.log(`${LOG_PREFIX} base: ${parsed.baseMint}`);
  console.log(`${LOG_PREFIX} ${quoteLabel}: ${parsed.quoteMint}`);

  const connection = new Connection(heliusRpcUrl, { commitment: 'confirmed' });
  let baseMint = parsed.baseMint;
  let quoteMint = parsed.quoteMint;
  let baseVault: string | null = null;
  let quoteVault: string | null = null;
  const poolFromRpc = await getPoolBaseQuoteFromRpc(connection, parsed.poolAddress);
  if (poolFromRpc) {
    baseMint = poolFromRpc.baseMint;
    quoteMint = poolFromRpc.quoteMint;
    baseVault = poolFromRpc.baseVault;
    quoteVault = poolFromRpc.quoteVault;
  }

  // Normalize so base = token, quote = SOL (SDK sometimes returns base = SOL, quote = token).
  if (baseMint === WSOL_MINT && quoteMint !== WSOL_MINT) {
    const swpM = baseMint;
    baseMint = quoteMint;
    quoteMint = swpM;
    const swpV = baseVault;
    baseVault = quoteVault;
    quoteVault = swpV;
  }

  let baseSymbol = 'UNKNOWN';
  let quoteSymbol = quoteMint === WSOL_MINT ? 'SOL' : 'UNKNOWN';
  const baseMeta = await getTokenNameSymbolWithFallback(connection, baseMint, { heliusRpcUrl });
  if (baseMeta?.symbol) baseSymbol = stripPgNul(baseMeta.symbol);
  if (quoteMint !== WSOL_MINT) {
    const quoteMeta = await getTokenNameSymbolWithFallback(connection, quoteMint, { heliusRpcUrl });
    if (quoteMeta?.symbol) quoteSymbol = stripPgNul(quoteMeta.symbol);
  }

  let baseDecimals: number | null = null;
  let baseHasMintAuthority: number | null = null;
  let baseHasFreezeAuthority: number | null = null;
  let baseSupplyRaw: string | null = null;
  try {
    const mintPubkey = new PublicKey(baseMint);
    console.log(`${LOG_PREFIX} RPC call: getAccountInfo mint=${baseMint.slice(0, 12)}…`);
    const mintInfo = await connection.getAccountInfo(mintPubkey, {
      dataSlice: { offset: 0, length: 50 },
      commitment: 'confirmed',
    });
    if (mintInfo?.data) {
      const data = mintInfo.data instanceof Buffer ? mintInfo.data : new Uint8Array(mintInfo.data as ArrayLike<number>);
      const mint = parseMintAccount(data);
      baseDecimals = mint.decimals;
      baseHasMintAuthority = mint.hasMintAuthority ? 1 : 0;
      baseHasFreezeAuthority = mint.hasFreezeAuthority ? 1 : 0;
      baseSupplyRaw = mint.supplyRaw.toString();
    }
  } catch {
    // Leave mint fields null if fetch fails; snapshots worker may fall back to RPC.
  }

  let quoteDecimals: number | null = null;
  if (quoteMint === WSOL_MINT) {
    quoteDecimals = 9;
  } else {
    try {
      const qPk = new PublicKey(quoteMint);
      console.log(`${LOG_PREFIX} RPC call: getAccountInfo quote mint=${quoteMint.slice(0, 12)}…`);
      const qInfo = await connection.getAccountInfo(qPk, {
        dataSlice: { offset: 0, length: 50 },
        commitment: 'confirmed',
      });
      if (qInfo?.data) {
        const data = qInfo.data instanceof Buffer ? qInfo.data : new Uint8Array(qInfo.data as ArrayLike<number>);
        const mint = parseMintAccount(data);
        quoteDecimals = mint.decimals;
      }
    } catch {
      // Leave null if fetch fails
    }
  }

  const pairCreatedAt = payload.blockTime ?? null;
  const isNew = pairExists.get({ pairAddress: parsed.poolAddress }) == null;
  upsertPairStmt.run({
    pairAddress: stripPgNul(parsed.poolAddress),
    chain: stripPgNul(CHAIN),
    dex: stripPgNul(DEX),
    baseTokenAddress: stripPgNul(baseMint),
    quoteTokenAddress: stripPgNul(quoteMint),
    baseSymbol: stripPgNul(baseSymbol) || 'UNKNOWN',
    quoteSymbol:
      stripPgNul(quoteSymbol) || (quoteMint === WSOL_MINT ? 'SOL' : 'UNKNOWN'),
    baseVault: stripPgNulNullable(baseVault),
    quoteVault: stripPgNulNullable(quoteVault),
    pairCreatedAt,
    creatorWallet: stripPgNulNullable(parsed.creator),
    source: stripPgNul(PAIR_SOURCE_RPC),
    baseDecimals,
    quoteDecimals,
    baseHasMintAuthority,
    baseHasFreezeAuthority,
    baseSupplyRaw: stripPgNulNullable(baseSupplyRaw),
  });
  console.log(
    `${LOG_PREFIX} ${isNew ? 'inserted' : 'updated'} pair in DB (base=${baseSymbol}, quote=${quoteSymbol})`
  );

  if (baseVault != null && quoteVault != null) {
    const client = getRedis();
    if (client) {
      try {
        await client.publish(
          REDIS_CHANNEL_NEW_PAIRS,
          JSON.stringify({
            pairAddress: parsed.poolAddress,
            baseVault,
            quoteVault,
            baseMint,
            quoteMint,
          })
        );
      } catch (err) {
        console.warn(`${LOG_PREFIX} Redis publish failed:`, err instanceof Error ? err.message : err);
      }
    }
  }
}

function sendLogsSubscribe(ws: WebSocket, subscriptionId: number): void {
  console.log(`${LOG_PREFIX} RPC call: logsSubscribe`);
  ws.send(
    JSON.stringify({
      jsonrpc: '2.0',
      id: subscriptionId,
      method: 'logsSubscribe',
      params: [{ mentions: [PUMP_SWAP_PROGRAM_ID] }, { commitment: 'processed' }],
    })
  );
}

/** Fetch a single transaction by signature (jsonParsed). Retries up to 2 times with backoff if first attempt(s) fail. */
async function fetchTransaction(
  heliusRpcUrl: string,
  signature: string,
  options?: { retryDelaysMs?: number[] }
): Promise<FetchedTxPayload | null> {
  const retryDelaysMs = options?.retryDelaysMs ?? [1500, 3000];
  const attempt = async (): Promise<FetchedTxPayload | null> => {
    console.log(`${LOG_PREFIX} RPC call: getTransaction signature=${signature.slice(0, 16)}…`);
    const res = await fetch(heliusRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'getTransaction',
        params: [
          signature,
          { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      result?: { transaction?: { message?: unknown }; meta?: unknown; blockTime?: number | null };
      error?: unknown;
    };
    if (data.error || !data.result?.transaction?.message) return null;
    return {
      message: data.result.transaction.message,
      meta: data.result.meta ?? null,
      blockTime: data.result.blockTime ?? null,
    };
  };
  let result = await attempt();
  for (const delayMs of retryDelaysMs) {
    if (result != null) break;
    await new Promise((r) => setTimeout(r, delayMs));
    result = await attempt();
  }
  return result;
}

function connect(wsUrl: string, heliusRpcUrl: string, nextReconnectDelayMs?: number): WebSocket {
  const ws = new WebSocket(wsUrl);
  let delayMs = nextReconnectDelayMs ?? RECONNECT_MIN_MS;

  ws.onopen = () => {
    console.log(`${LOG_PREFIX} Connected, subscribing to logs (mentions: ${PUMP_SWAP_PROGRAM_ID})`);
    sendLogsSubscribe(ws, 1);
  };

  ws.onmessage = async (event: MessageEvent) => {
    try {
      const data = JSON.parse(event.data as string) as {
        id?: number;
        method?: string;
        params?: { result?: { value?: { signature?: string; logs?: string[] }; subscription?: number } };
        result?: number;
        error?: { code?: number; message?: string };
      };

      if (data.error) {
        console.error(`${LOG_PREFIX} RPC error:`, data.error.message ?? data.error);
        return;
      }

      if (typeof data.result === 'number' && data.id === 1) {
        console.log(`${LOG_PREFIX} Subscription confirmed (id ${data.result})`);
        return;
      }

      if (data.method !== 'logsNotification') return;

      const value = data.params?.result?.value as
        | { signature?: string; logs?: string[]; err?: unknown }
        | undefined;
      if (value?.err) return;
      if (typeof value?.signature !== 'string') return;

      const signature = value.signature;

      if (seenSignatures.has(signature)) return;
      seenSignatures.set(signature, true);

      const logs = (value?.logs ?? []).filter((l): l is string => typeof l === 'string');
      if (!hasInstruction(logs, 'CreatePool')) return;

      const payload = await fetchTransaction(heliusRpcUrl, signature);

      if (!payload) {
        if (LOG_FETCH_FAILURES) {
          console.warn(
            `${LOG_PREFIX} could not fetch transaction for signature: ${signature} (tx may be pruned or not yet available)`
          );
        }
        return;
      }

      console.log(`${LOG_PREFIX} create_pool → processing signature: ${signature}`);
      await processPoolCreation(payload, signature, heliusRpcUrl);
    } catch (err) {
      console.error(`${LOG_PREFIX} Message parse error:`, err);
    }
  };

  ws.onerror = (e) => {
    console.error(`${LOG_PREFIX} WebSocket error:`, e);
  };

  ws.onclose = (event: CloseEvent | { code?: number; reason?: string } | number) => {
    const code = typeof event === 'number' ? event : event?.code ?? '?';
    const reason =
      typeof event === 'object' &&
      event != null &&
      'reason' in event &&
      event.reason != null &&
      String(event.reason).trim() !== ''
        ? event.reason
        : 'no reason';
    delayMs = Math.min(delayMs * 2, RECONNECT_MAX_MS);
    const delayWithJitter = Math.max(applyJitter(delayMs), RECONNECT_MIN_MS);
    console.warn(
      `${LOG_PREFIX} Closed (code ${code}, reason: ${reason}), reconnecting in ${delayWithJitter}ms…`
    );
    setTimeout(() => connect(wsUrl, heliusRpcUrl, delayMs), delayWithJitter);
  };

  return ws;
}

export async function startPumpswapPairsWorker(): Promise<void> {
  const rpcUrl = getHeliusRpcUrl();
  if (!rpcUrl) {
    console.error(`${LOG_PREFIX} HELIUS_RPC_URL is required. Exiting.`);
    process.exit(1);
  }

  const wsUrl = rpcUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  console.log(`${LOG_PREFIX} Connecting to ${wsUrl.replace(/\?api-key=[^&]+/, '?api-key=…')}`);
  connect(wsUrl, rpcUrl);
}

import { fileURLToPath } from 'node:url';

const isMain =
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1]?.endsWith('pumpswap-pairs-worker.js');

if (isMain) {
  startPumpswapPairsWorker().catch((err) => {
    console.error(`${LOG_PREFIX} Fatal:`, err);
    process.exit(1);
  });
}
