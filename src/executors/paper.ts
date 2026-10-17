import { db } from '../db.js';
import { getSolPriceUsd } from '../sol-price.js';
import type { AccountForExecutor, ExecutionOrder, ExecuteOrderResult } from './types.js';

const reserveBalance = db.prepare(`
  UPDATE accounts SET available_balance = available_balance - $amount, updated_at = $updatedAt
  WHERE account_id = $accountId AND available_balance >= $amount
`);

const insertTradeDecision = db.prepare(`
  INSERT INTO trade_decisions (
    pair_address, token_mint, entry_dex, policy_version, market_mode, signal,
    entry_price, position_size_usd, executed_at, reason, execution_mode, entry_snapshot_id, entry_score_id,
    risk_pct_at_entry, score_size_multiplier, pair_missing_failures, last_snapshot_timestamp,
    account_id, deployment_id, chain, sol_price_at_entry
  ) VALUES ($pairAddress, $tokenMint, $entryDex, $policyVersion, $marketMode, $signal,
    $entryPrice, $positionSizeUsd, $executedAt, $reason, 'paper', $entrySnapshotId, $entryScoreId,
    $riskPctAtEntry, $scoreSizeMultiplier, 0, $lastSnapshotTimestamp,
    $accountId, $deploymentId, $chain, $solPriceAtEntry)
`);

/**
 * Paper executor: reserves balance and inserts trade_decision. No real chain execution.
 * Treats paper as a chain for routing simplicity.
 */
export async function paperExecutor(
  account: AccountForExecutor,
  order: ExecutionOrder
): Promise<ExecuteOrderResult> {
  const now = Math.floor(Date.now() / 1000);
  const chain = account.chain ?? 'paper';
  let solPriceAtEntry: number | null = null;
  try {
    solPriceAtEntry = await getSolPriceUsd();
  } catch {
    // omit if price fetch fails
  }

  let success = false;
  db.transaction(() => {
    const reserveResult = reserveBalance.run({
      amount: order.position_size_usd,
      updatedAt: now,
      accountId: account.account_id,
    }) as { changes: number };
    if (reserveResult.changes === 0) return;

    insertTradeDecision.run({
      pairAddress: order.pair_address,
      tokenMint: order.token_mint,
      entryDex: order.entry_dex,
      policyVersion: order.policy_version,
      marketMode: order.market_mode,
      signal: order.signal,
      entryPrice: order.entry_price,
      positionSizeUsd: order.position_size_usd,
      executedAt: now,
      reason: order.reason,
      entrySnapshotId: order.entry_snapshot_id,
      entryScoreId: order.entry_score_id ?? null,
      riskPctAtEntry: order.risk_pct_at_entry,
      scoreSizeMultiplier: order.score_size_multiplier,
      lastSnapshotTimestamp: order.entry_snapshot_ts,
      accountId: account.account_id,
      deploymentId: order.deployment_id,
      chain,
      solPriceAtEntry,
    });
    success = true;
  })();

  return success ? { success: true } : { success: false, skipReason: 'INSUFFICIENT_BALANCE' };
}
