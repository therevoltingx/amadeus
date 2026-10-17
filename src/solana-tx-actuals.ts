/**
 * Resolve actual USD amounts from Solana transaction balance changes.
 * Used to populate actual_usd_sold (and optionally actual_usd_bought) from chain instead of notional.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { getSolPriceUsd } from './sol-price.js';

/** RPC parsed tx meta shape (preBalances/postBalances align with account keys). loadedAddresses is used for versioned tx. */
interface ParsedTxMeta {
  err: unknown;
  fee: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances?: TokenBalanceMeta[];
  postTokenBalances?: TokenBalanceMeta[];
  loadedAddresses?: { writable?: unknown[]; readonly?: unknown[] };
}

interface TokenBalanceMeta {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: {
    /** Raw token amount in smallest units (chain source of truth). */
    amount?: string;
    decimals: number;
    uiAmountString?: string;
    uiAmount?: number | null;
  };
}

/** Parse token amount from RPC. Prefers raw chain amount (amount / 10^decimals), then uiAmountString, then uiAmount. */
function parseTokenAmount(uiTokenAmount: TokenBalanceMeta['uiTokenAmount'] | undefined): number {
  if (!uiTokenAmount) return 0;
  const raw = uiTokenAmount.amount;
  const decimals = uiTokenAmount.decimals;
  if (typeof raw === 'string' && raw !== '' && typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0) {
    const n = Number(raw) / Math.pow(10, decimals);
    if (Number.isFinite(n)) return n;
  }
  const str = uiTokenAmount.uiAmountString;
  if (str != null && str !== '') {
    const n = parseFloat(str);
    if (Number.isFinite(n)) return n;
  }
  const num = uiTokenAmount.uiAmount;
  if (num != null && Number.isFinite(num)) return num;
  return 0;
}

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Derive the swap SOL amount from the pool's WSOL vault token balance change.
 * This is the most accurate approach because it reads the pool side of the swap
 * directly, excluding tx fees, account rent, and protocol fees that complicate
 * the signer's SOL delta.
 *
 * Returns the pool vault's absolute WSOL delta in lamports (always positive),
 * or null when WSOL token balance data is unavailable.
 */
function getPoolWsolSwapLamports(
  meta: ParsedTxMeta,
  signerB58: string,
  side: 'buy' | 'sell'
): number | null {
  const pre = meta.preTokenBalances ?? [];
  const post = meta.postTokenBalances ?? [];

  const wsolIndices = new Set<number>();
  for (const b of [...pre, ...post]) {
    if (b.mint === WSOL_MINT) wsolIndices.add(b.accountIndex);
  }
  if (wsolIndices.size === 0) return null;

  let bestAbsDelta = 0;
  let bestSignedDelta = 0;

  for (const idx of wsolIndices) {
    const preEntry = pre.find((b) => b.accountIndex === idx && b.mint === WSOL_MINT);
    const postEntry = post.find((b) => b.accountIndex === idx && b.mint === WSOL_MINT);
    const owner = preEntry?.owner || postEntry?.owner || '';
    if (owner === signerB58) continue;

    const preRaw = Number(preEntry?.uiTokenAmount?.amount ?? '0');
    const postRaw = Number(postEntry?.uiTokenAmount?.amount ?? '0');
    const delta = postRaw - preRaw;

    if (Math.abs(delta) > bestAbsDelta) {
      bestAbsDelta = Math.abs(delta);
      bestSignedDelta = delta;
    }
  }

  if (bestAbsDelta <= 0) return null;

  if (side === 'buy' && bestSignedDelta > 0) return bestSignedDelta;
  if (side === 'sell' && bestSignedDelta < 0) return -bestSignedDelta;

  return null;
}

const PARSED_TX_INITIAL_DELAY_MS = 2000;
const PARSED_TX_RETRY_DELAY_MS = 2000;
const PARSED_TX_MAX_ATTEMPTS = 5;

async function getParsedTransactionWithRetry(
  connection: Connection,
  txSignature: string
): Promise<Awaited<ReturnType<Connection['getParsedTransaction']>>> {
  await new Promise((r) => setTimeout(r, PARSED_TX_INITIAL_DELAY_MS));
  const options = { commitment: 'confirmed' as const, maxSupportedTransactionVersion: 0 };
  for (let attempt = 0; attempt < PARSED_TX_MAX_ATTEMPTS; attempt++) {
    const parsed = await connection.getParsedTransaction(txSignature, options);
    if (parsed != null) return parsed;
    if (attempt < PARSED_TX_MAX_ATTEMPTS - 1) {
      await new Promise((r) => setTimeout(r, PARSED_TX_RETRY_DELAY_MS));
    }
  }
  return null;
}

function normalizeAccountKey(k: unknown): string {
  if (typeof k === 'string') return k;
  if (k != null && typeof k === 'object') {
    const o = k as Record<string, unknown>;
    if (typeof o.pubkey === 'string') return o.pubkey;
    if (o.pubkey != null && typeof o.pubkey === 'object' && typeof (o.pubkey as Record<string, unknown>).toBase58 === 'function') {
      return ((o.pubkey as Record<string, unknown>).toBase58 as () => string)();
    }
    if (typeof o.toBase58 === 'function') return (o.toBase58 as () => string)();
    if (typeof o.toString === 'function' && o.toString !== Object.prototype.toString) {
      const s = o.toString() as string;
      if (s.length >= 32 && s.length <= 44 && /^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) return s;
    }
  }
  return '';
}

/**
 * Get account keys in order from a parsed transaction (indices must match preBalances/preTokenBalances).
 * For versioned tx the RPC puts loadedAddresses in meta, not message; we must merge for correct indices.
 */
export function getAccountKeysFromParsedTransaction(
  message: unknown,
  meta: ParsedTxMeta | null | undefined,
  expectedLength?: number
): string[] {
  if (!message || typeof message !== 'object') return [];
  const m = message as Record<string, unknown>;
  const loadedFromMeta = meta?.loadedAddresses as { writable?: unknown[]; readonly?: unknown[] } | undefined;
  const staticKeys = m.staticAccountKeys;
  if (Array.isArray(staticKeys) && (loadedFromMeta?.writable != null || loadedFromMeta?.readonly != null)) {
    const staticB58 = staticKeys.map(normalizeAccountKey);
    const writable = Array.isArray(loadedFromMeta.writable) ? loadedFromMeta.writable.map(normalizeAccountKey) : [];
    const readonly = Array.isArray(loadedFromMeta.readonly) ? loadedFromMeta.readonly.map(normalizeAccountKey) : [];
    const versioned = [...staticB58, ...writable, ...readonly];
    if (versioned.length > 0 && (expectedLength == null || versioned.length === expectedLength)) return versioned;
  }
  const keys = m.accountKeys;
  if (Array.isArray(keys)) {
    const out = keys.map(normalizeAccountKey);
    if (out.length > 0 && (expectedLength == null || out.length === expectedLength)) return out;
  }
  if (Array.isArray(staticKeys)) {
    const loaded = loadedFromMeta ?? (m.loadedAddresses as { writable?: unknown[]; readonly?: unknown[] } | undefined);
    const staticB58 = staticKeys.map(normalizeAccountKey);
    const writable = Array.isArray(loaded?.writable) ? loaded.writable.map(normalizeAccountKey) : [];
    const readonly = Array.isArray(loaded?.readonly) ? loaded.readonly.map(normalizeAccountKey) : [];
    return [...staticB58, ...writable, ...readonly];
  }
  return [];
}

interface SolBalanceDelta {
  /** Signer SOL balance change in lamports (post - pre). Negative for buys, positive for sells. Includes tx fee. */
  deltaLamports: number;
  /** Transaction fee in lamports (base + priority). */
  feeLamports: number;
}

/**
 * Fetch a confirmed transaction and compute the signer's SOL balance change (post - pre)
 * plus the transaction fee so callers can separate swap amount from fee.
 */
export async function getSolBalanceDeltaFromTx(
  connection: Connection,
  txSignature: string,
  signerPubkey: PublicKey
): Promise<SolBalanceDelta | null> {
  try {
    const parsed = await getParsedTransactionWithRetry(connection, txSignature);
    if (!parsed?.meta || parsed.meta.err) return null;
    const meta = parsed.meta as ParsedTxMeta;
    const preBalances = meta.preBalances;
    const postBalances = meta.postBalances;
    if (!Array.isArray(preBalances) || !Array.isArray(postBalances) || preBalances.length !== postBalances.length)
      return null;

    const message = (parsed.transaction as { message?: unknown })?.message;
    const accountKeys = getAccountKeysFromParsedTransaction(message, meta, preBalances.length);
    if (accountKeys.length === 0 || accountKeys.length !== preBalances.length) return null;

    const signerB58 = signerPubkey.toBase58();
    const signerIndex = accountKeys.findIndex((k) => k === signerB58);
    if (signerIndex < 0) return null;

    const delta = postBalances[signerIndex] - preBalances[signerIndex];
    if (!Number.isFinite(delta)) return null;
    const feeLamports = typeof meta.fee === 'number' && Number.isFinite(meta.fee) ? meta.fee : 0;
    return { deltaLamports: delta, feeLamports };
  } catch {
    return null;
  }
}

export interface ExitTxActuals {
  actualUsdReceived: number;
  solReceived: number;
  solPriceUsd: number;
  /** Exit transaction fee in lamports (base + priority). */
  feeLamports: number;
  /** When tokenMint provided: tokens sold (balance decrease) from chain. */
  tokensSold?: number;
  /** When tokenMint provided: actual exit price USD per token = actualUsdReceived / tokensSold (matches Solscan). */
  effectiveExitPriceUsd?: number;
}

/**
 * Resolve actual USD received from an exit (sell) transaction.
 * Fetches the parsed tx ONCE and extracts SOL delta, fee, token balances in a single pass.
 * Accounts for rent returned from closed token accounts so the SOL amount matches the
 * pure swap output shown by Solscan.
 */
export async function getActualUsdReceivedFromExitTx(
  connection: Connection,
  txSignature: string,
  signerPubkey: PublicKey,
  tokenMint?: string | null
): Promise<ExitTxActuals | null> {
  try {
    const parsed = await getParsedTransactionWithRetry(connection, txSignature);
    if (!parsed?.meta || parsed.meta.err) {
      console.warn(JSON.stringify({ event: 'exit_tx_parse_failed', tx: txSignature, reason: parsed == null ? 'tx_not_found' : 'tx_error' }));
      return null;
    }
    const meta = parsed.meta as ParsedTxMeta;
    const preBalances = meta.preBalances;
    const postBalances = meta.postBalances;
    if (!Array.isArray(preBalances) || !Array.isArray(postBalances) || preBalances.length !== postBalances.length) {
      console.warn(JSON.stringify({ event: 'exit_tx_parse_failed', tx: txSignature, reason: 'balance_array_mismatch' }));
      return null;
    }
    const message = (parsed.transaction as { message?: unknown })?.message;
    const accountKeys = getAccountKeysFromParsedTransaction(message, meta, preBalances.length);
    if (accountKeys.length === 0 || accountKeys.length !== preBalances.length) {
      console.warn(JSON.stringify({ event: 'exit_tx_parse_failed', tx: txSignature, reason: 'account_keys_mismatch', keysLen: accountKeys.length, balancesLen: preBalances.length }));
      return null;
    }
    const signerB58 = signerPubkey.toBase58();
    const signerIndex = accountKeys.findIndex((k) => k === signerB58);
    if (signerIndex < 0) {
      console.warn(JSON.stringify({ event: 'exit_tx_parse_failed', tx: txSignature, reason: 'signer_not_found' }));
      return null;
    }

    const delta = postBalances[signerIndex] - preBalances[signerIndex];
    if (!Number.isFinite(delta) || delta <= 0) {
      console.warn(JSON.stringify({ event: 'exit_tx_parse_failed', tx: txSignature, reason: 'non_positive_delta', delta }));
      return null;
    }
    const feeLamports = typeof meta.fee === 'number' && Number.isFinite(meta.fee) ? meta.fee : 0;

    let tokensSold: number | undefined;
    let effectiveExitPriceUsd: number | undefined;

    if (tokenMint?.trim()) {
      const mintPk = new PublicKey(tokenMint);
      const ataStandard = getAssociatedTokenAddressSync(mintPk, signerPubkey, false, TOKEN_PROGRAM_ID);
      const ata2022 = getAssociatedTokenAddressSync(mintPk, signerPubkey, false, TOKEN_2022_PROGRAM_ID);
      let accountIndex = accountKeys.findIndex((k) => k === ataStandard.toBase58());
      if (accountIndex < 0) accountIndex = accountKeys.findIndex((k) => k === ata2022.toBase58());
      if (accountIndex >= 0) {
        const preList = meta.preTokenBalances ?? [];
        const postList = meta.postTokenBalances ?? [];
        const preEntry = preList.find((b) => b.accountIndex === accountIndex && b.mint === tokenMint);
        const postEntry = postList.find((b) => b.accountIndex === accountIndex && b.mint === tokenMint);
        const preAmount = parseTokenAmount(preEntry?.uiTokenAmount);
        const postAmount = parseTokenAmount(postEntry?.uiTokenAmount);
        const sold = preAmount - postAmount;
        if (Number.isFinite(sold) && sold > 0) {
          tokensSold = sold;
        }
      }
    }

    const poolWsol = getPoolWsolSwapLamports(meta, signerB58, 'sell');
    let swapLamports: number;
    if (poolWsol != null && poolWsol > 0) {
      swapLamports = poolWsol;
    } else {
      const grossLamports = delta + feeLamports;
      let totalRentReturnedLamports = 0;
      for (let i = 0; i < preBalances.length; i++) {
        if (i === signerIndex) continue;
        if (postBalances[i] === 0 && preBalances[i] > 0) {
          totalRentReturnedLamports += preBalances[i];
        }
      }
      swapLamports = grossLamports - totalRentReturnedLamports;
    }
    const solReceived = swapLamports / 1e9;
    if (!Number.isFinite(solReceived) || solReceived <= 0) return null;

    const solPrice = await getSolPriceUsd(true);
    if (!Number.isFinite(solPrice) || solPrice <= 0) return null;
    const actualUsdReceived = solReceived * solPrice;
    if (!Number.isFinite(actualUsdReceived)) return null;

    if (tokensSold != null && tokensSold > 0) {
      effectiveExitPriceUsd = actualUsdReceived / tokensSold;
    }

    return {
      actualUsdReceived,
      solReceived,
      solPriceUsd: solPrice,
      feeLamports,
      ...(tokensSold != null && { tokensSold }),
      ...(effectiveExitPriceUsd != null && Number.isFinite(effectiveExitPriceUsd) && { effectiveExitPriceUsd }),
    };
  } catch (e) {
    console.warn(JSON.stringify({ event: 'exit_tx_parse_exception', tx: txSignature, error: e instanceof Error ? e.message : String(e) }));
    return null;
  }
}

export interface EntryTxActuals {
  actualUsdSpent: number;
  tokensReceived: number;
  effectivePriceUsd: number;
  solSpent: number;
  solPriceUsd: number;
}

/**
 * Resolve actual entry (buy) from chain: SOL spent and tokens received.
 * Fetches the parsed tx ONCE and extracts everything in a single pass.
 * Accounts for rent paid to create new token accounts so the SOL amount matches the
 * pure swap input shown by Solscan.
 */
export async function getEntryTxActuals(
  connection: Connection,
  txSignature: string,
  signerPubkey: PublicKey,
  tokenMint: string
): Promise<EntryTxActuals | null> {
  try {
    const parsed = await getParsedTransactionWithRetry(connection, txSignature);
    if (!parsed?.meta || parsed.meta.err) {
      console.warn(JSON.stringify({ event: 'entry_tx_parse_failed', tx: txSignature, reason: parsed == null ? 'tx_not_found' : 'tx_error' }));
      return null;
    }
    const meta = parsed.meta as ParsedTxMeta;
    const preBalances = meta.preBalances;
    const postBalances = meta.postBalances;
    if (!Array.isArray(preBalances) || !Array.isArray(postBalances) || preBalances.length !== postBalances.length) {
      console.warn(JSON.stringify({ event: 'entry_tx_parse_failed', tx: txSignature, reason: 'balance_array_mismatch' }));
      return null;
    }
    const message = (parsed.transaction as { message?: unknown })?.message;
    const accountKeys = getAccountKeysFromParsedTransaction(message, meta, preBalances.length);
    if (accountKeys.length === 0 || accountKeys.length !== preBalances.length) {
      console.warn(JSON.stringify({ event: 'entry_tx_parse_failed', tx: txSignature, reason: 'account_keys_mismatch' }));
      return null;
    }
    const signerB58 = signerPubkey.toBase58();
    const signerIndex = accountKeys.findIndex((k) => k === signerB58);
    if (signerIndex < 0) {
      console.warn(JSON.stringify({ event: 'entry_tx_parse_failed', tx: txSignature, reason: 'signer_not_found' }));
      return null;
    }

    const delta = postBalances[signerIndex] - preBalances[signerIndex];
    if (!Number.isFinite(delta) || delta >= 0) {
      console.warn(JSON.stringify({ event: 'entry_tx_parse_failed', tx: txSignature, reason: 'non_negative_delta', delta }));
      return null;
    }
    const feeLamports = typeof meta.fee === 'number' && Number.isFinite(meta.fee) ? meta.fee : 0;

    const mintPk = new PublicKey(tokenMint);
    const ataStandard = getAssociatedTokenAddressSync(mintPk, signerPubkey, false, TOKEN_PROGRAM_ID);
    const ata2022 = getAssociatedTokenAddressSync(mintPk, signerPubkey, false, TOKEN_2022_PROGRAM_ID);
    let accountIndex = accountKeys.findIndex((k) => k === ataStandard.toBase58());
    if (accountIndex < 0) accountIndex = accountKeys.findIndex((k) => k === ata2022.toBase58());
    if (accountIndex < 0) {
      console.warn(JSON.stringify({ event: 'entry_tx_parse_failed', tx: txSignature, reason: 'ata_not_found' }));
      return null;
    }

    const poolWsol = getPoolWsolSwapLamports(meta, signerB58, 'buy');
    let swapLamports: number;
    if (poolWsol != null && poolWsol > 0) {
      swapLamports = poolWsol;
    } else {
      const rawSwapLamports = -delta - feeLamports;
      let totalRentPaidLamports = 0;
      for (let i = 0; i < preBalances.length; i++) {
        if (i === signerIndex) continue;
        if (preBalances[i] === 0 && postBalances[i] > 0) {
          totalRentPaidLamports += postBalances[i];
        }
      }
      swapLamports = rawSwapLamports - totalRentPaidLamports;
    }
    if (swapLamports <= 0) return null;
    const solSpent = swapLamports / 1e9;
    if (!Number.isFinite(solSpent) || solSpent <= 0) return null;

    const preList = meta.preTokenBalances ?? [];
    const postList = meta.postTokenBalances ?? [];
    const preEntry = preList.find((b) => b.accountIndex === accountIndex && b.mint === tokenMint);
    const postEntry = postList.find((b) => b.accountIndex === accountIndex && b.mint === tokenMint);
    const preAmount = parseTokenAmount(preEntry?.uiTokenAmount);
    const postAmount = parseTokenAmount(postEntry?.uiTokenAmount);
    const tokensReceived = postAmount - preAmount;
    if (!Number.isFinite(tokensReceived) || tokensReceived <= 0) {
      console.warn(JSON.stringify({ event: 'entry_tx_parse_failed', tx: txSignature, reason: 'no_token_increase', preAmount, postAmount }));
      return null;
    }

    const solPrice = await getSolPriceUsd(true);
    if (!Number.isFinite(solPrice) || solPrice <= 0) return null;
    const actualUsdSpent = solSpent * solPrice;
    if (!Number.isFinite(actualUsdSpent)) return null;
    const effectivePriceUsd = actualUsdSpent / tokensReceived;
    if (!Number.isFinite(effectivePriceUsd) || effectivePriceUsd <= 0) return null;

    return {
      actualUsdSpent,
      tokensReceived,
      effectivePriceUsd,
      solSpent,
      solPriceUsd: solPrice,
    };
  } catch (e) {
    console.warn(JSON.stringify({ event: 'entry_tx_parse_exception', tx: txSignature, error: e instanceof Error ? e.message : String(e) }));
    return null;
  }
}
