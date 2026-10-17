/**
 * Parse PumpSwap program transactions to extract new pool creation (create_pool) and swap instructions.
 * Used by pumpswap-pairs-worker to ingest pairs and record swap events from RPC.
 */
import { createHash } from 'node:crypto';
import bs58 from 'bs58';

/** Instruction discriminator for create_pool (8 bytes, hex). */
const CREATE_POOL_DISCRIMINATOR = new Uint8Array(Buffer.from('e992d18ecf6840bc', 'hex'));

/**
 * Decode instruction `data` from RPC. Solana `getTransaction` uses **base58** for compiled ix data;
 * that string often matches a permissive base64 regex — decoding as base64 first yields wrong bytes
 * (e.g. discriminator 00dbf5deb523931a instead of create_pool e992d18ecf6840bc).
 */
function decodeInstructionData(data: unknown): Uint8Array | null {
  if (data == null) return null;
  if (typeof data !== 'string') return null;
  try {
    return new Uint8Array(bs58.decode(data));
  } catch {
    /* fall through */
  }
  try {
    if (/^[A-Za-z0-9+/]+=*$/.test(data)) {
      return new Uint8Array(Buffer.from(data, 'base64'));
    }
  } catch {
    return null;
  }
  return null;
}

/** True if instruction data starts with the create_pool discriminator. */
function isCreatePoolInstructionData(data: unknown): boolean {
  const buf = decodeInstructionData(data);
  if (!buf || buf.length < 8) return false;
  return CREATE_POOL_DISCRIMINATOR.every((b, i) => buf[i] === b);
}

/** When true, log why create_pool was not found (for debugging). */
const DEBUG_PARSER = process.env.DEBUG_PUMPSWAP_PARSER === '1' || process.env.DEBUG_PUMPSWAP_PARSER === 'true';
export const PUMP_SWAP_PROGRAM_ID = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

/** Pump.fun program ID (migrate instruction; same tx may create PumpSwap pool). */
export const PUMP_FUN_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

/** WSOL mint (common quote for PumpSwap). */
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export interface ParsedPumpSwapPoolCreation {
  /** Pool address (PDA of the AMM pool). */
  poolAddress: string;
  /** Base token mint (the memecoin). */
  baseMint: string;
  /** Quote token mint (usually WSOL). */
  quoteMint: string;
  /** Creator pubkey (IDL createPool: account index 2; legacy layout index 1 when only 4 fixed accounts). */
  creator: string | null;
  /** True if the same transaction also invokes Pump.fun (migration from bonding curve). */
  migratedFromPumpFun: boolean;
}

/** Parsed swap instruction: buy (SOL in → token out) or sell (token in → SOL out). */
export interface ParsedPumpSwapSwap {
  poolAddress: string;
  side: 'buy' | 'sell';
  /** Base token amount (raw, for sell; may be null for buy). */
  tokenAmount: number | null;
  /** SOL amount in lamports (for buy; may be null for sell). */
  solLamports: number | null;
}

function readU64LE(data: Uint8Array, offset: number): number {
  if (offset + 8 > data.length) return 0;
  const view = new DataView(data.buffer, data.byteOffset + offset, 8);
  const lo = view.getUint32(0, true);
  const hi = view.getUint32(4, true);
  const n = hi * 0x1_0000_0000 + lo;
  return Number.isFinite(n) ? n : 0;
}

/** Anchor discriminator: first 8 bytes of sha256("global:name"). */
function anchorDiscriminator(name: string): Uint8Array {
  const hash = createHash('sha256').update(`global:${name}`).digest();
  return hash.subarray(0, 8);
}

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

function isSwapBuyInstruction(data: Uint8Array): boolean {
  return BUY_DISCRIMINATORS.some((d) => discriminatorMatches(data, d));
}

function isSwapSellInstruction(data: Uint8Array): boolean {
  return discriminatorMatches(data, SELL_DISCRIMINATOR);
}

/** Cap single instruction amount to avoid treating token amounts as lamports. */
const MAX_LAMPORTS_PER_INSTRUCTION = 1e12;
/** When using sideFromLog fallback, allow larger values (e.g. token amounts with many decimals). */
const MAX_AMOUNT_SIDE_FROM_LOG = 1e20;

/** RPC returns message as plain object; keys may be base58 strings or PublicKey-like or { pubkey: string }. */
function toBase58(key: unknown): string {
  if (typeof key === 'string') return key;
  if (key != null && typeof key === 'object') {
    const o = key as Record<string, unknown>;
    if (typeof o.pubkey === 'string') return o.pubkey;
    if (typeof o.toBase58 === 'function') return (o.toBase58 as () => string)();
    if (typeof o.toString === 'function') return (o.toString as () => string)();
  }
  return '';
}

/**
 * Resolve full account keys for a transaction message (legacy or v0).
 * Order: staticAccountKeys, then writable from loadedAddresses, then readonly.
 * Handles camelCase and snake_case (static_account_keys, account_keys, accounts).
 */
function getAccountKeysB58(
  message: {
    staticAccountKeys?: unknown[];
    accountKeys?: unknown[];
    static_account_keys?: unknown[];
    account_keys?: unknown[];
    accounts?: unknown[];
    compiledInstructions?: Array<{ programIdIndex: number; accountKeyIndexes: number[] }>;
    instructions?: Array<{ programIdIndex: number; accounts: number[] }>;
  },
  loadedAddresses?: { writable?: unknown[]; readonly?: unknown[] } | null
): string[] {
  const rawKeys =
    message.staticAccountKeys ??
    message.accountKeys ??
    message.static_account_keys ??
    message.account_keys ??
    message.accounts ??
    [];
  const staticKeys = (Array.isArray(rawKeys) ? rawKeys : []).map(toBase58);
  if (!loadedAddresses || (loadedAddresses.writable?.length === 0 && loadedAddresses.readonly?.length === 0)) {
    return staticKeys;
  }
  const writable = (loadedAddresses.writable ?? []).map(toBase58);
  const readonly = (loadedAddresses.readonly ?? []).map(toBase58);
  return [...staticKeys, ...writable, ...readonly];
}

/** Resolve account pubkey from compiled index, string, or object. */
function resolveAccountRef(
  rawAccounts: unknown[],
  index: number,
  accountKeys: string[]
): string {
  const k = rawAccounts[index];
  if (typeof k === 'string') return k;
  if (typeof k === 'number') return accountKeys[k] ?? '';
  return toBase58(k);
}

/**
 * createPool account order per pump AMM IDL: pool, globalConfig, creator, baseMint, quoteMint, ...
 * Older txs may use [pool, creator, baseMint, quoteMint] without globalConfig (4 accounts minimum).
 */
function resolveCreatePoolMintAccounts(
  rawAccounts: unknown[],
  accountKeys: string[]
): { poolAddress: string; creator: string | null; baseMint: string; quoteMint: string } | null {
  const n = rawAccounts.length;
  if (n >= 5) {
    const poolAddress = resolveAccountRef(rawAccounts, 0, accountKeys);
    const creator = resolveAccountRef(rawAccounts, 2, accountKeys) || null;
    const baseMint = resolveAccountRef(rawAccounts, 3, accountKeys);
    const quoteMint = resolveAccountRef(rawAccounts, 4, accountKeys);
    if (!poolAddress || !baseMint || !quoteMint) return null;
    return { poolAddress, creator, baseMint, quoteMint };
  }
  if (n >= 4) {
    const poolAddress = resolveAccountRef(rawAccounts, 0, accountKeys);
    const creator = resolveAccountRef(rawAccounts, 1, accountKeys) || null;
    const baseMint = resolveAccountRef(rawAccounts, 2, accountKeys);
    const quoteMint = resolveAccountRef(rawAccounts, 3, accountKeys);
    if (!poolAddress || !baseMint || !quoteMint) return null;
    return { poolAddress, creator, baseMint, quoteMint };
  }
  return null;
}

/**
 * Extract first PumpSwap create_pool from a transaction response.
 * Matches Anchor discriminator for createPool; account layout follows IDL (see resolveCreatePoolMintAccounts).
 * Returns null if no PumpSwap create_pool found or accounts are missing.
 * Handles: programIdIndex/program_id_index/programId (number), accountKeyIndexes/account_key_indexes/accounts,
 * Helius jsonParsed shape with program (string) + programId (index), and meta.innerInstructions (CPI).
 */
export function parsePumpSwapPoolCreationFromTx(
  message: {
    staticAccountKeys?: unknown[];
    accountKeys?: unknown[];
    static_account_keys?: unknown[];
    account_keys?: unknown[];
    accounts?: unknown[];
    compiledInstructions?: Array<{
      programIdIndex?: number;
      program_id_index?: number;
      programId?: number;
      program?: string;
      accountKeyIndexes?: number[];
      account_key_indexes?: number[];
      accounts?: number[];
      parsed?: unknown;
    }>;
    instructions?: Array<{
      programIdIndex?: number;
      program_id_index?: number;
      programId?: number;
      program?: string;
      accountKeyIndexes?: number[];
      account_key_indexes?: number[];
      accounts?: number[];
      parsed?: unknown;
    }>;
    compiled_instructions?: Array<{
      programIdIndex?: number;
      program_id_index?: number;
      programId?: number;
      program?: string;
      accountKeyIndexes?: number[];
      account_key_indexes?: number[];
      accounts?: number[];
      parsed?: unknown;
    }>;
  },
  loadedAddresses: { writable?: unknown[]; readonly?: unknown[] } | null | undefined,
  options: { checkPumpFunInSameTx: boolean },
  meta?: {
    innerInstructions?: Array<{ instructions?: unknown[] }>;
    inner_instructions?: Array<{ instructions?: unknown[] }>;
  } | null
): ParsedPumpSwapPoolCreation | null {
  const accountKeys = getAccountKeysB58((message as unknown) as Parameters<typeof getAccountKeysB58>[0], loadedAddresses);
  const topLevel =
    message.compiledInstructions ?? message.instructions ?? message.compiled_instructions ?? [];
  const inner = (meta?.innerInstructions ?? meta?.inner_instructions ?? []) as Array<{ instructions?: unknown[] }>;
  const innerFlat = inner.flatMap((block) => block.instructions ?? []);
  const instructions = [...(Array.isArray(topLevel) ? topLevel : []), ...innerFlat] as Array<Record<string, unknown>>;
  if (instructions.length === 0 || accountKeys.length === 0) {
    if (DEBUG_PARSER) {
      console.warn('[pumpswap-rpc-parser] No create_pool: accountKeys=', accountKeys.length, 'instructions=', instructions.length, 'topLevelKeys=', Object.keys(message).filter((k) => k.toLowerCase().includes('instruction') || k.toLowerCase().includes('account')));
    }
    return null;
  }

  let pumpswapPool: ParsedPumpSwapPoolCreation | null = null;
  let hasPumpFunInstruction = false;
  let lastPumpSwapSkipReason: string | null = null;

  for (const ix of instructions) {
    const programIdIndex =
      ix.programIdIndex ??
      ix.program_id_index ??
      (typeof ix.programId === 'number' ? ix.programId : undefined);
    const parsed = ix.parsed as Record<string, unknown> | undefined;
    const rawAccounts =
      ix.accountKeyIndexes ??
      ix.account_key_indexes ??
      ix.accounts ??
      (Array.isArray(parsed?.accounts) ? (parsed.accounts as unknown[]) : undefined);
    const programKey =
      typeof ix.program === 'string'
        ? ix.program
        : typeof (ix as Record<string, unknown>).programId === 'string'
          ? (ix as Record<string, unknown>).programId as string
          : programIdIndex != null
            ? accountKeys[programIdIndex as number]
            : '';
    if (!programKey) continue;

    if (programKey === PUMP_FUN_PROGRAM_ID) hasPumpFunInstruction = true;

    if (programKey !== PUMP_SWAP_PROGRAM_ID) continue;

    const ixData = (ix as Record<string, unknown>).data ?? parsed?.data;
    const buf = decodeInstructionData(ixData);
    const hasDiscriminatorBytes = buf != null && buf.length >= 8;
    const isCreate = isCreatePoolInstructionData(ixData);

    if (hasDiscriminatorBytes && !isCreate) {
      const hexPrefix = Buffer.from(buf.subarray(0, 8)).toString('hex');
      lastPumpSwapSkipReason = `discriminator_mismatch (expected create_pool e992d18ecf6840bc, got ${hexPrefix})`;
      if (DEBUG_PARSER) {
        console.warn('[pumpswap-rpc-parser] PumpSwap ix data mismatch. Expected: e992d18ecf6840bc, got:', hexPrefix);
      }
      // Do not treat buy/sell/other PumpSwap ixs as pool creation (they also have many accounts).
      continue;
    }

    if (!Array.isArray(rawAccounts)) {
      lastPumpSwapSkipReason = 'accounts_not_array';
      continue;
    }

    const resolved = resolveCreatePoolMintAccounts(rawAccounts as unknown[], accountKeys);
    if (resolved == null) {
      lastPumpSwapSkipReason = `accounts_length=${(rawAccounts as unknown[]).length}`;
      continue;
    }

    const { poolAddress, creator, baseMint, quoteMint } = resolved;
    if (!poolAddress || !baseMint || !quoteMint) {
      lastPumpSwapSkipReason = `missing_pool_base_quote pool=${!!poolAddress} base=${!!baseMint} quote=${!!quoteMint}`;
      continue;
    }

    pumpswapPool = {
      poolAddress,
      baseMint,
      quoteMint,
      creator,
      migratedFromPumpFun: options.checkPumpFunInSameTx && hasPumpFunInstruction,
    };
    break;
  }

  if (pumpswapPool == null && DEBUG_PARSER && lastPumpSwapSkipReason != null) {
    console.warn('[pumpswap-rpc-parser] PumpSwap ix seen but skipped:', lastPumpSwapSkipReason);
  }

  if (pumpswapPool && options.checkPumpFunInSameTx) {
    pumpswapPool.migratedFromPumpFun = hasPumpFunInstruction;
  }

  return pumpswapPool;
}

/**
 * Extract all PumpSwap buy/sell swap instructions from a transaction.
 * Instruction data: 8-byte discriminator + u64 amount (quote/SOL for buy, base/token for sell).
 * Pool is first account. Handles top-level and inner instructions (CPI).
 * When options.sideFromLog is set (e.g. from logsSubscribe "Instruction: Buy/Sell"), any PumpSwap
 * instruction with pool + valid amount is treated as that side even if the discriminator is unknown.
 */
export function parsePumpSwapSwapInstructionsFromTx(
  message: Parameters<typeof getAccountKeysB58>[0] & { compiled_instructions?: unknown[] },
  loadedAddresses: Parameters<typeof getAccountKeysB58>[1],
  meta?: { innerInstructions?: Array<{ instructions?: unknown[] }>; inner_instructions?: Array<{ instructions?: unknown[] }> } | null,
  options?: { sideFromLog?: 'buy' | 'sell' }
): ParsedPumpSwapSwap[] {
  const accountKeys = getAccountKeysB58((message as unknown) as Parameters<typeof getAccountKeysB58>[0], loadedAddresses);
  const topLevel =
    (message as Record<string, unknown>).compiledInstructions ??
    (message as Record<string, unknown>).compiled_instructions ??
    (message as Record<string, unknown>).instructions ??
    [];
  const inner = (meta?.innerInstructions ?? meta?.inner_instructions ?? []) as Array<{ instructions?: unknown[] }>;
  const innerFlat = inner.flatMap((block) => block.instructions ?? []);
  const instructions: Array<Record<string, unknown>> = [
    ...(Array.isArray(topLevel) ? (topLevel as Record<string, unknown>[]) : []),
    ...(innerFlat as Record<string, unknown>[]),
  ];
  const programIdIndex = accountKeys.indexOf(PUMP_SWAP_PROGRAM_ID);
  if (programIdIndex < 0) return [];

  const result: ParsedPumpSwapSwap[] = [];
  for (const ix of instructions) {
    const ixProgramIdIndex =
      ix.programIdIndex ?? ix.program_id_index ?? (typeof ix.programId === 'number' ? ix.programId : undefined);
    const programKey =
      typeof ix.program === 'string'
        ? ix.program
        : typeof (ix as Record<string, unknown>).programId === 'string'
          ? ((ix as Record<string, unknown>).programId as string)
          : ixProgramIdIndex != null
            ? accountKeys[ixProgramIdIndex as number]
            : '';
    if (programKey !== PUMP_SWAP_PROGRAM_ID) continue;

    const rawData = ix.data ?? (ix.parsed as Record<string, unknown>)?.data;
    const data = decodeInstructionData(rawData);
    if (data == null) continue;
    if (data.length < 16) continue;

    const rawAccounts =
      ix.accountKeyIndexes ?? ix.account_key_indexes ?? ix.accounts ?? (ix.parsed as Record<string, unknown>)?.accounts;
    const accounts = Array.isArray(rawAccounts) ? rawAccounts : undefined;
    const poolIndex = accounts?.[0];
    const poolAddress =
      poolIndex == null
        ? ''
        : typeof poolIndex === 'string'
          ? poolIndex
          : typeof poolIndex === 'number'
            ? accountKeys[poolIndex] ?? ''
            : toBase58(poolIndex);
    if (!poolAddress) continue;

    const amount = readU64LE(data, 8);
    const maxAmount = options?.sideFromLog ? MAX_AMOUNT_SIDE_FROM_LOG : MAX_LAMPORTS_PER_INSTRUCTION;
    if (amount <= 0 || amount > maxAmount) continue;

    if (isSwapBuyInstruction(data)) {
      result.push({ poolAddress, side: 'buy', tokenAmount: null, solLamports: amount });
    } else if (isSwapSellInstruction(data)) {
      result.push({ poolAddress, side: 'sell', tokenAmount: amount, solLamports: null });
    } else if (options?.sideFromLog === 'buy') {
      result.push({ poolAddress, side: 'buy', tokenAmount: null, solLamports: amount });
    } else if (options?.sideFromLog === 'sell') {
      result.push({ poolAddress, side: 'sell', tokenAmount: amount, solLamports: null });
    }
  }
  return result;
}
