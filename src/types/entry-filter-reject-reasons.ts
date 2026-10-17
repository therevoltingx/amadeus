/**
 * Canonical entry filter rejection reasons. Each entry filter rejection must map to exactly one.
 * Used when logging to entry_filter_rejections and by analytics for grouping.
 */
export const ENTRY_FILTER_REJECT_REASONS = [
  'PAIR_TOO_OLD',
  'MIN_TOKEN_AGE',
  'MIN_VOLUME_5M',
  'MIN_VOLUME_1M',
  'MIN_PRICE_CHANGE_1M_PCT',
  'MIN_LIQUIDITY',
  'LIQUIDITY_DRAIN',
  'BUY_SELL_RATIO',
  'MIN_TRANSACTIONS_1M',
  'MIN_VELOCITY_SCORE_1M',
  'MIN_BUY_PRESSURE_1M',
  'MIN_BUY_VOLUME_1M',
  'MIN_SELL_VOLUME_1M',
  'MAX_TOP_HOLDER_PCT',
  'MIN_HOLDER_COUNT',
  'DEX_NOT_ALLOWED',
  'HAS_MINT_AUTHORITY',   // token has mint authority but policy requires require_no_mint_authority
  'HAS_FREEZE_AUTHORITY', // token has freeze authority but policy requires require_no_freeze_authority
  'LP_NOT_LOCKED',       // policy requires require_lp_lock but LP is not locked
  'OTHER_ENTRY_FILTER',   // fallback for any other hard filter not listed above
] as const;

export type EntryFilterRejectReason = (typeof ENTRY_FILTER_REJECT_REASONS)[number];

export function isEntryFilterRejectReason(s: string): s is EntryFilterRejectReason {
  return (ENTRY_FILTER_REJECT_REASONS as readonly string[]).includes(s);
}
