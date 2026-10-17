/**
 * Rolling volume baselines per pair: computed incrementally from pair_snapshots.volume_5m,
 * stored on each snapshot for volume persistence / collapse detection. Deterministic.
 */
import { db } from './db.js';

export const WINDOW_5M_SEC = 5 * 60;
export const WINDOW_30M_SEC = 30 * 60;
export const WINDOW_1H_SEC = 60 * 60;

export const MIN_SAMPLES_5M = 2;
export const MIN_SAMPLES_30M = 4;
export const MIN_SAMPLES_1H = 6;

/** Below this, ratio is clamped to avoid division noise. */
export const MIN_BASELINE_FLOOR = 1;

/** Single snapshot volume above this multiple of baseline is logged as anomaly (still included in averages). */
export const OUTLIER_MULTIPLIER = 10;

const LOG_PREFIX = '[rolling-volume]';

export interface RollingVolumeResult {
  avg_5m: number | null;
  avg_30m: number | null;
  avg_1h: number | null;
  sample_count: number;
}

/** One row from DB: timestamp and volume_5m. */
type SnapshotVolumeRow = { timestamp: number; volume_5m: number | null };

const selectPriorVolumes = db.prepare(`
  SELECT timestamp, volume_5m
  FROM pair_snapshots
  WHERE pair_address = $pairAddress AND timestamp >= $windowStart AND timestamp < $currentTimestamp
  ORDER BY timestamp ASC
`);

/**
 * Compute rolling averages of volume_5m over 5m, 30m, 1h windows ending just before currentTimestamp.
 * Uses indexed (pair_address, timestamp) range; single query for 1h window then slice for 5m/30m.
 * Returns averages and sample_count (number of samples in 1h window). Does not modify raw snapshots.
 */
export function computeRollingVolumeBaselines(
  pairAddress: string,
  currentTimestamp: number
): RollingVolumeResult {
  const windowStart1h = currentTimestamp - WINDOW_1H_SEC;
  const rows = selectPriorVolumes.all({
    pairAddress,
    windowStart: windowStart1h,
    currentTimestamp,
  }) as SnapshotVolumeRow[];

  const withVolume = rows.filter((r) => r.volume_5m != null && Number.isFinite(r.volume_5m));
  const sample_count = withVolume.length;

  if (sample_count === 0) {
    if (rows.length > 0) {
      console.debug(`${LOG_PREFIX} baseline not computed: no volume_5m in window (${rows.length} rows) pair=${pairAddress.slice(0, 12)}…`);
    }
    return { avg_5m: null, avg_30m: null, avg_1h: null, sample_count: 0 };
  }

  const windowStart30m = currentTimestamp - WINDOW_30M_SEC;
  const windowStart5m = currentTimestamp - WINDOW_5M_SEC;

  const values1h = withVolume.map((r) => r.volume_5m as number);
  const avg_1h = values1h.reduce((a, b) => a + b, 0) / values1h.length;

  const rows30m = withVolume.filter((r) => r.timestamp >= windowStart30m);
  const avg_30m = rows30m.length > 0 ? rows30m.reduce((a, r) => a + (r.volume_5m as number), 0) / rows30m.length : null;

  const rows5m = withVolume.filter((r) => r.timestamp >= windowStart5m);
  const avg_5m = rows5m.length > 0 ? rows5m.reduce((a, r) => a + (r.volume_5m as number), 0) / rows5m.length : null;

  return {
    avg_5m: avg_5m ?? null,
    avg_30m: avg_30m ?? null,
    avg_1h,
    sample_count,
  };
}

/** Snapshot-like object with volume and optional rolling fields (from DB or in-memory). */
export interface SnapshotWithVolume {
  /** DB column is volume_5m; alias volume_5m_usd for API compatibility. */
  volume_5m?: number | null;
  volume_5m_usd?: number | null;
  rolling_avg_volume_5m?: number | null;
  rolling_avg_volume_30m?: number | null;
  rolling_avg_volume_1h?: number | null;
  rolling_volume_sample_count?: number | null;
}

/**
 * Compute volume persistence ratio for collapse exit: volume_5m / rolling_avg_volume_1h.
 * Returns null if rolling fields missing, baseline too small, or sample count below minSamples (safe no-op).
 */
export function computeVolumePersistence(
  snapshot: SnapshotWithVolume,
  minSamples: number
): number | null {
  const vol =
    (snapshot.volume_5m != null && Number.isFinite(snapshot.volume_5m)
      ? snapshot.volume_5m
      : snapshot.volume_5m_usd != null && Number.isFinite(snapshot.volume_5m_usd)
        ? snapshot.volume_5m_usd
        : null) as number | null;
  const base1h =
    snapshot.rolling_avg_volume_1h != null && Number.isFinite(snapshot.rolling_avg_volume_1h)
      ? snapshot.rolling_avg_volume_1h
      : null;
  const sampleCount =
    snapshot.rolling_volume_sample_count != null && Number.isFinite(snapshot.rolling_volume_sample_count)
      ? Math.floor(snapshot.rolling_volume_sample_count)
      : null;

  if (vol == null || base1h == null || sampleCount == null) return null;
  if (base1h <= MIN_BASELINE_FLOOR) return null;
  if (sampleCount < minSamples) return null;

  const floor = Math.max(MIN_BASELINE_FLOOR, base1h);
  return vol / floor;
}

export interface VolumePersistenceMetrics {
  /** volume_5m / rolling_avg_volume_1h (clamped if baseline too small). */
  volume_vs_1h_baseline: number | null;
  /** volume_5m / rolling_avg_volume_30m (clamped if baseline too small). */
  volume_vs_30m_baseline: number | null;
  /** volume_5m / rolling_avg_volume_5m (clamped). */
  volume_vs_5m_baseline: number | null;
}

/**
 * Returns normalized signals for runner exits, scoring, analytics.
 * Division safety: if baseline < MIN_BASELINE_FLOOR, ratio is clamped to a max value (e.g. 100) to avoid noise.
 */
export function getVolumePersistenceMetrics(snapshot: SnapshotWithVolume): VolumePersistenceMetrics {
  const vol = snapshot.volume_5m != null && Number.isFinite(snapshot.volume_5m) ? snapshot.volume_5m : null;
  const base1h = snapshot.rolling_avg_volume_1h != null && Number.isFinite(snapshot.rolling_avg_volume_1h)
    ? snapshot.rolling_avg_volume_1h
    : null;
  const base30m = snapshot.rolling_avg_volume_30m != null && Number.isFinite(snapshot.rolling_avg_volume_30m)
    ? snapshot.rolling_avg_volume_30m
    : null;
  const base5m = snapshot.rolling_avg_volume_5m != null && Number.isFinite(snapshot.rolling_avg_volume_5m)
    ? snapshot.rolling_avg_volume_5m
    : null;

  const safeRatio = (v: number, base: number): number => {
    const floor = Math.max(MIN_BASELINE_FLOOR, base);
    return v / floor;
  };

  return {
    volume_vs_1h_baseline: vol != null && base1h != null ? safeRatio(vol, base1h) : null,
    volume_vs_30m_baseline: vol != null && base30m != null ? safeRatio(vol, base30m) : null,
    volume_vs_5m_baseline: vol != null && base5m != null ? safeRatio(vol, base5m) : null,
  };
}

/** Call when baseline first becomes valid or sample_count crosses threshold (lightweight debug). */
export function logRollingBaselineEvent(
  pairAddress: string,
  result: RollingVolumeResult,
  previousSampleCount: number | null
): void {
  const { sample_count, avg_1h } = result;
  if (sample_count === 0) {
    return;
  }
  const justBecameValid =
    previousSampleCount != null && previousSampleCount < MIN_SAMPLES_1H && sample_count >= MIN_SAMPLES_1H;
  const crossed5m = previousSampleCount != null && previousSampleCount < MIN_SAMPLES_5M && sample_count >= MIN_SAMPLES_5M;
  const crossed30m = previousSampleCount != null && previousSampleCount < MIN_SAMPLES_30M && sample_count >= MIN_SAMPLES_30M;
  if (justBecameValid || crossed5m || crossed30m) {
    console.debug(
      `${LOG_PREFIX} baseline valid samples=${sample_count} pair=${pairAddress.slice(0, 12)}… avg_1h=${avg_1h?.toFixed(0) ?? '—'}`
    );
  }
}

/** Optional: log when a single snapshot volume is extreme vs baseline (still include in average). */
export function logVolumeOutlierIfAny(
  pairAddress: string,
  volume5m: number,
  baseline1h: number | null
): void {
  if (baseline1h == null || baseline1h < MIN_BASELINE_FLOOR) return;
  if (volume5m > baseline1h * OUTLIER_MULTIPLIER) {
    console.debug(
      `${LOG_PREFIX} anomaly volume_5m=${volume5m.toFixed(0)} > ${OUTLIER_MULTIPLIER}x baseline_1h=${baseline1h.toFixed(0)} pair=${pairAddress.slice(0, 12)}…`
    );
  }
}
