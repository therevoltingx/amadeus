/**
 * Clear all database tables except policies and policy_deployments.
 * Resets snapshot cursor and re-seeds default accounts (paper-default, solana-wallet).
 *
 * Usage:
 *   npx tsx src/scripts/clear-db.ts           # run
 *   npx tsx src/scripts/clear-db.ts --dry-run # print what would be cleared, no changes
 *
 * Requires DATABASE_URL (PostgreSQL).
 */
import 'dotenv/config';
import { db, DEFAULT_PAPER_ACCOUNT_ID, SOLANA_DEFAULT_ACCOUNT_ID } from '../db.js';

const DRY_RUN = process.argv.includes('--dry-run');

const TABLES_TO_CLEAR = [
  'pairs',
  'pair_snapshots',
  'pair_swap_events',
  'snapshot_cursors',
  'pair_volume_rollup',
  'trades',
  'pair_scores',
  'trade_decisions',
  'pair_policy_stats',
  'token_policy_stats',
  'token_policy_execution',
  'trade_decision_skips',
  'policy_execution_state',
  'entry_filter_rejections',
  'accounts',
  'policy_stats_hourly',
  'policy_analytics_offsets',
  'recommendations',
  'backtest_runs',
  'backtest_trades',
  'backtest_metrics',
  'backtest_entry_diagnostics',
] as const;

function main(): void {
  if (DRY_RUN) {
    console.log('Dry run: would clear the following tables (policies and policy_deployments kept):');
    TABLES_TO_CLEAR.forEach((t) => console.log('  -', t));
    console.log('Would reset snapshot_cursors and re-seed default accounts.');
    return;
  }

  const now = Math.floor(Date.now() / 1000);

  const transaction = db.transaction(() => {
    const list = TABLES_TO_CLEAR.join(', ');
    db.exec(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    db.prepare(
      `INSERT OR REPLACE INTO snapshot_cursors (name, last_swap_id) VALUES ($name, $lastSwapId)`
    ).run({ name: 'pair_snapshots', lastSwapId: 0 });
    db.prepare(
      `INSERT OR REPLACE INTO accounts (account_id, mode, chain, address, starting_equity, current_equity, available_balance, max_daily_drawdown_pct, max_total_open_trades, trading_enabled, created_at, updated_at)
       VALUES ($accountId, 'paper', 'paper', '', 100, 100, 100, 15, 20, 1, $now, $now)`
    ).run({ accountId: DEFAULT_PAPER_ACCOUNT_ID, now });
    db.prepare(
      `INSERT OR REPLACE INTO accounts (account_id, mode, chain, address, name, starting_equity, current_equity, available_balance, max_daily_drawdown_pct, max_total_open_trades, max_total_risk_pct, trading_enabled, is_active, created_at, updated_at)
       VALUES ($accountId, 'live', 'solana', NULL, $name, 0, 0, 0, 15, 20, 15, 1, 0, $now, $now)`
    ).run({ accountId: SOLANA_DEFAULT_ACCOUNT_ID, name: SOLANA_DEFAULT_ACCOUNT_ID, now });
  });
  transaction();

  console.log('Cleared all tables except policies and policy_deployments.');
  console.log('Reset snapshot_cursors and re-seeded default accounts (paper-default, solana-wallet).');
}

main();
