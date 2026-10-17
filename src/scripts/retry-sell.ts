/**
 * Debug script: retry a PumpSwap sell for a specific pair/token.
 * Builds the swap transaction (simulate only by default) to diagnose failures.
 *
 * Note: Sell uses your wallet's token balance for the pair's base/quote token.
 * If you see SOLANA_SWAP_SELL_INSUFFICIENT_TOKEN_BALANCE, the wallet has no (or zero)
 * balance of that token.
 *
 * Usage:
 *   npx tsx src/scripts/retry-sell.ts <pair_address> [options]
 *
 * Options:
 *   --token <mint>         Token mint (resolved from DB if omitted)
 *   --dex <dex>            DEX name (default: pumpswap)
 *   --usd <amount>         Minimum expected output in USD for slippage (default: 0.1)
 *   --slippage <bps>       Slippage in basis points (default: 500)
 *   --send                 Actually send the transaction (default: simulate only)
 *   --score-id <id>        Look up pair/token/dex from a pair_scores row
 *
 * Examples:
 *   npx tsx src/scripts/retry-sell.ts 3SURLDKBdpH4sByvaNoF3i6NsykUXtq84C4kULPY4CjW
 *   npx tsx src/scripts/retry-sell.ts --score-id 131916
 *   npx tsx src/scripts/retry-sell.ts 3SURLDKBdpH4sByvaNoF3i6NsykUXtq84C4kULPY4CjW --slippage 1000 --send
 *   # When pair is not in DB, pass token mint (and optionally --dex):
 *   npx tsx src/scripts/retry-sell.ts <pair_address> --token <base_token_mint>
 */
import 'dotenv/config';
import {
  Connection,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { getSolanaRpcUrl } from '../config.js';
import { getSolanaSigner } from '../solana-signer.js';
import { getSolPriceUsd } from '../sol-price.js';
import { buildSwapTransaction } from '../solana-swap.js';
import { db } from '../db.js';
import type { ExecutionOrder } from '../executors/types.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts: Record<string, string | boolean> = {};
  let positional: string | null = null;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--send') {
      opts.send = true;
    } else if (a.startsWith('--') && i + 1 < args.length) {
      opts[a.slice(2)] = args[++i];
    } else if (!a.startsWith('--') && !positional) {
      positional = a;
    }
  }
  return { positional, opts };
}

interface ResolvedTarget {
  pair_address: string;
  token_mint: string;
  entry_dex: string;
}

function resolveFromScoreId(scoreId: number): ResolvedTarget {
  const row = db.prepare(
    `SELECT pair_address, policy_version FROM pair_scores WHERE id = $scoreId`
  ).get({ scoreId }) as { pair_address: string; policy_version: string } | undefined;

  if (!row) throw new Error(`No pair_scores row with id=${scoreId}`);

  const pair = db.prepare(
    `SELECT base_token_address, dex FROM pairs WHERE pair_address = $pairAddress LIMIT 1`
  ).get({ pairAddress: row.pair_address }) as { base_token_address: string; dex: string } | undefined;

  if (!pair) throw new Error(`No pairs row for pair_address=${row.pair_address}`);

  return {
    pair_address: row.pair_address,
    token_mint: pair.base_token_address,
    entry_dex: pair.dex,
  };
}

function resolveFromPairAddress(pairAddress: string, tokenOverride?: string, dexOverride?: string): ResolvedTarget {
  const pair = db.prepare(
    `SELECT base_token_address, dex FROM pairs WHERE pair_address = $pairAddress LIMIT 1`
  ).get({ pairAddress }) as { base_token_address: string; dex: string } | undefined;

  return {
    pair_address: pairAddress,
    token_mint: tokenOverride ?? pair?.base_token_address ?? '',
    entry_dex: dexOverride ?? pair?.dex ?? 'pumpswap',
  };
}

async function main() {
  const { positional, opts } = parseArgs();
  const scoreId = opts['score-id'] ? Number(opts['score-id']) : null;

  let target: ResolvedTarget;
  if (scoreId != null) {
    target = resolveFromScoreId(scoreId);
    console.log(`Resolved from score_id=${scoreId}:`, target);
  } else if (positional) {
    target = resolveFromPairAddress(
      positional,
      opts.token as string | undefined,
      opts.dex as string | undefined,
    );
    console.log('Resolved from pair_address:', target);
  } else {
    console.error('Usage: npx tsx src/scripts/retry-sell.ts <pair_address> [options]');
    console.error('       npx tsx src/scripts/retry-sell.ts --score-id <id>');
    process.exit(1);
  }

  if (!target.token_mint) {
    throw new Error(
      'Could not resolve token_mint (pair may not be in the database). ' +
      'Run with --token <base_token_mint> and optionally --dex <dex> (e.g. --dex pumpswap).'
    );
  }

  const positionSizeUsd = opts.usd ? Number(opts.usd) : 0.1;
  const slippageBps = opts.slippage ? Number(opts.slippage) : 500;
  const shouldSend = opts.send === true;

  const rpcUrl = getSolanaRpcUrl();
  if (!rpcUrl) throw new Error('HELIUS_RPC_URL not set');

  const signer = getSolanaSigner();
  const connection = new Connection(rpcUrl, { commitment: 'confirmed' });

  const solPrice = await getSolPriceUsd();
  console.log(`SOL price: $${solPrice.toFixed(2)}`);
  console.log(`Min output (USD): $${positionSizeUsd} (used for slippage floor)`);
  console.log(`Slippage: ${slippageBps} bps (${slippageBps / 100}%)`);
  console.log(`Mode: ${shouldSend ? 'SEND (live!)' : 'SIMULATE ONLY'}`);
  console.log('---');

  const order: ExecutionOrder = {
    pair_address: target.pair_address,
    token_mint: target.token_mint,
    entry_dex: target.entry_dex,
    policy_version: 'debug-retry-sell',
    market_mode: 'amm',
    signal: 'SELL',
    entry_price: 0,
    position_size_usd: positionSizeUsd,
    entry_snapshot_id: null,
    entry_score_id: scoreId,
    risk_pct_at_entry: null,
    score_size_multiplier: null,
    entry_snapshot_ts: Math.floor(Date.now() / 1000),
    deployment_id: 'debug',
    reason: 'retry-sell script',
  };

  console.log('Building swap transaction...');
  const startMs = Date.now();

  let tx;
  try {
    tx = await buildSwapTransaction({
      account: {
        account_id: 'debug',
        mode: 'live',
        chain: 'solana',
        address: signer.publicKey.toBase58(),
        available_balance: 9999,
        starting_equity: 9999,
        max_total_risk_pct: 100,
      },
      order,
      signer,
      slippageBps,
      connection,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('\nBuild FAILED:', msg);
    const logs = (e as { logs?: string[] })?.logs;
    if (Array.isArray(logs)) {
      console.error('\nSimulation logs:');
      for (const l of logs) console.error('  ', l);
    }
    process.exit(1);
  }

  const buildMs = Date.now() - startMs;
  console.log(`Transaction built in ${buildMs}ms (${tx.instructions.length} instructions)`);

  tx.add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 3000 })
  );

  if (!shouldSend) {
    console.log('\nSimulating transaction...');
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.feePayer = signer.publicKey;
    try {
      const sim = await connection.simulateTransaction(tx, [signer]);
      if (sim.value.err) {
        console.error('\nSimulation FAILED:', JSON.stringify(sim.value.err));
        if (sim.value.logs) {
          console.error('\nProgram logs:');
          for (const l of sim.value.logs) console.error('  ', l);
        }
        console.log('\nUnits consumed:', sim.value.unitsConsumed ?? 'unknown');
        process.exit(1);
      }
      console.log('\nSimulation SUCCEEDED');
      console.log('Units consumed:', sim.value.unitsConsumed ?? 'unknown');
      if (sim.value.logs) {
        console.log('\nProgram logs:');
        for (const l of sim.value.logs) console.log('  ', l);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('\nSimulation threw:', msg);
      const logs = (e as { logs?: string[] })?.logs;
      if (Array.isArray(logs)) {
        console.error('\nSimulation logs:');
        for (const l of logs) console.error('  ', l);
      }
      process.exit(1);
    }
  } else {
    console.log('\nSending transaction...');
    try {
      const sig = await sendAndConfirmTransaction(
        connection,
        tx,
        [signer],
        { skipPreflight: false, maxRetries: 3, commitment: 'confirmed' },
      );
      console.log('\nTransaction CONFIRMED:', sig);
      console.log(`https://solscan.io/tx/${sig}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('\nSend FAILED:', msg);
      const logs = (e as { logs?: string[] })?.logs;
      if (Array.isArray(logs)) {
        console.error('\nSimulation logs:');
        for (const l of logs) console.error('  ', l);
      }
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
