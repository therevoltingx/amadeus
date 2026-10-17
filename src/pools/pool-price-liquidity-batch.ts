/**
 * Batched fetch of PumpSwap pool price and liquidity from RPC.
 * Used by the exit worker: **pool + vault** accounts via RPC; **token decimals** come from `pairs` in the DB (no mint RPC).
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { db } from '../db.js';
import { WSOL_MINT } from '../pumpswap-rpc-parser.js';
import { isBase58, sanitizeToBase58 } from '../validators/address.js';

const POOL_BASE_MINT_OFFSET = 43;
const POOL_QUOTE_MINT_OFFSET = 75;
const POOL_BASE_VAULT_OFFSET = 139;
const POOL_QUOTE_VAULT_OFFSET = 171;
const LAMPORTS_PER_SOL = 1e9;
/** SPL token account: amount (u64 LE) at offset 64. */
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;

const WSOL_PK = new PublicKey(WSOL_MINT);

type PairDecimalsRow = {
  base_decimals: number | null;
  quote_decimals: number | null;
  base_token_address: string;
  quote_token_address: string;
};

const getPairDecimalsStmt = db.prepare(`
  SELECT base_decimals, quote_decimals, base_token_address, quote_token_address
  FROM pairs WHERE pair_address = $pairAddress
`);

function tokenDecimalsFromPairRow(row: PairDecimalsRow, tokenMintB58: string): number | null {
  if (tokenMintB58 === row.base_token_address) return row.base_decimals;
  if (tokenMintB58 === row.quote_token_address) return row.quote_decimals;
  return null;
}

export interface PoolPriceLiquidity {
  priceUsd: number;
  liquidityUsd: number;
}

export interface PoolPriceLiquidityBatchInput {
  pairAddress: string;
  tokenMint: string;
  entryDex: string | null;
}

/**
 * Fetch current price and liquidity for multiple PumpSwap pools in batched RPC calls.
 * Returns a Map keyed by pair_address; value is null if pool is not PumpSwap, not found, invalid, or pair row lacks decimals for the token mint.
 */
export async function getPoolPriceLiquidityBatch(
  connection: Connection,
  pairs: PoolPriceLiquidityBatchInput[],
  getSolPriceUsd: () => Promise<number>
): Promise<Map<string, PoolPriceLiquidity | null>> {
  const result = new Map<string, PoolPriceLiquidity | null>();

  const pumpswapPairs = pairs.filter((p) => (p.entryDex ?? '').toLowerCase().trim() === 'pumpswap');
  if (pumpswapPairs.length === 0) {
    return result;
  }

  const pairAddresses = pumpswapPairs.map((p) => {
    const a = (p.pairAddress ?? '').trim();
    return isBase58(a) ? a : sanitizeToBase58(a);
  }).filter((a) => a.length >= 32);

  const uniquePairAddresses = [...new Set(pairAddresses)];
  if (uniquePairAddresses.length === 0) return result;

  const pairDecimalsByAddress = new Map<string, PairDecimalsRow>();
  for (const addr of uniquePairAddresses) {
    const row = getPairDecimalsStmt.get({ pairAddress: addr }) as PairDecimalsRow | undefined;
    if (row) pairDecimalsByAddress.set(addr, row);
  }

  let solPriceUsd: number;
  try {
    solPriceUsd = await getSolPriceUsd();
  } catch {
    return result;
  }
  if (!Number.isFinite(solPriceUsd) || solPriceUsd <= 0) return result;

  const poolKeys = uniquePairAddresses.map((a) => new PublicKey(a));
  const poolAccounts = await connection.getMultipleAccountsInfo(poolKeys, { commitment: 'confirmed' });
  if (!poolAccounts || poolAccounts.length !== poolKeys.length) {
    return result;
  }

  type VaultInfo = { pairAddress: string; baseVault: PublicKey; quoteVault: PublicKey; baseMint: PublicKey; quoteMint: PublicKey };
  const vaultsByPair: VaultInfo[] = [];

  for (let i = 0; i < poolAccounts.length; i++) {
    const info = poolAccounts[i];
    const pairAddress = uniquePairAddresses[i];
    if (!info?.data || info.data.length < POOL_QUOTE_VAULT_OFFSET + 32) continue;

    const data = info.data;
    const baseMint = new PublicKey(data.subarray(POOL_BASE_MINT_OFFSET, POOL_BASE_MINT_OFFSET + 32));
    const quoteMint = new PublicKey(data.subarray(POOL_QUOTE_MINT_OFFSET, POOL_QUOTE_MINT_OFFSET + 32));
    const baseVault = new PublicKey(data.subarray(POOL_BASE_VAULT_OFFSET, POOL_BASE_VAULT_OFFSET + 32));
    const quoteVault = new PublicKey(data.subarray(POOL_QUOTE_VAULT_OFFSET, POOL_QUOTE_VAULT_OFFSET + 32));

    const solSide = baseMint.equals(WSOL_PK) ? 'base' : quoteMint.equals(WSOL_PK) ? 'quote' : null;
    if (!solSide) continue;

    vaultsByPair.push({ pairAddress, baseVault, quoteVault, baseMint, quoteMint });
  }

  if (vaultsByPair.length === 0) return result;

  const allVaults = vaultsByPair.flatMap((v) => [v.baseVault, v.quoteVault]);
  const vaultAccounts = await connection.getMultipleAccountsInfo(allVaults, { commitment: 'confirmed' });
  if (!vaultAccounts || vaultAccounts.length !== allVaults.length) return result;

  function readU64LE(buf: Buffer | Uint8Array, offset: number): bigint {
    if (offset + 8 > buf.length) return 0n;
    const view = new DataView(buf.buffer, buf.byteOffset + offset, 8);
    const lo = view.getUint32(0, true);
    const hi = view.getUint32(4, true);
    return (BigInt(hi) << 32n) | BigInt(lo);
  }

  let vaultIdx = 0;
  for (const v of vaultsByPair) {
    const pairRow = pairDecimalsByAddress.get(v.pairAddress);
    if (!pairRow) {
      result.set(v.pairAddress, null);
      vaultIdx += 2;
      continue;
    }

    const baseData = vaultAccounts[vaultIdx]?.data;
    const quoteData = vaultAccounts[vaultIdx + 1]?.data;
    vaultIdx += 2;

    if (!baseData || baseData.length < TOKEN_ACCOUNT_AMOUNT_OFFSET + 8 ||
        !quoteData || quoteData.length < TOKEN_ACCOUNT_AMOUNT_OFFSET + 8) {
      result.set(v.pairAddress, null);
      continue;
    }

    const baseAmount = readU64LE(baseData, TOKEN_ACCOUNT_AMOUNT_OFFSET);
    const quoteAmount = readU64LE(quoteData, TOKEN_ACCOUNT_AMOUNT_OFFSET);
    if (baseAmount <= 0n || quoteAmount <= 0n) {
      result.set(v.pairAddress, null);
      continue;
    }

    const solSide = v.baseMint.equals(WSOL_PK) ? 'base' : 'quote';
    const tokenMintPk = solSide === 'base' ? v.quoteMint : v.baseMint;
    const tokenMintB58 = tokenMintPk.toBase58();
    const tokenDecimals = tokenDecimalsFromPairRow(pairRow, tokenMintB58);
    if (tokenDecimals == null) {
      result.set(v.pairAddress, null);
      continue;
    }

    const tokenReserve = solSide === 'quote' ? baseAmount : quoteAmount;
    const solReserve = solSide === 'quote' ? quoteAmount : baseAmount;

    const baseHuman = Number(tokenReserve) / Math.pow(10, tokenDecimals);
    const quoteHuman = Number(solReserve) / LAMPORTS_PER_SOL;
    const priceSol = baseHuman > 0 ? quoteHuman / baseHuman : 0;
    const priceUsd = priceSol * solPriceUsd;
    const baseValueUsd = baseHuman * priceUsd;
    const quoteValueUsd = quoteHuman * solPriceUsd;
    const liquidityUsd = baseValueUsd + quoteValueUsd;

    if (!Number.isFinite(priceUsd) || !Number.isFinite(liquidityUsd) || priceUsd <= 0) {
      result.set(v.pairAddress, null);
      continue;
    }

    result.set(v.pairAddress, { priceUsd, liquidityUsd });
  }

  for (const p of pumpswapPairs) {
    const key = isBase58(p.pairAddress) ? p.pairAddress : sanitizeToBase58(p.pairAddress);
    if (!result.has(key)) {
      result.set(key, null);
    }
  }

  return result;
}
