/**
 * Fetch PumpSwap pool volume (1m, 5m, 15m) and buy/sell counts (1m) from chain.
 * Tries Helius getTransactionsForAddress first; if unavailable or no data, falls back to
 * standard RPC (getSignaturesForAddress + getTransaction). Used by the chain-snapshots worker.
 */
import { createHash } from 'node:crypto';
import { Connection, PublicKey, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { PUMP_SWAP_PROGRAM_ID } from '../pumpswap-rpc-parser.js';
import { getHeliusRpcUrl, getSolanaRpcUrl } from '../config.js';

const LAMPORTS_PER_SOL = 1e9;
const ONE_MINUTE_SEC = 60;
const FIVE_MINUTES_SEC = 300;
const FIFTEEN_MINUTES_SEC = 900;
const MAX_TXS_TO_FETCH = 40;
/** Standard RPC fallback: fetch fewer txs to limit getTransaction calls (1 + N per pool). */
const FALLBACK_MAX_TXS = 20;
/** Delay between getTransaction calls in fallback (ms) to reduce RPC rate pressure. */
const FALLBACK_TX_DELAY_MS = 50;
/** When set (e.g. DEBUG_PUMPSWAP_VOLUME=1), log volume fetch details for the first pool. */
const DEBUG_VOLUME = process.env.DEBUG_PUMPSWAP_VOLUME === '1' || process.env.DEBUG_PUMPSWAP_VOLUME === 'true';
/** When set, log one-line volume summary per pool (always, not just first). */
const LOG_VOLUME_SUMMARY = process.env.LOG_PUMPSWAP_VOLUME === '1' || process.env.LOG_PUMPSWAP_VOLUME === 'true' || DEBUG_VOLUME;
/** Cap single instruction amount to avoid treating token amounts as lamports (max ~1000 SOL). */
const MAX_LAMPORTS_PER_INSTRUCTION = 1e12;

function toBase58(key: unknown): string {
  if (typeof key === 'string') return key;
  if (key != null && typeof key === 'object') {
    const o = key as Record<string, unknown>;
    if (typeof o.toBase58 === 'function') return (o.toBase58 as () => string)();
    if (typeof o.pubkey === 'string') return o.pubkey;
  }
  return '';
}

function getAccountKeys(
  message: {
    staticAccountKeys?: unknown[];
    accountKeys?: unknown[];
    static_account_keys?: unknown[];
    account_keys?: unknown[];
  },
  loadedAddresses?: { writable?: unknown[]; readonly?: unknown[] } | null
): string[] {
  const staticKeys = (
    message.staticAccountKeys ??
    message.accountKeys ??
    message.static_account_keys ??
    message.account_keys ??
    []
  ).map(toBase58);
  if (!loadedAddresses?.writable?.length && !loadedAddresses?.readonly?.length) {
    return staticKeys;
  }
  const writable = (loadedAddresses.writable ?? []).map(toBase58);
  const readonly = (loadedAddresses.readonly ?? []).map(toBase58);
  return [...staticKeys, ...writable, ...readonly];
}

/** Normalize instruction to { programIdIndex, data } for parsing.
 * Handles camelCase, snake_case, and Uint8Array data from @solana/web3.js decoded messages. */
function normalizeInstruction(ix: Record<string, unknown>): { programIdIndex: number; data?: string } | null {
  const programIdIndex = (ix.programIdIndex ?? ix.program_id_index ?? ix.programId ?? ix.program) as number | undefined;
  if (programIdIndex == null || typeof programIdIndex !== 'number') return null;
  const rawData = ix.data ?? ix.bytes;
  let data: string | undefined;
  if (typeof rawData === 'string') {
    data = rawData;
  } else if (rawData instanceof Uint8Array || Buffer.isBuffer(rawData)) {
    data = Buffer.from(rawData).toString('base64');
  }
  return { programIdIndex, data };
}

/** Normalize instructions array from message (compiledInstructions / instructions / snake_case). */
function getInstructions(
  message: {
    compiledInstructions?: unknown;
    instructions?: unknown;
    compiled_instructions?: unknown;
  }
): Array<{ programIdIndex: number; data?: string }> {
  const raw =
    message.compiledInstructions ??
    message.instructions ??
    message.compiled_instructions ??
    [];
  if (!Array.isArray(raw)) return [];
  const out: Array<{ programIdIndex: number; data?: string }> = [];
  for (const ix of raw) {
    if (ix == null || typeof ix !== 'object') continue;
    const n = normalizeInstruction(ix as Record<string, unknown>);
    if (n != null) out.push(n);
  }
  return out;
}

function readU64LE(data: Uint8Array, offset: number): number {
  if (offset + 8 > data.length) return 0;
  const view = new DataView(data.buffer, data.byteOffset + offset, 8);
  const lo = view.getUint32(0, true);
  const hi = view.getUint32(4, true);
  const n = hi * 0x1_0000_0000 + lo;
  return Number.isFinite(n) ? n : 0;
}

/** Anchor instruction discriminator: first 8 bytes of sha256("global:name"). */
function anchorDiscriminator(name: string): Uint8Array {
  const hash = createHash('sha256').update(`global:${name}`).digest();
  return hash.subarray(0, 8);
}

/** PumpSwap IDL instruction names: "buy", "buy_exact_quote_in", "sell" (not buy_quote_input/sell_base_input). */
const BUY_DISCRIMINATORS = [
  anchorDiscriminator('buy'),
  anchorDiscriminator('buy_exact_quote_in'),
];
const SELL_DISCRIMINATOR = anchorDiscriminator('sell');

function discriminatorMatches(data: Uint8Array, disc: Uint8Array): boolean {
  if (data.length < 8) return false;
  for (let i = 0; i < 8; i++) if (data[i] !== disc[i]) return false;
  return true;
}

function isBuyInstruction(data: Uint8Array): boolean {
  return BUY_DISCRIMINATORS.some((d) => discriminatorMatches(data, d));
}

function isSellInstruction(data: Uint8Array): boolean {
  return discriminatorMatches(data, SELL_DISCRIMINATOR);
}

export interface SwapCounts {
  lamports: number;
  buys: number;
  sells: number;
}

/**
 * Sum SOL (lamports) and count buy/sell instructions from PumpSwap swap instructions in a transaction.
 * Instruction data: 8-byte discriminator + args. Buy = "buy" | "buy_exact_quote_in", sell = "sell".
 * Supports instruction data as base64 or base58 (jsonParsed encoding).
 */
function sumVolumeAndCountsFromTx(
  accountKeys: string[],
  instructions: Array<{ programIdIndex: number; data?: string }>,
  programId: string
): SwapCounts {
  const programIdIndex = accountKeys.indexOf(programId);
  let lamports = 0;
  let buys = 0;
  let sells = 0;
  if (programIdIndex < 0) {
    if (DEBUG_VOLUME && instructions.length > 0) {
      const hasData = instructions.some((ix) => ix.data);
      console.warn(
        '[pumpswap-volume] PUMP_SWAP not in accountKeys:',
        'accountKeysLen=', accountKeys.length,
        'programIdIndex=-1',
        'instructions=', instructions.length,
        'instructionsWithData=', instructions.filter((ix) => ix.data).length,
        'firstKeys=', accountKeys.slice(0, 3).join(','),
      );
    }
    return { lamports: 0, buys: 0, sells: 0 };
  }
  for (const ix of instructions) {
    if (ix.programIdIndex !== programIdIndex || !ix.data) continue;
    let data: Uint8Array;
    try {
      if (/^[A-Za-z0-9+/=]+$/.test(ix.data) && ix.data.length % 4 !== 1) {
        data = new Uint8Array(Buffer.from(ix.data, 'base64'));
      } else {
        data = new Uint8Array(bs58.decode(ix.data));
      }
    } catch {
      continue;
    }
    if (data.length < 16) continue;
    if (isBuyInstruction(data)) buys += 1;
    else if (isSellInstruction(data)) sells += 1;
    const amount = readU64LE(data, 8);
    if (amount <= 0 || amount > MAX_LAMPORTS_PER_INSTRUCTION) continue;
    lamports += amount;
  }
  return { lamports, buys, sells };
}

export interface PumpSwapVolumeResult {
  volume1mUsd: number | null;
  volume5mUsd: number | null;
  volume15mUsd: number | null;
  buys1m: number | null;
  sells1m: number | null;
}

/** Helius getTransactionsForAddress response item (transactionDetails: 'full'). */
interface HeliusTxItem {
  slot?: number;
  blockTime?: number | null;
  transaction?: unknown;
  meta?: { err?: unknown; loadedAddresses?: { writable?: unknown[]; readonly?: unknown[] } } | null;
  /** Some APIs return message at top level */
  message?: unknown;
  accountKeys?: unknown[];
  instructions?: unknown[];
  compiledInstructions?: unknown;
}

/** Extract message-like object from a raw API item (transaction.message or item itself). If transaction is base64, deserialize and build message.
 * Merges meta.loadedAddresses (writable + readonly) into account keys so versioned txs with address lookup tables resolve program IDs.
 * Helius returns transaction as [base64String, "base64"] per docs; we normalize to string. */
function getMessageFromItem(item: HeliusTxItem): Record<string, unknown> | null {
  let tx = item.transaction;
  if (Array.isArray(tx) && typeof tx[0] === 'string') {
    tx = tx[0];
  }
  if (typeof tx === 'string') {
    try {
      const buf = Buffer.from(tx, 'base64');
      if (buf.length < 10) {
        if (DEBUG_VOLUME) console.warn('[pumpswap-volume] getMessageFromItem: base64 buf too short');
        return null;
      }
      const versionedTx = VersionedTransaction.deserialize(buf);
      const msg = versionedTx.message;
      let keysObj: { keySegments: () => unknown[][] };
      try {
        keysObj = (msg as { getAccountKeys(): { keySegments(): unknown[][] } }).getAccountKeys();
      } catch {
        try {
          keysObj = (msg as { getAccountKeys(arg: unknown): { keySegments(): unknown[][] } }).getAccountKeys({ addressLookupTableAccounts: [] });
        } catch {
          if (DEBUG_VOLUME) console.warn('[pumpswap-volume] getMessageFromItem: getAccountKeys failed (no ALTs)');
          return null;
        }
      }
      const staticKeys = keysObj.keySegments().flat().map((k: unknown) =>
        k != null && typeof k === 'object' && typeof (k as { toBase58?: () => string }).toBase58 === 'function'
          ? (k as { toBase58: () => string }).toBase58()
          : String(k)
      );
      const loaded = item.meta?.loadedAddresses ?? (item.meta as { loaded_addresses?: { writable?: unknown[]; readonly?: unknown[] } } | undefined)?.loaded_addresses;
      const writable = (loaded?.writable ?? []).map((k: unknown) =>
        typeof k === 'string' ? k : (k != null && typeof k === 'object' && typeof (k as { toBase58?: () => string }).toBase58 === 'function'
          ? (k as { toBase58: () => string }).toBase58()
          : String(k))
      );
      const readonly = (loaded?.readonly ?? []).map((k: unknown) =>
        typeof k === 'string' ? k : (k != null && typeof k === 'object' && typeof (k as { toBase58?: () => string }).toBase58 === 'function'
          ? (k as { toBase58: () => string }).toBase58()
          : String(k))
      );
      const accountKeys = loaded && (writable.length > 0 || readonly.length > 0)
        ? [...staticKeys, ...writable, ...readonly]
        : staticKeys;
      const compiledInstructions = (msg as { compiledInstructions: Array<{ programIdIndex: number; data: Uint8Array }> }).compiledInstructions.map((ix) => ({
        programIdIndex: ix.programIdIndex,
        data: Buffer.from(ix.data).toString('base64'),
      }));
      return { accountKeys, compiledInstructions, instructions: compiledInstructions };
    } catch (e) {
      if (DEBUG_VOLUME) console.warn('[pumpswap-volume] getMessageFromItem: base64 deserialize error', e instanceof Error ? e.message : e);
      return null;
    }
  }
  if (typeof tx !== 'string' && tx != null && typeof tx === 'object') {
    const msg = (tx as Record<string, unknown>).message;
    if (msg != null && typeof msg === 'object') {
      const msgObj = msg as Record<string, unknown>;
      const loaded = item.meta?.loadedAddresses ?? (item.meta as { loaded_addresses?: { writable?: unknown[]; readonly?: unknown[] } } | undefined)?.loaded_addresses;
      if (loaded && ((loaded.writable?.length ?? 0) > 0 || (loaded.readonly?.length ?? 0) > 0)) {
        const existingKeys = (
          msgObj.staticAccountKeys ?? msgObj.accountKeys ?? msgObj.static_account_keys ?? msgObj.account_keys ?? []
        ) as unknown[];
        const staticKeys = existingKeys.map(toBase58);
        const writable = (loaded.writable ?? []).map(toBase58);
        const readonly = (loaded.readonly ?? []).map(toBase58);
        return { ...msgObj, accountKeys: [...staticKeys, ...writable, ...readonly] };
      }
      return msgObj;
    }
  }
  if (item.message != null && typeof item.message === 'object') return item.message as Record<string, unknown>;
  if (item.accountKeys != null || item.instructions != null)
    return {
      accountKeys: item.accountKeys,
      instructions: item.instructions,
      compiledInstructions: item.compiledInstructions,
    } as Record<string, unknown>;
  return null;
}

/**
 * Fetch transactions for a pool address via Helius getTransactionsForAddress (one RPC call).
 * Returns array of { blockTime, message, loadedAddresses } for successful txs, or null on error / non-Helius.
 * Handles both: item.transaction.message and item.message (when API returns transaction at top level).
 */
async function fetchPoolTransactionsViaHelius(
  heliusRpcUrl: string,
  poolAddress: string,
  since15m: number
): Promise<HeliusTxItem[] | null> {
  try {
    const res = await fetch(heliusRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'getTransactionsForAddress',
        params: [
          poolAddress,
          {
            transactionDetails: 'full',
            limit: MAX_TXS_TO_FETCH,
            sortOrder: 'desc',
            commitment: 'confirmed',
            encoding: 'base64',
            maxSupportedTransactionVersion: 0,
            filters: {
              blockTime: { gte: since15m },
              status: 'succeeded',
            },
          },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      result?: HeliusTxItem[] | { data?: HeliusTxItem[] };
      error?: { message?: string };
    };
    if (data.error) {
      if (DEBUG_VOLUME) console.warn('[pumpswap-volume] Helius API error:', data.error.message ?? data.error);
      return null;
    }
    const raw = data.result;
    if (raw == null) {
      if (DEBUG_VOLUME) console.warn('[pumpswap-volume] Helius result is null');
      return null;
    }
    const list = Array.isArray(raw) ? raw : (raw as { data?: HeliusTxItem[] }).data;
    if (!list || !Array.isArray(list)) {
      if (DEBUG_VOLUME) console.warn('[pumpswap-volume] Helius result not array, keys=', raw != null ? Object.keys(raw as object) : []);
      return null;
    }
    if (DEBUG_VOLUME) console.warn('[pumpswap-volume] Helius returned', list.length, 'txs for pool', poolAddress.slice(0, 12));
    return list;
  } catch (e) {
    if (DEBUG_VOLUME) console.warn('[pumpswap-volume] fetch error:', e);
    return null;
  }
}

/**
 * Fallback: fetch recent transactions for a pool using standard Solana RPC
 * (getSignaturesForAddress + getTransaction). Used when Helius getTransactionsForAddress
 * is unavailable or returns no data. Same item shape as Helius so parsing is shared.
 */
async function fetchPoolTransactionsViaStandardRpc(
  connection: Connection,
  poolAddress: string,
  since15m: number
): Promise<HeliusTxItem[] | null> {
  try {
    const sigs = await connection.getSignaturesForAddress(new PublicKey(poolAddress), {
      limit: FALLBACK_MAX_TXS,
      commitment: 'confirmed',
    });
    if (!sigs?.length) {
      if (DEBUG_VOLUME) console.warn('[pumpswap-volume] Fallback: no signatures for', poolAddress.slice(0, 12));
      return null;
    }
    const rpcUrl =
      (connection as { rpcEndpoint?: string }).rpcEndpoint ??
      (connection as { _rpcEndpoint?: string })._rpcEndpoint ??
      getHeliusRpcUrl() ??
      getSolanaRpcUrl();
    if (!rpcUrl) {
      if (DEBUG_VOLUME) console.warn('[pumpswap-volume] Fallback: Connection has no rpcEndpoint');
      return null;
    }
    if (DEBUG_VOLUME) console.warn('[pumpswap-volume] Fallback: got', sigs.length, 'sigs for', poolAddress.slice(0, 12), 'fetching txs…');
    const items: HeliusTxItem[] = [];
    for (const { signature, blockTime: sigBlockTime } of sigs) {
      if (sigBlockTime != null && sigBlockTime < since15m) continue;
      try {
        const res = await fetch(rpcUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: '1',
            method: 'getTransaction',
            params: [
              signature,
              { encoding: 'base64', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
            ],
          }),
        });
        if (!res.ok) continue;
        const json = (await res.json()) as {
          result?: {
            transaction?: unknown;
            meta?: { err?: unknown; loadedAddresses?: { writable?: unknown[]; readonly?: unknown[] } } | null;
            blockTime?: number | null;
          } | null;
          error?: unknown;
        };
        const txResult = json.result;
        if (!txResult || txResult.meta?.err != null) continue;
        const bt = txResult.blockTime ?? null;
        if (bt == null || bt < since15m) continue;
        let txData: string | undefined;
        const rawTx = txResult.transaction;
        if (typeof rawTx === 'string') {
          txData = rawTx;
        } else if (Array.isArray(rawTx) && typeof rawTx[0] === 'string') {
          txData = rawTx[0];
        }
        if (!txData) {
          if (DEBUG_VOLUME && items.length === 0) console.warn('[pumpswap-volume] Fallback: getTransaction returned no base64, typeof=', typeof rawTx, Array.isArray(rawTx) ? 'arrayLen=' + (rawTx as unknown[]).length : '');
          continue;
        }
        items.push({
          blockTime: bt,
          transaction: txData,
          meta: txResult.meta ?? null,
        });
      } catch {
        continue;
      }
      await new Promise((r) => setTimeout(r, FALLBACK_TX_DELAY_MS));
    }
    if (DEBUG_VOLUME) console.warn('[pumpswap-volume] Fallback: parsed', items.length, 'txs for', poolAddress.slice(0, 12));
    return items.length > 0 ? items : null;
  } catch (e) {
    if (DEBUG_VOLUME) console.warn('[pumpswap-volume] standard RPC fallback error:', e);
    return null;
  }
}

/** Aggregate volume and counts from a list of parsed tx items (from Helius or getTransaction). */
function aggregateVolumeFromTxItems(
  items: Array<{
    blockTime: number | null;
    message: {
      accountKeys?: unknown[];
      staticAccountKeys?: unknown[];
      static_account_keys?: unknown[];
      account_keys?: unknown[];
      compiledInstructions?: unknown;
      instructions?: unknown;
      compiled_instructions?: unknown;
    };
    loadedAddresses?: { writable?: unknown[]; readonly?: unknown[] } | null;
  }>,
  since1m: number,
  since5m: number,
  since15m: number
): { totalLamports15m: number; totalLamports5m: number; totalLamports1m: number; totalBuys1m: number; totalSells1m: number } {
  let totalLamports15m = 0;
  let totalLamports5m = 0;
  let totalLamports1m = 0;
  let totalBuys1m = 0;
  let totalSells1m = 0;
  for (const item of items) {
    const blockTime = item.blockTime ?? null;
    const message = item.message;
    if (!message) continue;
    const accountKeys = getAccountKeys(message, item.loadedAddresses ?? undefined);
    const instructions = getInstructions(message);
    if (instructions.length === 0) continue;
    const { lamports, buys, sells } = sumVolumeAndCountsFromTx(
      accountKeys,
      instructions,
      PUMP_SWAP_PROGRAM_ID
    );
    if (lamports <= 0 && buys === 0 && sells === 0) continue;
    if (blockTime != null && blockTime >= since15m) totalLamports15m += lamports;
    if (blockTime != null && blockTime >= since5m) totalLamports5m += lamports;
    if (blockTime != null && blockTime >= since1m) {
      totalLamports1m += lamports;
      totalBuys1m += buys;
      totalSells1m += sells;
    }
  }
  return { totalLamports15m, totalLamports5m, totalLamports1m, totalBuys1m, totalSells1m };
}

/**
 * Fetch USD volume for the last 1m, 5m and 15m for a PumpSwap pool via Helius
 * getTransactionsForAddress (one RPC call per pool). Requires HELIUS_RPC_URL.
 */
export async function getPumpSwapVolumeUsd(
  connection: Connection,
  poolAddress: string,
  solPriceUsd: number
): Promise<PumpSwapVolumeResult> {
  const now = Math.floor(Date.now() / 1000);
  const since1m = now - ONE_MINUTE_SEC;
  const since5m = now - FIVE_MINUTES_SEC;
  const since15m = now - FIFTEEN_MINUTES_SEC;

  const heliusUrl = getHeliusRpcUrl();

  let rawTxs: HeliusTxItem[] | null = null;
  if (heliusUrl) {
    rawTxs = await fetchPoolTransactionsViaHelius(heliusUrl, poolAddress, since15m);
  }
  if (rawTxs == null || rawTxs.length === 0) {
    rawTxs = await fetchPoolTransactionsViaStandardRpc(connection, poolAddress, since15m);
  }
  const source = rawTxs != null && rawTxs.length > 0 ? (heliusUrl ? 'helius' : 'fallback') : 'none';
  if (rawTxs == null || rawTxs.length === 0) {
    if (LOG_VOLUME_SUMMARY) console.warn('[pumpswap-volume]', poolAddress.slice(0, 12), '… source=', source, 'rawTxs=0 → volume=null');
    if (DEBUG_VOLUME) console.warn('[pumpswap-volume] No data for pool', poolAddress.slice(0, 12), '…');
    return { volume1mUsd: null, volume5mUsd: null, volume15mUsd: null, buys1m: null, sells1m: null };
  }

  const afterErrFilter = rawTxs.filter((item) => item.meta?.err == null);
  const items = afterErrFilter
    .map((item) => {
      const message = getMessageFromItem(item);
      return {
        blockTime: item.blockTime ?? null,
        message,
        loadedAddresses: item.meta?.loadedAddresses ?? null,
      };
    })
    .filter((item) => item.message != null) as Array<{
      blockTime: number | null;
      message: {
        accountKeys?: unknown[];
        staticAccountKeys?: unknown[];
        static_account_keys?: unknown[];
        account_keys?: unknown[];
        compiledInstructions?: unknown;
        instructions?: unknown;
        compiled_instructions?: unknown;
      };
      loadedAddresses?: { writable?: unknown[]; readonly?: unknown[] } | null;
    }>;

  if (DEBUG_VOLUME && rawTxs.length > 0) {
    const withMessage = items.length;
    const noMessage = afterErrFilter.length - withMessage;
    if (noMessage > 0) console.warn('[pumpswap-volume] getMessageFromItem returned null for', noMessage, 'of', afterErrFilter.length, 'txs');
  }
  if (items.length === 0) {
    if (LOG_VOLUME_SUMMARY) console.warn('[pumpswap-volume]', poolAddress.slice(0, 12), '… source=', source, 'rawTxs=', rawTxs.length, 'parseable=0 → volume=null');
    return { volume1mUsd: null, volume5mUsd: null, volume15mUsd: null, buys1m: null, sells1m: null };
  }

  if (DEBUG_VOLUME && items.length > 0) {
    const first = items[0];
    const accountKeys = getAccountKeys(first.message as Parameters<typeof getAccountKeys>[0], first.loadedAddresses as Parameters<typeof getAccountKeys>[1]);
    const instructions = getInstructions(first.message as Parameters<typeof getInstructions>[0]);
    const programIdx = accountKeys.indexOf(PUMP_SWAP_PROGRAM_ID);
    console.warn(
      '[pumpswap-volume] Sample item:',
      'accountKeys=', accountKeys.length,
      'instructions=', instructions.length,
      'programIdx=', programIdx,
      'firstIxData=', instructions[0]?.data ? `${String(instructions[0].data).slice(0, 20)}…` : 'none',
    );
  }

  const agg = aggregateVolumeFromTxItems(items, since1m, since5m, since15m);

  if (LOG_VOLUME_SUMMARY) {
    const v1 = agg.totalLamports1m / LAMPORTS_PER_SOL * solPriceUsd;
    const v5 = agg.totalLamports5m / LAMPORTS_PER_SOL * solPriceUsd;
    console.warn(
      '[pumpswap-volume]',
      poolAddress.slice(0, 12), '…',
      'source=', source,
      'txs=', items.length,
      'vol1m=$' + v1.toFixed(0),
      'vol5m=$' + v5.toFixed(0),
      'buys1m=', agg.totalBuys1m,
      'sells1m=', agg.totalSells1m,
    );
  }

  if (!Number.isFinite(solPriceUsd) || solPriceUsd <= 0) {
    return { volume1mUsd: null, volume5mUsd: null, volume15mUsd: null, buys1m: null, sells1m: null };
  }
  const sol15m = agg.totalLamports15m / LAMPORTS_PER_SOL;
  const sol5m = agg.totalLamports5m / LAMPORTS_PER_SOL;
  const sol1m = agg.totalLamports1m / LAMPORTS_PER_SOL;
  return {
    volume1mUsd: sol1m * solPriceUsd,
    volume5mUsd: sol5m * solPriceUsd,
    volume15mUsd: sol15m * solPriceUsd,
    buys1m: agg.totalBuys1m,
    sells1m: agg.totalSells1m,
  };
}
