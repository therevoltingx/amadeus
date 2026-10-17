/**
 * Hour-aligned bucket for time-series aggregation.
 * Use everywhere to avoid drift: bucket_start = hourBucket(timestamp).
 */
export function hourBucket(ts: number): number {
  return Math.floor(ts / 3600) * 3600;
}
