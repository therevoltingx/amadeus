/**
 * Normalizes `pair_swap_events.created_at` for rolling-window SQL.
 * Vault worker stores ms (`Date.now()`). Legacy rows may use Unix seconds; comparing seconds to
 * `sinceMs` (ms) makes every rolling window empty while totals still grow.
 *
 * @see chain-snapshots-worker.ts rolling queries
 */
export const CREATED_AT_MS_THRESHOLD = 1_000_000_000_000;

/** SQL fragment: interpret `created_at` as epoch ms for `>= $sinceMs` comparisons. */
export function swapEventCreatedAtMsExpr(): string {
  return `(CASE WHEN created_at < ${CREATED_AT_MS_THRESHOLD} THEN created_at * 1000 ELSE created_at END)`;
}
