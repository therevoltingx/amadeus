/**
 * Fetch PumpSwap pool state from chain: reserves, price, liquidity, and mint supply/authorities.
 * Used by the chain-snapshots worker to build snapshots without DexScreener.
 *
 * LP lock: Pump.fun-originated pools have the token's BondingCurve account marked complete;
 * at migration LP tokens are burnt, so liquidity is effectively locked. We detect by
 * fetching the BondingCurve PDA for the pool's base_mint and checking complete === true.
 * Fallback: pool.creator === Pump.fun migration account. Otherwise lpLocked null.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { PUMP_FUN_PROGRAM_ID, WSOL_MINT } from '../pumpswap-rpc-parser.js';

/** Pump.fun migration account (fallback for LP lock when BondingCurve not available). */
export const PUMP_FUN_MIGRATION_ACCOUNT = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';

/** BondingCurve layout: 8-byte discriminator + 5× u64 (40) + complete (bool) at offset 48. */
const BONDING_CURVE_COMPLETE_OFFSET = 8 + 40;

const LAMPORTS_PER_SOL = 1e9;
/** Pump token decimals (base token). */
const BASE_DECIMALS = 6;

function toNumber(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof (v as { toNumber?: () => number }).toNumber === 'function') {
    return (v as { toNumber: () => number }).toNumber();
  }
  if (typeof (v as { toString: () => string }).toString === 'function') {
    const n = parseInt((v as { toString: () => string }).toString(), 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}
export interface PumpSwapPoolSnapshot {
  priceUsd: number;
  liquidityUsd: number;
  marketCap: number | null;
  hasMintAuthority: number;
  hasFreezeAuthority: number;
  /** Base token mint actually used (from pool state when available); use for snapshot token_mint. */
  tokenMint: string;
  /** 1 if Pump.fun BondingCurve is complete (migrated, LP burnt) or pool creator is migration account; null otherwise. */
  lpLocked: number | null;
  /** Mint supply (raw) when available; pass to getTokenHolderInfoFromChain to avoid duplicate getAccountInfo. */
  supplyRaw?: bigint;
}

/** Parse SPL mint account: supply (u64 at 36), decimals (u8 at 44), mint_authority (option at 0), freeze_authority (option at 46). */
export function parseMintAccount(data: Uint8Array): {
  supplyRaw: bigint;
  decimals: number;
  hasMintAuthority: boolean;
  hasFreezeAuthority: boolean;
} {
  if (data.length < 46 + 4) {
    return {
      supplyRaw: 0n,
      decimals: BASE_DECIMALS,
      hasMintAuthority: true,
      hasFreezeAuthority: true,
    };
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const hasMintAuthority = view.getUint32(0, true) !== 0;
  const supplyLo = view.getUint32(36, true);
  const supplyHi = view.getUint32(40, true);
  const supplyRaw = (BigInt(supplyHi) << 32n) | BigInt(supplyLo);
  const decimals = data[44] ?? BASE_DECIMALS;
  const hasFreezeAuthority = view.getUint32(46, true) !== 0;
  return { supplyRaw, decimals, hasMintAuthority, hasFreezeAuthority };
}

/**
 * Fetch decimals for an SPL mint address. Returns null if account not found or invalid.
 */
export async function getMintDecimals(
  connection: Connection,
  mintAddress: string
): Promise<number | null> {
  try {
    const pubkey = new PublicKey(mintAddress);
    const info = await connection.getAccountInfo(pubkey, {
      dataSlice: { offset: 0, length: 50 },
      commitment: 'confirmed',
    });
    if (!info?.data) return null;
    const data = info.data instanceof Buffer ? info.data : new Uint8Array(info.data as ArrayLike<number>);
    return parseMintAccount(data).decimals;
  } catch {
    return null;
  }
}

/**
 * Fetch price, liquidity, market cap, and mint authorities for a PumpSwap pool.
 * Uses @pump-fun/pump-swap-sdk for pool state and RPC for mint account.
 */
function toBase58Key(key: unknown): string | null {
  if (key == null) return null;
  if (typeof key === 'string') return key;
  if (typeof (key as { toBase58?: () => string }).toBase58 === 'function') {
    return (key as { toBase58: () => string }).toBase58();
  }
  if (typeof (key as { toString?: () => string }).toString === 'function') {
    return (key as { toString: () => string }).toString();
  }
  return null;
}

/**
 * Returns true if the Pump.fun BondingCurve for this mint exists and is complete (token migrated).
 * PDA seeds: "bonding-curve" + mint. Complete = true means LP was migrated and burnt.
 */
async function isPumpFunBondingCurveComplete(
  connection: Connection,
  baseMint: PublicKey
): Promise<boolean> {
  const [bondingCurvePda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bonding-curve'), baseMint.toBuffer()],
    new PublicKey(PUMP_FUN_PROGRAM_ID)
  );
  const account = await connection.getAccountInfo(bondingCurvePda);
  if (!account?.data || account.data.length < BONDING_CURVE_COMPLETE_OFFSET + 1) return false;
  return account.data[BONDING_CURVE_COMPLETE_OFFSET] === 1;
}

/**
 * Fetch price, liquidity, market cap, and mint authorities for a PumpSwap pool.
 * Uses @pump-fun/pump-swap-sdk for pool state and RPC for mint account.
 * @param preFetchedMintAccount - Optional pre-fetched mint account data (e.g. from batch getMultipleAccountsInfo) for baseMint; used when effectiveBaseMint === baseMint to avoid an extra getAccountInfo.
 * @param cachedMint - Optional mint data from pairs table (decimals, supplyRaw, hasMintAuthority, hasFreezeAuthority); when present and effectiveBaseMint === baseMint, skips mint RPC entirely.
 */
export async function getPumpSwapPoolSnapshot(
  connection: Connection,
  poolAddress: string,
  baseMint: string,
  getSolPriceUsd: () => Promise<number>,
  options?: {
    solPriceUsd?: number;
    preFetchedMintAccount?: Buffer | Uint8Array | null;
    cachedMint?: {
      decimals: number;
      supplyRaw: bigint;
      hasMintAuthority: boolean;
      hasFreezeAuthority: boolean;
    } | null;
  }
): Promise<PumpSwapPoolSnapshot | null> {
  const solPriceUsdFromOptions = options?.solPriceUsd;
  const preFetchedMint = options?.preFetchedMintAccount;
  const cachedMint = options?.cachedMint;
  try {
    const poolKey = new PublicKey(poolAddress);
    const { OnlinePumpAmmSdk } = await import('@pump-fun/pump-swap-sdk');
    const sdk = new OnlinePumpAmmSdk(connection);
    const swapState = await sdk.swapSolanaState(poolKey, poolKey);
    const state = swapState as unknown as Record<string, unknown>;

    const rawBase = state.poolBaseAmount;
    const rawQuote = state.poolQuoteAmount;
    const poolBaseAmount = toNumber(rawBase);
    const poolQuoteAmount = toNumber(rawQuote);

    if (!Number.isFinite(poolBaseAmount) || !Number.isFinite(poolQuoteAmount) || poolBaseAmount <= 0) {
      return null;
    }

    // Prefer base mint from pool state so we use the pool's actual token (decimals + supply), not the pairs table which can be wrong.
    // If the SDK returns quote (WSOL) as baseMint for some pools, use quoteMint as the base (roles may be swapped in the SDK).
    // Never use the pool's LP mint as base: its supply is pool shares, not token supply, and would produce a bogus huge market cap.
    const poolObj = state.pool as Record<string, unknown> | undefined;
    const poolCreator = toBase58Key(poolObj?.creator);
    const poolBaseMint = toBase58Key(poolObj?.baseMint);
    const poolQuoteMint = toBase58Key(poolObj?.quoteMint);
    const poolLpMint = toBase58Key(poolObj?.lpMint);
    const isLpMint = (m: string | null) => m != null && m === poolLpMint;
    let effectiveBaseMint = poolBaseMint && poolBaseMint !== WSOL_MINT && !isLpMint(poolBaseMint) ? poolBaseMint : null;
    if (!effectiveBaseMint && poolQuoteMint && poolQuoteMint !== WSOL_MINT && !isLpMint(poolQuoteMint)) effectiveBaseMint = poolQuoteMint;
    if (!effectiveBaseMint) effectiveBaseMint = baseMint;
    const usedQuoteMintAsBase = effectiveBaseMint === poolQuoteMint;
    const mintPubkey = new PublicKey(effectiveBaseMint);
    const bondingCurveComplete = await isPumpFunBondingCurveComplete(connection, mintPubkey);
    const lpLocked =
      bondingCurveComplete || poolCreator === PUMP_FUN_MIGRATION_ACCOUNT ? 1 : null;

    // Use cached mint from pairs table when it's for the effective base mint; else pre-fetched buffer; else fetch.
    let mintAccount: { data: Buffer | Uint8Array } | null = null;
    let mint: { supplyRaw: bigint; decimals: number; hasMintAuthority: boolean; hasFreezeAuthority: boolean };
    if (cachedMint && effectiveBaseMint === baseMint) {
      mint = {
        decimals: cachedMint.decimals,
        supplyRaw: cachedMint.supplyRaw,
        hasMintAuthority: cachedMint.hasMintAuthority,
        hasFreezeAuthority: cachedMint.hasFreezeAuthority,
      };
    } else if (preFetchedMint && effectiveBaseMint === baseMint) {
      mintAccount = { data: preFetchedMint instanceof Buffer ? preFetchedMint : Buffer.from(preFetchedMint) };
      mint = parseMintAccount(mintAccount.data);
    } else {
      const MINT_DATA_SLICE_LENGTH = 50; // supply (36-44), decimals (44), mint_authority (0), freeze_authority (46)
      const info = await connection.getAccountInfo(mintPubkey, {
        dataSlice: { offset: 0, length: MINT_DATA_SLICE_LENGTH },
        commitment: 'confirmed',
      });
      if (info?.data) {
        const d = info.data;
        mintAccount = {
          data: Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayLike<number>),
        };
        mint = parseMintAccount(mintAccount.data);
      } else {
        mint = { supplyRaw: 0n, decimals: BASE_DECIMALS, hasMintAuthority: true, hasFreezeAuthority: true };
      }
    }
    const baseDecimals = mint.decimals;

    const solPriceUsd =
      solPriceUsdFromOptions != null && Number.isFinite(solPriceUsdFromOptions) && solPriceUsdFromOptions > 0
        ? solPriceUsdFromOptions
        : await getSolPriceUsd();
    if (!Number.isFinite(solPriceUsd) || solPriceUsd <= 0) return null;

    // When SDK had SOL as "base" and we used quoteMint as effective base, swap reserves: token amount = SDK quote, SOL amount = SDK base.
    const tokenReserveRaw = usedQuoteMintAsBase ? poolQuoteAmount : poolBaseAmount;
    const solReserveRaw = usedQuoteMintAsBase ? poolBaseAmount : poolQuoteAmount;
    const baseHuman = tokenReserveRaw / Math.pow(10, baseDecimals);
    const quoteLooksLikeSol =
      solReserveRaw > 0 &&
      (solReserveRaw < 1 || (solReserveRaw < 1e7 && !Number.isInteger(solReserveRaw)));
    const quoteHuman = quoteLooksLikeSol
      ? solReserveRaw
      : solReserveRaw / LAMPORTS_PER_SOL;
    const priceSol = baseHuman > 0 ? quoteHuman / baseHuman : 0;
    const priceUsd = priceSol * solPriceUsd;

    // Liquidity: base value + quote value in USD.
    const baseValueUsd = baseHuman * priceUsd;
    const quoteValueUsd = quoteHuman * solPriceUsd;
    const liquidityUsd = baseValueUsd + quoteValueUsd;

    let marketCap: number | null = null;
    let hasMintAuthority = 1;
    let hasFreezeAuthority = 1;
    if (mint) {
      const decimals = mint.decimals;
      // Keep supply in BigInt until human conversion to avoid Number precision loss (u64 can exceed 2^53).
      const divisor = 10n ** BigInt(decimals);
      const supplyHuman = divisor > 0n ? Number(mint.supplyRaw / divisor) : 0;
      marketCap = supplyHuman * priceUsd;
      hasMintAuthority = mint.hasMintAuthority ? 1 : 0;
      hasFreezeAuthority = mint.hasFreezeAuthority ? 1 : 0;
    }

    return {
      priceUsd,
      liquidityUsd,
      marketCap,
      hasMintAuthority,
      hasFreezeAuthority,
      tokenMint: effectiveBaseMint,
      lpLocked,
      /** Mint supply (raw) when available; pass to getTokenHolderInfoFromChain to avoid duplicate getAccountInfo. */
      supplyRaw: mint.supplyRaw,
    };
  } catch {
    return null;
  }
}
