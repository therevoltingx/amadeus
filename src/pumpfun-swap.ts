/**
 * Pump.fun / PumpSwap swap using pumpfun-pumpswap-sdk (Erbsensuppee).
 * Auto-switches to PumpSwap when bonding curve is migrated.
 * Sell amount is capped to wallet token balance to avoid "insufficient funds".
 * https://github.com/Erbsensuppee/pumpfun-pumpswap-sdk
 */
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { getAccount, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { ExecutionOrder } from './executors/types.js';

const LAMPORTS_PER_SOL = 1e9;
const PUMP_TOKEN_DECIMALS = 6;
/** Minimum slippage (decimal). SDK default 0.03; use at least 5% for bonding curve. */
const MIN_SLIPPAGE = 0.05;

export interface BuildPumpFunSwapOptions {
  connection: Connection;
  signer: Keypair;
  mint: PublicKey;
  order: ExecutionOrder;
  slippageBps: number;
  /** Used to convert order.position_size_usd to lamports for buy. */
  getSolPriceUsd: () => Promise<number>;
}

type BuyFn = (
  connection: Connection,
  mint: PublicKey,
  userKeypair: Keypair,
  lamportsAmount: bigint,
  slippage: number
) => Promise<{ instructions: import('@solana/web3.js').TransactionInstruction[] }>;

type SellFn = (
  connection: Connection,
  mint: PublicKey,
  userPubkey: PublicKey,
  tokenLamports: bigint,
  closeTokenAta: boolean,
  slippage: number
) => Promise<{ instructions: import('@solana/web3.js').TransactionInstruction[] }>;

async function loadBuildPumpFunBuy(): Promise<BuyFn> {
  const mod = await import('pumpfun-pumpswap-sdk/src/buy.js');
  const fn = (mod as { buildPumpFunBuy?: BuyFn; default?: { buildPumpFunBuy?: BuyFn } }).buildPumpFunBuy
    ?? (mod as { default?: { buildPumpFunBuy?: BuyFn } }).default?.buildPumpFunBuy;
  if (typeof fn !== 'function') throw new Error('pumpfun-pumpswap-sdk: buildPumpFunBuy not found');
  return fn;
}

async function loadBuildPumpFunSell(): Promise<SellFn> {
  const mod = await import('pumpfun-pumpswap-sdk/src/sell.js');
  const fn = (mod as { buildPumpFunSell?: SellFn; default?: { buildPumpFunSell?: SellFn } }).buildPumpFunSell
    ?? (mod as { default?: { buildPumpFunSell?: SellFn } }).default?.buildPumpFunSell;
  if (typeof fn !== 'function') throw new Error('pumpfun-pumpswap-sdk: buildPumpFunSell not found');
  return fn;
}

/**
 * Build a Pump.fun (or PumpSwap) buy or sell transaction using pumpfun-pumpswap-sdk.
 * Buy: SOL lamports from position_size_usd; sell: token lamports from position_size_usd / entry_price.
 */
export async function buildPumpFunSwap(
  options: BuildPumpFunSwapOptions
): Promise<Transaction> {
  const { connection, signer, mint, order, slippageBps, getSolPriceUsd } = options;
  const slippageDecimal = Math.max(slippageBps / 10_000, MIN_SLIPPAGE);
  const isBuy = order.signal?.toUpperCase() === 'BUY' || order.signal?.toUpperCase() !== 'SELL';

  if (isBuy) {
    const solPriceUsd = await getSolPriceUsd();
    const lamports = Math.floor((order.position_size_usd / solPriceUsd) * LAMPORTS_PER_SOL);
    if (lamports <= 0) throw new Error('SOLANA_SWAP_BUY_AMOUNT_TOO_SMALL');
    const buildPumpFunBuy = await loadBuildPumpFunBuy();
    const { instructions } = await buildPumpFunBuy(
      connection,
      mint,
      signer,
      BigInt(lamports),
      slippageDecimal
    );
    return new Transaction().add(...instructions);
  }

  let balanceRaw = 0;
  for (const tokenProgramId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const ata = getAssociatedTokenAddressSync(mint, signer.publicKey, false, tokenProgramId);
      const account = await getAccount(connection, ata);
      balanceRaw = Number(account.amount);
      break;
    } catch {
      // ATA not found or wrong program, try next
    }
  }
  if (balanceRaw <= 0) {
    throw new Error('SOLANA_SWAP_SELL_INSUFFICIENT_TOKEN_BALANCE');
  }
  // Sell full balance on exit to avoid leaving dust
  const tokenAmountRaw = balanceRaw;

  const buildPumpFunSell = await loadBuildPumpFunSell();
  const { instructions } = await buildPumpFunSell(
    connection,
    mint,
    signer.publicKey,
    BigInt(tokenAmountRaw),
    false,
    slippageDecimal
  );
  return new Transaction().add(...instructions);
}
