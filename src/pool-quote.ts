/**
 * Quote sell output from AMM pool state (read-only, no transaction).
 * Used by the exit worker to compute paper-trade actual_usd_sold from current pool state.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { WSOL_MINT } from './pumpswap-rpc-parser.js';
import { isBase58, sanitizeToBase58 } from './validators/address.js';

const POOL_BASE_MINT_OFFSET = 43;
const POOL_QUOTE_MINT_OFFSET = 75;
const POOL_BASE_VAULT_OFFSET = 139;
const POOL_QUOTE_VAULT_OFFSET = 171;

/** Conservative total fee estimate (LP + protocol + creator) in bps; matches pumpswap-swap. */
const ESTIMATED_TOTAL_FEE_BPS = 150n;

const WSOL_PK = new PublicKey(WSOL_MINT);

export interface PaperExitQuoteResult {
  /** SOL that would be received from selling the given token amount (after fees). */
  solReceived: number;
  /** SOL price USD at quote time (caller may pass or fetch). */
  solPriceUsd: number;
  /** actualUsdSold = solReceived * solPriceUsd */
  actualUsdSold: number;
  /** Pool liquidity in USD (base value + quote value) at quote time. Used to detect rug / total loss. */
  liquidityUsd: number;
}

export interface PaperExitQuoteParams {
  connection: Connection;
  pairAddress: string;
  tokenMint: string;
  /** Token amount to sell in human/ui units (e.g. 50_000 tokens). */
  tokenAmountToSell: number;
  entryDex: string | null;
  /** Optional: SOL price USD; if not provided, caller must set actualUsdSold from solReceived * price. */
  getSolPriceUsd?: () => Promise<number>;
}

/**
 * Quote how much SOL would be received from selling the given token amount on the pool.
 * Supports PumpSwap only. Returns null if pool not found, invalid reserves, or unsupported DEX.
 */
export async function getPaperExitQuote(
  params: PaperExitQuoteParams
): Promise<PaperExitQuoteResult | null> {
  const { connection, pairAddress, tokenMint, tokenAmountToSell, entryDex, getSolPriceUsd } = params;

  const dex = (entryDex ?? '').toLowerCase().trim();
  if (dex !== 'pumpswap') return null;

  if (!Number.isFinite(tokenAmountToSell) || tokenAmountToSell <= 0) return null;

  let pairClean = (pairAddress ?? '').trim();
  if (!isBase58(pairClean)) {
    pairClean = sanitizeToBase58(pairClean);
    if (pairClean.length < 32) return null;
  }
  if (!pairClean) return null;

  const tokenMintClean = (tokenMint ?? '').trim();
  if (!tokenMintClean || tokenMintClean.length < 32) return null;

  try {
    const poolKey = new PublicKey(pairClean);
    const poolAccountInfo = await connection.getAccountInfo(poolKey, { commitment: 'confirmed' });
    if (!poolAccountInfo?.data || poolAccountInfo.data.length < POOL_QUOTE_VAULT_OFFSET + 32) {
      return null;
    }

    const poolData = poolAccountInfo.data;
    const baseMint = new PublicKey(poolData.subarray(POOL_BASE_MINT_OFFSET, POOL_BASE_MINT_OFFSET + 32));
    const quoteMint = new PublicKey(poolData.subarray(POOL_QUOTE_MINT_OFFSET, POOL_QUOTE_MINT_OFFSET + 32));
    const poolBaseVault = new PublicKey(poolData.subarray(POOL_BASE_VAULT_OFFSET, POOL_BASE_VAULT_OFFSET + 32));
    const poolQuoteVault = new PublicKey(poolData.subarray(POOL_QUOTE_VAULT_OFFSET, POOL_QUOTE_VAULT_OFFSET + 32));

    const solSide = baseMint.equals(WSOL_PK) ? 'base' : quoteMint.equals(WSOL_PK) ? 'quote' : null;
    if (!solSide) return null;

    const tokenMintPk = new PublicKey(tokenMintClean);
    const baseIsToken = baseMint.equals(tokenMintPk);
    const quoteIsToken = quoteMint.equals(tokenMintPk);
    if (!baseIsToken && !quoteIsToken) return null;

    const [baseBal, quoteBal] = await Promise.all([
      connection.getTokenAccountBalance(poolBaseVault, 'confirmed'),
      connection.getTokenAccountBalance(poolQuoteVault, 'confirmed'),
    ]);

    const baseReserve = BigInt(baseBal.value.amount);
    const quoteReserve = BigInt(quoteBal.value.amount);
    if (baseReserve <= 0n || quoteReserve <= 0n) return null;

    const tokenReserve = solSide === 'quote' ? baseReserve : quoteReserve;
    const solReserve = solSide === 'quote' ? quoteReserve : baseReserve;

    const tokenDecimals = solSide === 'base' ? quoteBal.value.decimals : baseBal.value.decimals;
    if (typeof tokenDecimals !== 'number' || tokenDecimals < 0 || tokenDecimals > 18) return null;

    const tokenAmountRaw = BigInt(Math.floor(tokenAmountToSell * Math.pow(10, tokenDecimals)));
    if (tokenAmountRaw <= 0n) return null;

    const grossSolOut = (solReserve * tokenAmountRaw) / (tokenReserve + tokenAmountRaw);
    const netSolOut = (grossSolOut * (10000n - ESTIMATED_TOTAL_FEE_BPS)) / 10000n;
    const solReceived = Number(netSolOut) / 1e9;
    if (!Number.isFinite(solReceived) || solReceived <= 0) return null;

    let solPriceUsd = 0;
    if (getSolPriceUsd) {
      try {
        solPriceUsd = await getSolPriceUsd();
      } catch {
        return null;
      }
    }
    if (!Number.isFinite(solPriceUsd) || solPriceUsd <= 0) {
      return { solReceived, solPriceUsd: 0, actualUsdSold: 0, liquidityUsd: 0 };
    }

    const actualUsdSold = solReceived * solPriceUsd;

    const baseHuman = Number(tokenReserve) / Math.pow(10, tokenDecimals);
    const quoteHuman = Number(solReserve) / 1e9;
    const priceSol = baseHuman > 0 ? quoteHuman / baseHuman : 0;
    const priceUsd = priceSol * solPriceUsd;
    const baseValueUsd = baseHuman * priceUsd;
    const quoteValueUsd = quoteHuman * solPriceUsd;
    const liquidityUsd = baseValueUsd + quoteValueUsd;

    return { solReceived, solPriceUsd, actualUsdSold, liquidityUsd };
  } catch {
    return null;
  }
}
