/**
 * Build Solana swap transaction for live execution.
 * Supports Pump.fun (bonding curve), PumpSwap (AMM), and Raydium (AMM).
 * Pump.fun uses pumpfun-swap.ts (Erbsensuppee SDK); PumpSwap uses pumpswap-swap.ts (manual instruction builder); Raydium uses raydium-swap.ts.
 */
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { isBase58, sanitizeToBase58 } from './validators/address.js';
import { getSolPriceUsd } from './sol-price.js';
import { buildPumpFunSwap } from './pumpfun-swap.js';
import { buildPumpSwapSwap } from './pumpswap-swap.js';
import { buildRaydiumSwap } from './raydium-swap.js';
import type { AccountForExecutor } from './executors/types.js';
import type { ExecutionOrder } from './executors/types.js';

export interface BuildSwapOptions {
  account: AccountForExecutor;
  order: ExecutionOrder;
  signer: Keypair;
  slippageBps: number;
  /** Required for fetching pool/curve state (Pump.fun, PumpSwap, Raydium). */
  connection: Connection;
}

/** Normalize entry_dex to lowercase for routing. */
function dexKey(entryDex: string | null): string {
  if (!entryDex) return '';
  return entryDex.toLowerCase().trim();
}

/**
 * Build a swap transaction for the given order.
 * Routes by order.entry_dex: pumpfun | pumpswap | raydium.
 */
export async function buildSwapTransaction(
  options: BuildSwapOptions
): Promise<Transaction> {
  const { account, order, signer, slippageBps, connection } = options;
  const dex = dexKey(order.entry_dex);
  const tokenMintRaw = order.token_mint ?? null;

  if (!tokenMintRaw || tokenMintRaw.length < 32) {
    throw new Error('SOLANA_SWAP_MISSING_TOKEN_MINT');
  }

  let tokenMint = tokenMintRaw.trim();
  if (!isBase58(tokenMint)) {
    tokenMint = sanitizeToBase58(tokenMint);
    if (tokenMint.length < 32) {
      throw new Error('Non-base58 character in token_mint');
    }
  }

  const mintPk = new PublicKey(tokenMint);

  if (dex === 'pumpfun') {
    return buildPumpFunSwap({
      connection,
      signer,
      mint: mintPk,
      order,
      slippageBps,
      getSolPriceUsd,
    });
  }
  if (dex === 'pumpswap') {
    let pairAddress = (order.pair_address ?? '').trim();
    if (!isBase58(pairAddress)) {
      pairAddress = sanitizeToBase58(pairAddress);
      if (pairAddress.length < 32) {
        throw new Error('Non-base58 character in pair_address');
      }
    }
    if (!pairAddress) {
      throw new Error('Non-base58 character in pair_address');
    }
    return buildPumpSwapSwap({
      connection,
      signer,
      mint: mintPk,
      pairAddress,
      order,
      slippageBps,
      getSolPriceUsd,
    });
  }
  if (dex === 'raydium') {
    return buildRaydiumSwap({
      connection,
      signer,
      mint: mintPk,
      order,
      slippageBps,
      getSolPriceUsd,
    });
  }

  throw new Error(
    `SOLANA_SWAP_UNSUPPORTED_DEX: entry_dex=${order.entry_dex}. Supported: pumpfun, pumpswap, raydium.`
  );
}

