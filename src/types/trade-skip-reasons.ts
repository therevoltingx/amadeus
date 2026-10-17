/**
 * Canonical trade skip/rejection reasons. All SKIP decisions must use one of these values.
 * Used by execution worker when writing to trade_decision_skips and by analytics for grouping.
 * Every skip path in the execution worker should map to exactly one of these so we never show UNKNOWN.
 */
export const TRADE_SKIP_REASONS = [
  // Policy-level gates (before considering any score)
  'POLICY_COOLDOWN',
  'KILL_SWITCH',
  'MAX_CONCURRENT_TRADES',
  'COOLDOWN_AFTER_LOSS',
  'POLICY_MAX_TRADES_PER_HOUR',
  'MAX_TRADES_PER_HOUR',
  // Score/candidate gates
  'LOW_SCORE',
  'POLICY_VERSION_MISMATCH',
  'STALE_SCORE',
  'SIGNAL_GATE',
  'MARKET_MODE_MISMATCH',
  'DUPLICATE_OPEN_PAIR',
  'MAX_CONCURRENT',
  // Token/pair execution limits
  'TOKEN_REENTRY_COOLDOWN',
  'TOKEN_REENTRY_COOLDOWN_WIN',
  'TOKEN_REENTRY_COOLDOWN_LOSS',
  'MAX_TRADES_PER_TOKEN',
  // Data / balance
  'NO_ENTRY_PRICE',
  'NO_SNAPSHOT_IDS',
  'INSUFFICIENT_BALANCE',
  'ACCOUNT_DRAWDOWN',
  'MAX_OPEN_TRADES',
  // Entry filter / other
  'PAIR_TOO_OLD',
  'INSUFFICIENT_VOLUME',
  'BUY_SELL_RATIO',
  'HOLDER_CONCENTRATION',
  'RUG_DETECTED',
  'POLICY_HALTED',
  'UNKNOWN',
] as const;

export type TradeSkipReason = (typeof TRADE_SKIP_REASONS)[number];

/** Map DB reason strings to canonical TradeSkipReason. Unknown values become UNKNOWN. */
export function normalizeSkipReason(reason: string | null): TradeSkipReason {
  if (!reason || typeof reason !== 'string') return 'UNKNOWN';
  const u = reason.toUpperCase().trim();
  if (TRADE_SKIP_REASONS.includes(u as TradeSkipReason)) return u as TradeSkipReason;
  // Legacy / alternate spellings
  if (u === 'PAIR_COOLDOWN' || u === 'CONSECUTIVE_PAIR_LOSSES') return 'COOLDOWN_AFTER_LOSS';
  return 'UNKNOWN';
}
