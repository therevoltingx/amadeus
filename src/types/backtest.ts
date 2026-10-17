/**
 * Canonical entry rejection reasons for backtest diagnostics. Stable strings for analytics.
 */
export const ENTRY_REJECTION_REASONS = {
  MIN_SCORE: 'min_score',
  PRIORITY_SCORE: 'priority_score',
  MAX_TRADES_PER_HOUR: 'max_trades_per_hour',
  MAX_CONCURRENT_TRADES: 'max_concurrent_trades',
  TOKEN_COOLDOWN: 'token_cooldown',
  COOLDOWN_AFTER_LOSS: 'cooldown_after_loss',
  PAIR_LOSS_COOLDOWN: 'pair_loss_cooldown',
  MAX_CONSECUTIVE_LOSSES_PAIR: 'max_consecutive_losses_pair',
  MAX_TRADES_PER_TOKEN: 'max_trades_per_token',
  DAILY_DRAWDOWN: 'daily_drawdown',
  INSUFFICIENT_DATA: 'insufficient_data',
  SNAPSHOT_TOO_OLD: 'snapshot_too_old',
  POLICY_COOLDOWN: 'policy_cooldown',
  ALREADY_OPEN: 'already_open',
  MARKET_MODE_MISMATCH: 'market_mode_mismatch',
  INSUFFICIENT_BALANCE: 'insufficient_balance',
  MIN_TOKEN_AGE: 'min_token_age',
  PAIR_TOO_OLD: 'pair_too_old',
  LIQUIDITY_DRAIN: 'liquidity_drain',
  PORTFOLIO_HEAT_LIMIT: 'portfolio_heat_limit',
  /** Entry snapshot price_change_1m below policy min (when set). */
  MIN_PRICE_CHANGE_1M_PCT: 'min_price_change_1m_pct',
} as const;

export type EntryRejectionReason = (typeof ENTRY_REJECTION_REASONS)[keyof typeof ENTRY_REJECTION_REASONS];

/**
 * Policy config used by the backtest engine. Engine does not read from policies table;
 * it receives a fully-resolved config (from DB row or hypothetical payload).
 */
export interface PolicyConfig {
  policy_version: string;
  allowed_dexes: string | null;
  max_pair_age_seconds?: number | null;
  min_token_age_seconds?: number | null;
  /** Min 1m price change % (snapshot price_change_1m); null = disabled. */
  min_price_change_1m_pct?: number | null;
  max_trades_per_hour: number | null;
  max_concurrent_trades: number | null;
  cooldown_seconds_after_loss: number | null;
  risk_per_trade_pct: number | null;
  time_stop_seconds: number | null;
  stop_loss_pct: number | null;
  take_profit_pct: number | null;
  cooldown_on_consecutive_losses: number | null;
  cooldown_on_consecutive_losses_seconds: number | null;
  pair_loss_cooldown_seconds: number | null;
  max_consecutive_losses_per_pair: number | null;
  token_reentry_cooldown_seconds: number | null;
  token_reentry_cooldown_seconds_after_win: number | null;
  max_trades_per_token_per_hour: number | null;
  priority_trade_score: number | null;
  min_trade_score: number | null;
  /** Volume collapse exit (runner strategies). Optional for hypothetical configs. */
  volume_collapse_exit_enabled?: boolean | number | null;
  volume_collapse_ratio_threshold?: number | null;
  volume_collapse_consecutive_checks?: number | null;
  volume_collapse_min_samples?: number | null;
  liquidity_trend_guard_enabled?: boolean | number | null;
  max_liquidity_drop_pct_30m?: number | null;
  max_liquidity_drop_pct_1h?: number | null;
  liquidity_trend_min_samples?: number | null;
  rug_exit_enabled?: boolean | number | null;
  rug_liquidity_floor_usd?: number | null;
  rug_snapshot_stale_seconds?: number | null;
  rug_pair_missing_threshold?: number | null;
}

/** Exit reason strings match live `trades.exit_reason` / exit-worker (ALL_CAPS). */
export type BacktestExitReason =
  | 'STOP_LOSS'
  | 'TAKE_PROFIT'
  | 'TIME_STOP'
  | 'VOLUME_COLLAPSE'
  | 'LIQUIDITY_RUG_FLOOR'
  | 'SNAPSHOT_STALE'
  | 'PAIR_UNAVAILABLE';

export interface BacktestTrade {
  pair_address: string;
  entry_time: number;
  exit_time: number;
  entry_price: number;
  exit_price: number;
  result: 'win' | 'loss';
  exit_reason: BacktestExitReason;
  pnl: number;
  hold_time_seconds: number;
  last_volume_ratio?: number | null;
}

/** Maps legacy short codes stored in older backtest rows to live exit_reason strings. */
export function normalizeBacktestExitReasonForDisplay(reason: string): string {
  switch (reason) {
    case 'sl':
      return 'STOP_LOSS';
    case 'tp':
      return 'TAKE_PROFIT';
    case 'time_stop':
      return 'TIME_STOP';
    case 'volume_collapse':
      return 'VOLUME_COLLAPSE';
    default:
      return reason.toUpperCase();
  }
}

export interface BacktestMetrics {
  trades: number;
  wins: number;
  losses: number;
  win_rate: number;
  avg_pnl: number;
  max_drawdown: number;
  avg_hold_time_seconds: number;
  /** Aggregated entry diagnostics: total checks, allowed/rejected counts, rejection breakdown */
  entry_diagnostics_summary?: EntryDiagnosticsSummary | null;
}

export interface EntryDiagnosticsSummary {
  total_entry_checks: number;
  entries_allowed: number;
  entries_rejected: number;
  rejection_breakdown: Record<string, number>;
}

export interface BacktestEntryDiagnostic {
  pair_address: string;
  timestamp: number;
  allowed: boolean;
  failed_checks: string[];
  score: number | null;
  policy_version: string;
}

export interface BacktestSnapshotRow {
  snapshot_id: number;
  pair_address: string;
  timestamp: number;
  price_usd: number | null;
  /** Seconds since pair/token creation at snapshot time. Used for min/max age entry filters. */
  seconds_since_creation?: number | null;
  /** Liquidity trend: change vs rolling 30m/1h (negative = draining). Used for liquidity_drain guard. */
  liquidity_change_pct_30m?: number | null;
  liquidity_change_pct_1h?: number | null;
  liquidity_sample_count?: number | null;
  /** Rolling volume baselines (from DB or computed on the fly for old rows). */
  rolling_avg_volume_5m?: number | null;
  rolling_avg_volume_30m?: number | null;
  rolling_avg_volume_1h?: number | null;
  rolling_volume_sample_count?: number | null;
  volume_5m?: number | null;
  liquidity_usd?: number | null;
  /** From pair_snapshots; used for min_price_change_1m_pct entry filter. */
  price_change_1m?: number | null;
}

export interface BacktestScoreRow {
  id: number;
  pair_address: string;
  scored_at: number;
  signal: string;
  total_score: number | null;
  snapshot_ids: string | null;
  market_mode: string | null;
}
