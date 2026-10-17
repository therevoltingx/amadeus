/**
 * Adapt app SQL idioms to PostgreSQL (INSERT OR IGNORE / OR REPLACE → ON CONFLICT, RETURNING for lastInsertRowid).
 */

const INSERT_RETURNING_PK: Record<string, string> = {
  pair_snapshots: 'snapshot_id',
  pair_swap_events: 'id',
  trades: 'trade_id',
  policies: 'policy_id',
  pair_scores: 'id',
  trade_decisions: 'trade_id',
  trade_decision_skips: 'id',
  entry_filter_rejections: 'id',
  recommendations: 'id',
  backtest_runs: 'id',
  backtest_trades: 'id',
  backtest_entry_diagnostics: 'id',
};

function extractInsertTable(sql: string): string | null {
  const m = /INSERT\s+INTO\s+["']?([a-zA-Z_][a-zA-Z0-9_]*)["']?/i.exec(sql.trim());
  return m ? m[1].toLowerCase() : null;
}

/** Append RETURNING <pk> for INSERTs that need lastInsertRowid and do not already have RETURNING / ON CONFLICT. */
export function ensureInsertReturning(sql: string): string {
  const s = sql.trim();
  if (!/^INSERT\s+INTO/i.test(s)) return sql;
  if (/\bRETURNING\b/i.test(s)) return sql;
  if (/\bON\s+CONFLICT\b/i.test(s)) return sql;
  const table = extractInsertTable(s);
  if (!table) return sql;
  const pk = INSERT_RETURNING_PK[table];
  if (!pk) return sql;
  return `${s.replace(/;+\s*$/, '')} RETURNING ${pk}`;
}

/** Statement rewrites for PostgreSQL (legacy INSERT OR IGNORE / OR REPLACE patterns in source SQL). */
export function rewriteSqliteSqlForPostgres(sql: string): string {
  let s = sql.trim();

  if (/INSERT\s+OR\s+IGNORE\s+INTO\s+snapshot_cursors\b/i.test(s)) {
    return s
      .replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO')
      .replace(/;+\s*$/, '') + ' ON CONFLICT (name) DO NOTHING';
  }

  if (/INSERT\s+OR\s+IGNORE\s+INTO\s+accounts\b/i.test(s)) {
    return s.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO').replace(/;+\s*$/, '') + ' ON CONFLICT (account_id) DO NOTHING';
  }

  if (/INSERT\s+OR\s+IGNORE\s+INTO\s+policy_deployments\b/i.test(s)) {
    return s.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, 'INSERT INTO').replace(/;+\s*$/, '') + ' ON CONFLICT (policy_id, account_id) DO NOTHING';
  }

  if (
    /INSERT\s+OR\s+REPLACE\s+INTO\s+pair_policy_stats\b/i.test(s) &&
    /VALUES\s*\(\s*\$pairAddress/i.test(s)
  ) {
    return `INSERT INTO pair_policy_stats (pair_address, policy_version, last_loss_at, consecutive_losses, last_exit_reason, updated_at)
VALUES ($pairAddress, $policyVersion, $lastLossAt, $consecutiveLosses, $lastExitReason, $updatedAt)
ON CONFLICT (pair_address, policy_version) DO UPDATE SET
  last_loss_at = EXCLUDED.last_loss_at,
  consecutive_losses = EXCLUDED.consecutive_losses,
  last_exit_reason = EXCLUDED.last_exit_reason,
  updated_at = EXCLUDED.updated_at`;
  }

  if (
    /INSERT\s+OR\s+REPLACE\s+INTO\s+token_policy_stats\b/i.test(s) &&
    /VALUES\s*\(\s*\$tokenMint/i.test(s)
  ) {
    return `INSERT INTO token_policy_stats (token_mint, policy_version, last_loss_at, consecutive_losses, last_exit_reason, updated_at)
VALUES ($tokenMint, $policyVersion, $lastLossAt, $consecutiveLosses, $lastExitReason, $updatedAt)
ON CONFLICT (token_mint, policy_version) DO UPDATE SET
  last_loss_at = EXCLUDED.last_loss_at,
  consecutive_losses = EXCLUDED.consecutive_losses,
  last_exit_reason = EXCLUDED.last_exit_reason,
  updated_at = EXCLUDED.updated_at`;
  }

  if (/INSERT\s+OR\s+REPLACE\s+INTO\s+snapshot_cursors\b/i.test(s)) {
    return s
      .replace(/INSERT\s+OR\s+REPLACE\s+INTO/i, 'INSERT INTO')
      .replace(/;+\s*$/, '') +
      ' ON CONFLICT (name) DO UPDATE SET last_swap_id = EXCLUDED.last_swap_id';
  }

  if (/INSERT\s+OR\s+REPLACE\s+INTO\s+accounts\b/i.test(s) && /VALUES\s*\(\s*\$accountId/i.test(s)) {
    const hasName = /,\s*\$name,/i.test(s);
    if (hasName) {
      return `INSERT INTO accounts (account_id, mode, chain, address, name, starting_equity, current_equity, available_balance, max_daily_drawdown_pct, max_total_open_trades, max_total_risk_pct, trading_enabled, is_active, created_at, updated_at)
VALUES ($accountId, 'live', 'solana', NULL, $name, 0, 0, 0, 15, 20, 15, 1, 0, $now, $now)
ON CONFLICT (account_id) DO UPDATE SET
  mode = EXCLUDED.mode,
  chain = EXCLUDED.chain,
  address = EXCLUDED.address,
  name = EXCLUDED.name,
  starting_equity = EXCLUDED.starting_equity,
  current_equity = EXCLUDED.current_equity,
  available_balance = EXCLUDED.available_balance,
  max_daily_drawdown_pct = EXCLUDED.max_daily_drawdown_pct,
  max_total_open_trades = EXCLUDED.max_total_open_trades,
  max_total_risk_pct = EXCLUDED.max_total_risk_pct,
  trading_enabled = EXCLUDED.trading_enabled,
  is_active = EXCLUDED.is_active,
  updated_at = EXCLUDED.updated_at`;
    }
    return `INSERT INTO accounts (account_id, mode, chain, address, starting_equity, current_equity, available_balance, max_daily_drawdown_pct, max_total_open_trades, trading_enabled, created_at, updated_at)
VALUES ($accountId, 'paper', 'paper', '', 100, 100, 100, 15, 20, 1, $now, $now)
ON CONFLICT (account_id) DO UPDATE SET
  mode = EXCLUDED.mode,
  chain = EXCLUDED.chain,
  address = EXCLUDED.address,
  starting_equity = EXCLUDED.starting_equity,
  current_equity = EXCLUDED.current_equity,
  available_balance = EXCLUDED.available_balance,
  max_daily_drawdown_pct = EXCLUDED.max_daily_drawdown_pct,
  max_total_open_trades = EXCLUDED.max_total_open_trades,
  trading_enabled = EXCLUDED.trading_enabled,
  updated_at = EXCLUDED.updated_at`;
  }

  return s;
}

/** SQLite allows `ON CONFLICT(col)`; PostgreSQL expects `ON CONFLICT (col)`. */
export function normalizeOnConflictForPostgres(sql: string): string {
  return sql.replace(/\bON\s+CONFLICT\s*\(/gi, 'ON CONFLICT (');
}

export function preparePostgresQuery(sql: string): string {
  const rewritten = normalizeOnConflictForPostgres(rewriteSqliteSqlForPostgres(sql));
  return ensureInsertReturning(rewritten);
}
