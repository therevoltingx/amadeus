/**
 * Raydium AMM swap using @raydium-io/raydium-sdk-v2.
 * See: https://docs.raydium.io/raydium/for-developers/sdk
 */
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import BN from 'bn.js';
import type { ExecutionOrder } from './executors/types.js';

const LAMPORTS_PER_SOL = 1e9;
const DEFAULT_BASE_DECIMALS = 6;

export interface BuildRaydiumSwapOptions {
  connection: Connection;
  signer: Keypair;
  mint: PublicKey;
  order: ExecutionOrder;
  slippageBps: number;
  /** Used to convert order.position_size_usd to lamports for buy. */
  getSolPriceUsd: () => Promise<number>;
}

/**
 * If outputMint is Token-2022, replace the Create ATA instruction for the user's account
 * with a Token-2022 ATA instruction (Raydium SDK uses legacy Token program).
 */
async function patchToken2022CreateAtaIfNeeded(
  connection: Connection,
  tx: Transaction,
  outputMint: PublicKey,
  owner: PublicKey
): Promise<Transaction> {
  const mintInfo = await connection.getAccountInfo(outputMint);
  const isToken2022 = Boolean(mintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID));
  if (!isToken2022) return tx;

  const instructions = tx.instructions;
  const atpProgramId = ASSOCIATED_TOKEN_PROGRAM_ID;
  for (let i = 0; i < instructions.length; i++) {
    const ix = instructions[i];
    if (!ix.programId.equals(atpProgramId) || ix.keys.length < 6) continue;
    const mintKey = ix.keys[3];
    if (!mintKey.pubkey.equals(outputMint)) continue;
    const ownerKey = ix.keys[2].pubkey;
    if (!ownerKey.equals(owner)) continue;
    const payer = ix.keys[0].pubkey;
    const associatedToken = getAssociatedTokenAddressSync(
      outputMint,
      ownerKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      atpProgramId
    );
    const newIx = createAssociatedTokenAccountInstruction(
      payer,
      associatedToken,
      ownerKey,
      outputMint,
      TOKEN_2022_PROGRAM_ID,
      atpProgramId
    );
    instructions[i] = newIx;
  }
  return tx;
}

/**
 * Build a Raydium AMM swap transaction (base token vs SOL).
 * Fetches pool by base mint + WSOL, then swap with slippage.
 */
export async function buildRaydiumSwap(
  options: BuildRaydiumSwapOptions
): Promise<Transaction> {
  const { connection, signer, mint: baseMint, order, slippageBps, getSolPriceUsd } = options;

  const { Raydium, TxVersion, WSOLMint } = await import(
    '@raydium-io/raydium-sdk-v2'
  );

  const raydium = await Raydium.load({
    connection,
    owner: signer.publicKey,
  });

  const wsol = WSOLMint.toBase58();
  const pools = await raydium.api.fetchPoolByMints({
    mint1: baseMint.toBase58(),
    mint2: wsol,
  });
  const poolList = Array.isArray(pools) ? pools : (pools as { data?: unknown[] })?.data ?? [];
  const poolInfo = Array.isArray(poolList) ? poolList[0] : (poolList as unknown[])?.[0] as { id?: string; mintA?: { decimals?: number } } | undefined;
  if (!poolInfo || !poolInfo.id) {
    throw new Error(
      `SOLANA_SWAP_RAYDIUM_NO_POOL: no Raydium pool for mint ${baseMint.toBase58()} / SOL`
    );
  }

  const { poolInfo: poolInfoWithReserves, poolKeys } = await raydium.liquidity.getPoolInfoFromRpc({
    poolId: poolInfo.id,
  });

  const isBuy = order.signal?.toUpperCase() === 'BUY' || order.signal?.toUpperCase() !== 'SELL';
  const inputMint = isBuy ? wsol : baseMint.toBase58();
  const baseDecimals = poolInfo.mintA?.decimals ?? DEFAULT_BASE_DECIMALS;
  const slippageDecimal = slippageBps / 10_000;

  let amountIn: BN;
  let amountOut: BN;

  if (isBuy) {
    const solPriceUsd = await getSolPriceUsd();
    const solAmount = order.position_size_usd / solPriceUsd;
    amountIn = new BN(Math.floor(solAmount * LAMPORTS_PER_SOL));
    const out = raydium.liquidity.computeAmountOut({
      poolInfo: poolInfoWithReserves,
      amountIn,
      mintIn: inputMint,
      mintOut: baseMint.toBase58(),
      slippage: slippageDecimal,
    });
    amountOut = out.minAmountOut;
  } else {
    let balanceRaw = 0;
    for (const tokenProgramId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      try {
        const ata = getAssociatedTokenAddressSync(
          baseMint,
          signer.publicKey,
          false,
          tokenProgramId
        );
        const account = await getAccount(connection, ata);
        balanceRaw = Number(account.amount);
        break;
      } catch {
        // ATA not found or wrong program
      }
    }
    if (balanceRaw <= 0) {
      throw new Error('SOLANA_SWAP_SELL_INSUFFICIENT_TOKEN_BALANCE');
    }
    // Sell full balance on exit to avoid leaving dust
    const baseAmountRaw = balanceRaw;
    amountIn = new BN(baseAmountRaw);
    const out = raydium.liquidity.computeAmountOut({
      poolInfo: poolInfoWithReserves,
      amountIn,
      mintIn: baseMint.toBase58(),
      mintOut: wsol,
      slippage: slippageDecimal,
    });
    amountOut = out.minAmountOut;
  }

  const result = await raydium.liquidity.swap({
    poolInfo: poolInfoWithReserves,
    poolKeys,
    amountIn,
    amountOut,
    inputMint,
    fixedSide: isBuy ? 'in' : 'out',
    txVersion: TxVersion.LEGACY,
    config: {
      associatedOnly: true,
      inputUseSolBalance: isBuy,
      outputUseSolBalance: !isBuy,
    },
    feePayer: signer.publicKey,
  });

  let tx = (result as { transaction: Transaction }).transaction;
  if (!tx) {
    throw new Error('SOLANA_SWAP_RAYDIUM_NO_TX');
  }

  if (isBuy) {
    tx = await patchToken2022CreateAtaIfNeeded(connection, tx, baseMint, signer.publicKey);
  }
  return tx;
}
