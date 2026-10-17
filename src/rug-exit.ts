/**
 * First-class rug detection exit. Policy-driven, deterministic.
 * Used by exit worker and backtest. Priority: rug → volume collapse → SL → TP → time stop.
 */

export type RugExitReason = 'LIQUIDITY_RUG_FLOOR' | 'SNAPSHOT_STALE' | 'PAIR_UNAVAILABLE';

export interface RugExitPolicy {
  rug_exit_enabled: boolean | number | null;
  rug_liquidity_floor_usd: number | null;
  rug_snapshot_stale_seconds: number | null;
  rug_pair_missing_threshold: number | null;
}

export interface RugExitTradeState {
  pair_missing_failures: number;
  last_snapshot_timestamp: number | null;
}

export interface LatestSnapshotForRug {
  timestamp: number;
  liquidity_usd: number | null;
  price_usd: number | null;
}

export interface EvaluateRugExitResult {
  shouldExit: boolean;
  reason?: RugExitReason;
  metadata?: Record<string, unknown>;
}

/**
 * Evaluate rug exit rules only. Caller must run this before other exit types when rug_exit_enabled.
 * Order: liquidity floor → snapshot staleness → pair missing threshold.
 */
export function evaluateRugExit(params: {
  trade: RugExitTradeState;
  policy: RugExitPolicy;
  latestSnapshot: LatestSnapshotForRug | null;
  nowTs: number;
}): EvaluateRugExitResult {
  const { trade, policy, latestSnapshot, nowTs } = params;

  const enabled = policy.rug_exit_enabled === true || policy.rug_exit_enabled === 1;
  if (!enabled) return { shouldExit: false };

  const floor = policy.rug_liquidity_floor_usd;
  if (
    floor != null &&
    Number.isFinite(floor) &&
    latestSnapshot?.liquidity_usd != null &&
    Number.isFinite(latestSnapshot.liquidity_usd) &&
    latestSnapshot.liquidity_usd < floor
  ) {
    return {
      shouldExit: true,
      reason: 'LIQUIDITY_RUG_FLOOR',
      metadata: { liquidity_usd: latestSnapshot.liquidity_usd, floor },
    };
  }

  const staleSeconds = policy.rug_snapshot_stale_seconds;
  const lastTs = trade.last_snapshot_timestamp;
  if (staleSeconds != null && Number.isFinite(staleSeconds) && lastTs != null && Number.isFinite(lastTs)) {
    const snapshotAge = nowTs - lastTs;
    if (snapshotAge > staleSeconds) {
      return {
        shouldExit: true,
        reason: 'SNAPSHOT_STALE',
        metadata: { snapshot_age_seconds: snapshotAge },
      };
    }
  }

  const threshold = policy.rug_pair_missing_threshold ?? 3;
  if (trade.pair_missing_failures >= threshold) {
    return {
      shouldExit: true,
      reason: 'PAIR_UNAVAILABLE',
      metadata: { pair_missing_failures: trade.pair_missing_failures },
    };
  }

  return { shouldExit: false };
}
