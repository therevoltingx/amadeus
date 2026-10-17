/**
 * Rolling liquidity metrics per pair: computed from pair_snapshots.liquidity_usd over 30m/1h windows.
 * Used for liquidity trend guard (detect draining pools). Deterministic, window-bounded queries.
 */
import { db } from './db.js';

export const WINDOW_30M_SEC = 30 * 60;
export const WINDOW_1H_SEC = 60 * 60;

type SnapshotLiquidityRow = { timestamp: number; liquidity_usd: number | null };

const selectPriorLiquidity = db.prepare(`
  SELECT timestamp, liquidity_usd
  FROM pair_snapshots
  WHERE pair_address = $pairAddress AND timestamp >= $windowStart AND timestamp < $currentTimestamp
  ORDER BY timestamp ASC
`);

export interface RollingLiquidityResult {
  avg_liquidity_30m: number | null;
  avg_liquidity_1h: number | null;
  liquidity_change_pct_30m: number | null;
  liquidity_change_pct_1h: number | null;
  sample_count: number;
}

/**
 * Compute rolling liquidity averages and change percentages for a pair at a given timestamp.
 * Uses historical snapshots in 30m and 1h windows ending just before currentTimestamp.
 * currentLiquidity is the liquidity at currentTimestamp (e.g. the snapshot just inserted).
 * change_pct = (currentLiquidity - avg_window) / avg_window (negative = draining).
 */
export function computeRollingLiquidityMetrics(
  pairAddress: string,
  currentTimestamp: number,
  currentLiquidity: number | null
): RollingLiquidityResult {
  const windowStart1h = currentTimestamp - WINDOW_1H_SEC;
  const rows = selectPriorLiquidity.all({
    pairAddress,
    windowStart: windowStart1h,
    currentTimestamp,
  }) as SnapshotLiquidityRow[];

  const withLiquidity = rows.filter((r) => r.liquidity_usd != null && Number.isFinite(r.liquidity_usd));
  const sample_count = withLiquidity.length;

  if (sample_count === 0) {
    return {
      avg_liquidity_30m: null,
      avg_liquidity_1h: null,
      liquidity_change_pct_30m: null,
      liquidity_change_pct_1h: null,
      sample_count: 0,
    };
  }

  const windowStart30m = currentTimestamp - WINDOW_30M_SEC;
  const values1h = withLiquidity.map((r) => r.liquidity_usd as number);
  const avg_1h = values1h.reduce((a, b) => a + b, 0) / values1h.length;
  const rows30m = withLiquidity.filter((r) => r.timestamp >= windowStart30m);
  const avg_30m =
    rows30m.length > 0
      ? rows30m.reduce((a, r) => a + (r.liquidity_usd as number), 0) / rows30m.length
      : null;

  const cur = currentLiquidity != null && Number.isFinite(currentLiquidity) ? currentLiquidity : null;
  let liquidity_change_pct_1h: number | null = null;
  let liquidity_change_pct_30m: number | null = null;
  if (cur != null && cur > 0) {
    if (avg_1h > 0) liquidity_change_pct_1h = (cur - avg_1h) / avg_1h;
    if (avg_30m != null && avg_30m > 0) liquidity_change_pct_30m = (cur - avg_30m) / avg_30m;
  }

  return {
    avg_liquidity_30m: avg_30m ?? null,
    avg_liquidity_1h: avg_1h,
    liquidity_change_pct_30m,
    liquidity_change_pct_1h,
    sample_count,
  };
}
