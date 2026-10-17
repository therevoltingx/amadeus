/**
 * Policy analytics worker: rolls up raw events into policy_stats_hourly for UI and agents.
 * Append/upsert only; idempotent and restart-safe via policy_analytics_offsets.
 */
import 'dotenv/config';
import { db } from '../db.js';
import { hourBucket } from '../utils/hour-bucket.js';
import { normalizeSkipReason } from '../types/trade-skip-reasons.js';

const RUN_INTERVAL_MS = 45_000; // 30–60s cadence
const CATCHUP_INTERVAL_MS = 2_000; // when backlog is large, run again soon
const BACKFILL_BACKLOG_THRESHOLD = 500; // if we processed this many rows, run again in CATCHUP_INTERVAL_MS

const SOURCE_TABLES = [
  'pair_scores',
  'trade_decisions',
  'trades',
  'trade_decision_skips',
  'entry_filter_rejections',
] as const;

type SourceTable = (typeof SOURCE_TABLES)[number];

function getOrCreateOffset(source: SourceTable): number {
  const row = db.prepare('SELECT last_processed_id FROM policy_analytics_offsets WHERE source_table = $sourceTable').get({ sourceTable: source }) as
    | { last_processed_id: number }
    | undefined;
  if (row != null) return row.last_processed_id;
  db.prepare('INSERT INTO policy_analytics_offsets (source_table, last_processed_id) VALUES ($sourceTable, 0)').run({ sourceTable: source });
  return 0;
}

function setOffset(source: SourceTable, id: number): void {
  db.prepare('INSERT INTO policy_analytics_offsets (source_table, last_processed_id) VALUES ($sourceTable, $lastProcessedId) ON CONFLICT(source_table) DO UPDATE SET last_processed_id = excluded.last_processed_id').run({
    sourceTable: source,
    lastProcessedId: id,
  });
}

// Upsert: add deltas to policy_stats_hourly (counters and sums)
const upsertHourly = db.prepare(`
  INSERT INTO policy_stats_hourly (
    bucket_start, policy_version,
    scores_above_min, scores_above_priority, entry_filters_passed,
    trades_opened, trades_closed, wins, losses,
    skips_token_cooldown, skips_policy_cooldown, skips_max_trades_per_hour, skips_entry_filter, skips_score_below_threshold,
    sum_trade_score, count_trade_score, sum_blocked_trade_score, count_blocked_trade_score
  ) VALUES ($bucketStart, $policyVersion, $scoresAboveMin, $scoresAbovePriority, $entryFiltersPassed, $tradesOpened, $tradesClosed, $wins, $losses, $skipsTokenCooldown, $skipsPolicyCooldown, $skipsMaxTradesPerHour, $skipsEntryFilter, $skipsScoreBelowThreshold, $sumTradeScore, $countTradeScore, $sumBlockedTradeScore, $countBlockedTradeScore)
  ON CONFLICT(bucket_start, policy_version) DO UPDATE SET
    scores_above_min = policy_stats_hourly.scores_above_min + excluded.scores_above_min,
    scores_above_priority = policy_stats_hourly.scores_above_priority + excluded.scores_above_priority,
    entry_filters_passed = policy_stats_hourly.entry_filters_passed + excluded.entry_filters_passed,
    trades_opened = policy_stats_hourly.trades_opened + excluded.trades_opened,
    trades_closed = policy_stats_hourly.trades_closed + excluded.trades_closed,
    wins = policy_stats_hourly.wins + excluded.wins,
    losses = policy_stats_hourly.losses + excluded.losses,
    skips_token_cooldown = policy_stats_hourly.skips_token_cooldown + excluded.skips_token_cooldown,
    skips_policy_cooldown = policy_stats_hourly.skips_policy_cooldown + excluded.skips_policy_cooldown,
    skips_max_trades_per_hour = policy_stats_hourly.skips_max_trades_per_hour + excluded.skips_max_trades_per_hour,
    skips_entry_filter = policy_stats_hourly.skips_entry_filter + excluded.skips_entry_filter,
    skips_score_below_threshold = policy_stats_hourly.skips_score_below_threshold + excluded.skips_score_below_threshold,
    sum_trade_score = policy_stats_hourly.sum_trade_score + excluded.sum_trade_score,
    count_trade_score = policy_stats_hourly.count_trade_score + excluded.count_trade_score,
    sum_blocked_trade_score = policy_stats_hourly.sum_blocked_trade_score + excluded.sum_blocked_trade_score,
    count_blocked_trade_score = policy_stats_hourly.count_blocked_trade_score + excluded.count_blocked_trade_score
`);

function mapSkipReasonToColumn(reason: string): keyof typeof SKIP_COLUMNS {
  const r = normalizeSkipReason(reason);
  // Token/pair cooldowns
  if (
    r === 'TOKEN_REENTRY_COOLDOWN' ||
    r === 'TOKEN_REENTRY_COOLDOWN_WIN' ||
    r === 'TOKEN_REENTRY_COOLDOWN_LOSS' ||
    r === 'COOLDOWN_AFTER_LOSS' ||
    reason.toUpperCase().includes('TOKEN_REENTRY') ||
    reason.toUpperCase().includes('COOLDOWN_AFTER_LOSS')
  )
    return 'skips_token_cooldown';
  // Rate/capacity limits
  if (
    r === 'POLICY_MAX_TRADES_PER_HOUR' ||
    r === 'MAX_TRADES_PER_HOUR' ||
    r === 'MAX_TRADES_PER_TOKEN' ||
    r === 'MAX_CONCURRENT_TRADES' ||
    r === 'MAX_CONCURRENT' ||
    reason.toUpperCase().includes('MAX_TRADES')
  )
    return 'skips_max_trades_per_hour';
  if (r === 'POLICY_COOLDOWN' || reason.toUpperCase().includes('POLICY_COOLDOWN'))
    return 'skips_policy_cooldown';
  // Score/data/balance gates and fallback
  if (
    r === 'LOW_SCORE' ||
    r === 'STALE_SCORE' ||
    r === 'SIGNAL_GATE' ||
    r === 'POLICY_VERSION_MISMATCH' ||
    r === 'MARKET_MODE_MISMATCH' ||
    r === 'DUPLICATE_OPEN_PAIR' ||
    r === 'NO_ENTRY_PRICE' ||
    r === 'NO_SNAPSHOT_IDS' ||
    r === 'INSUFFICIENT_BALANCE' ||
    r === 'KILL_SWITCH' ||
    r === 'ACCOUNT_DRAWDOWN' ||
    r === 'MAX_OPEN_TRADES'
  )
    return 'skips_score_below_threshold';
  return 'skips_score_below_threshold';
}

const SKIP_COLUMNS = {
  skips_token_cooldown: 0,
  skips_policy_cooldown: 0,
  skips_max_trades_per_hour: 0,
  skips_entry_filter: 0,
  skips_score_below_threshold: 0,
} as const;

function zeroDelta() {
  return {
    scores_above_min: 0,
    scores_above_priority: 0,
    entry_filters_passed: 0,
    trades_opened: 0,
    trades_closed: 0,
    wins: 0,
    losses: 0,
    ...SKIP_COLUMNS,
    sum_trade_score: 0,
    count_trade_score: 0,
    sum_blocked_trade_score: 0,
    count_blocked_trade_score: 0,
  };
}

function runCycle(): number {
  let rowsProcessed = 0;
  const policyThresholds = db
    .prepare(
      `SELECT policy_version, min_trade_score, priority_trade_score FROM policies WHERE policy_version IN (SELECT DISTINCT policy_version FROM pair_scores) ORDER BY policy_id DESC`
    )
    .all() as { policy_version: string; min_trade_score: number | null; priority_trade_score: number | null }[];
  const minByPolicy = new Map<string, number>();
  const priorityByPolicy = new Map<string, number>();
  for (const p of policyThresholds) {
    if (!minByPolicy.has(p.policy_version))
      minByPolicy.set(p.policy_version, p.min_trade_score ?? 70);
    if (!priorityByPolicy.has(p.policy_version))
      priorityByPolicy.set(p.policy_version, p.priority_trade_score ?? 85);
  }

  // 1) pair_scores
  const lastScores = getOrCreateOffset('pair_scores');
  const newScores = db
    .prepare(
      `SELECT id, scored_at, policy_version, eligible, total_score FROM pair_scores WHERE id > $afterId ORDER BY id ASC`
    )
    .all({ afterId: lastScores }) as { id: number; scored_at: number; policy_version: string; eligible: number; total_score: number | null }[];
  let maxScoreId = lastScores;
  const scoreBuckets = new Map<string, ReturnType<typeof zeroDelta>>();
  for (const row of newScores) {
    maxScoreId = Math.max(maxScoreId, row.id);
    const bucket = hourBucket(row.scored_at);
    const key = `${bucket}\t${row.policy_version}`;
    if (!scoreBuckets.has(key)) scoreBuckets.set(key, zeroDelta());
    const d = scoreBuckets.get(key)!;
    const minS = minByPolicy.get(row.policy_version) ?? 70;
    const priS = priorityByPolicy.get(row.policy_version) ?? 85;
    const score = row.total_score ?? 0;
    if (score >= minS) d.scores_above_min++;
    if (score >= priS) d.scores_above_priority++;
    if (row.eligible === 1) d.entry_filters_passed++;
  }
  for (const [key, d] of scoreBuckets) {
    const [bucketStart, policyVersion] = key.split('\t');
    upsertHourly.run({
      bucketStart: Number(bucketStart),
      policyVersion,
      scoresAboveMin: d.scores_above_min,
      scoresAbovePriority: d.scores_above_priority,
      entryFiltersPassed: d.entry_filters_passed,
      tradesOpened: d.trades_opened,
      tradesClosed: d.trades_closed,
      wins: d.wins,
      losses: d.losses,
      skipsTokenCooldown: d.skips_token_cooldown,
      skipsPolicyCooldown: d.skips_policy_cooldown,
      skipsMaxTradesPerHour: d.skips_max_trades_per_hour,
      skipsEntryFilter: d.skips_entry_filter,
      skipsScoreBelowThreshold: d.skips_score_below_threshold,
      sumTradeScore: d.sum_trade_score,
      countTradeScore: d.count_trade_score,
      sumBlockedTradeScore: d.sum_blocked_trade_score,
      countBlockedTradeScore: d.count_blocked_trade_score,
    });
  }
  if (newScores.length > 0) setOffset('pair_scores', maxScoreId);
  rowsProcessed += newScores.length;

  // 2) trade_decisions (trades_opened by executed_at)
  const lastDec = getOrCreateOffset('trade_decisions');
  const newDecisions = db
    .prepare(
      `SELECT trade_id, executed_at, policy_version FROM trade_decisions WHERE trade_id > $afterId ORDER BY trade_id ASC`
    )
    .all({ afterId: lastDec }) as { trade_id: number; executed_at: number; policy_version: string }[];
  let maxDecId = lastDec;
  const decBuckets = new Map<string, ReturnType<typeof zeroDelta>>();
  for (const row of newDecisions) {
    maxDecId = Math.max(maxDecId, row.trade_id);
    const bucket = hourBucket(row.executed_at);
    const key = `${bucket}\t${row.policy_version}`;
    if (!decBuckets.has(key)) decBuckets.set(key, zeroDelta());
    decBuckets.get(key)!.trades_opened++;
  }
  for (const [key, d] of decBuckets) {
    const [bucketStart, policyVersion] = key.split('\t');
    upsertHourly.run({
      bucketStart: Number(bucketStart),
      policyVersion,
      scoresAboveMin: d.scores_above_min,
      scoresAbovePriority: d.scores_above_priority,
      entryFiltersPassed: d.entry_filters_passed,
      tradesOpened: d.trades_opened,
      tradesClosed: d.trades_closed,
      wins: d.wins,
      losses: d.losses,
      skipsTokenCooldown: d.skips_token_cooldown,
      skipsPolicyCooldown: d.skips_policy_cooldown,
      skipsMaxTradesPerHour: d.skips_max_trades_per_hour,
      skipsEntryFilter: d.skips_entry_filter,
      skipsScoreBelowThreshold: d.skips_score_below_threshold,
      sumTradeScore: d.sum_trade_score,
      countTradeScore: d.count_trade_score,
      sumBlockedTradeScore: d.sum_blocked_trade_score,
      countBlockedTradeScore: d.count_blocked_trade_score,
    });
  }
  if (newDecisions.length > 0) setOffset('trade_decisions', maxDecId);
  rowsProcessed += newDecisions.length;

  // 3) trades (on close: trades_closed, wins/losses, avg_trade_score from ai_score_at_entry)
  const lastTrade = getOrCreateOffset('trades');
  const newTrades = db
    .prepare(
      `SELECT trade_id, exit_time, policy_version, pnl_pct, ai_score_at_entry FROM trades WHERE trade_id > $afterId ORDER BY trade_id ASC`
    )
    .all({ afterId: lastTrade }) as {
      trade_id: number;
      exit_time: number;
      policy_version: string;
      pnl_pct: number | null;
      ai_score_at_entry: number | null;
    }[];
  let maxTradeId = lastTrade;
  const tradeBuckets = new Map<string, ReturnType<typeof zeroDelta>>();
  for (const row of newTrades) {
    maxTradeId = Math.max(maxTradeId, row.trade_id);
    const bucket = hourBucket(row.exit_time);
    const key = `${bucket}\t${row.policy_version}`;
    if (!tradeBuckets.has(key)) tradeBuckets.set(key, zeroDelta());
    const d = tradeBuckets.get(key)!;
    d.trades_closed++;
    if (row.pnl_pct != null && Number.isFinite(row.pnl_pct)) {
      if (row.pnl_pct > 0) d.wins++;
      else if (row.pnl_pct < 0) d.losses++;
    }
    if (row.ai_score_at_entry != null && Number.isFinite(row.ai_score_at_entry)) {
      d.sum_trade_score += row.ai_score_at_entry;
      d.count_trade_score++;
    }
  }
  for (const [key, d] of tradeBuckets) {
    const [bucketStart, policyVersion] = key.split('\t');
    upsertHourly.run({
      bucketStart: Number(bucketStart),
      policyVersion,
      scoresAboveMin: d.scores_above_min,
      scoresAbovePriority: d.scores_above_priority,
      entryFiltersPassed: d.entry_filters_passed,
      tradesOpened: d.trades_opened,
      tradesClosed: d.trades_closed,
      wins: d.wins,
      losses: d.losses,
      skipsTokenCooldown: d.skips_token_cooldown,
      skipsPolicyCooldown: d.skips_policy_cooldown,
      skipsMaxTradesPerHour: d.skips_max_trades_per_hour,
      skipsEntryFilter: d.skips_entry_filter,
      skipsScoreBelowThreshold: d.skips_score_below_threshold,
      sumTradeScore: d.sum_trade_score,
      countTradeScore: d.count_trade_score,
      sumBlockedTradeScore: d.sum_blocked_trade_score,
      countBlockedTradeScore: d.count_blocked_trade_score,
    });
  }
  if (newTrades.length > 0) setOffset('trades', maxTradeId);
  rowsProcessed += newTrades.length;

  // 4) trade_decision_skips
  const lastSkips = getOrCreateOffset('trade_decision_skips');
  const newSkips = db
    .prepare(
      `SELECT id, decided_at, policy_version, reason FROM trade_decision_skips WHERE id > $afterId ORDER BY id ASC`
    )
    .all({ afterId: lastSkips }) as { id: number; decided_at: number; policy_version: string; reason: string }[];
  let maxSkipId = lastSkips;
  const skipBuckets = new Map<string, ReturnType<typeof zeroDelta>>();
  for (const row of newSkips) {
    maxSkipId = Math.max(maxSkipId, row.id);
    const bucket = hourBucket(row.decided_at);
    const key = `${bucket}\t${row.policy_version}`;
    if (!skipBuckets.has(key)) skipBuckets.set(key, zeroDelta());
    const d = skipBuckets.get(key)!;
    const col = mapSkipReasonToColumn(row.reason);
    d[col]++;
  }
  for (const [key, d] of skipBuckets) {
    const [bucketStart, policyVersion] = key.split('\t');
    upsertHourly.run({
      bucketStart: Number(bucketStart),
      policyVersion,
      scoresAboveMin: d.scores_above_min,
      scoresAbovePriority: d.scores_above_priority,
      entryFiltersPassed: d.entry_filters_passed,
      tradesOpened: d.trades_opened,
      tradesClosed: d.trades_closed,
      wins: d.wins,
      losses: d.losses,
      skipsTokenCooldown: d.skips_token_cooldown,
      skipsPolicyCooldown: d.skips_policy_cooldown,
      skipsMaxTradesPerHour: d.skips_max_trades_per_hour,
      skipsEntryFilter: d.skips_entry_filter,
      skipsScoreBelowThreshold: d.skips_score_below_threshold,
      sumTradeScore: d.sum_trade_score,
      countTradeScore: d.count_trade_score,
      sumBlockedTradeScore: d.sum_blocked_trade_score,
      countBlockedTradeScore: d.count_blocked_trade_score,
    });
  }
  if (newSkips.length > 0) setOffset('trade_decision_skips', maxSkipId);
  rowsProcessed += newSkips.length;

  // 5) entry_filter_rejections -> skips_entry_filter
  const lastRej = getOrCreateOffset('entry_filter_rejections');
  const newRej = db
    .prepare(
      `SELECT id, decided_at, policy_version FROM entry_filter_rejections WHERE id > $afterId ORDER BY id ASC`
    )
    .all({ afterId: lastRej }) as { id: number; decided_at: number; policy_version: string }[];
  let maxRejId = lastRej;
  const rejBuckets = new Map<string, ReturnType<typeof zeroDelta>>();
  for (const row of newRej) {
    maxRejId = Math.max(maxRejId, row.id);
    const bucket = hourBucket(row.decided_at);
    const key = `${bucket}\t${row.policy_version}`;
    if (!rejBuckets.has(key)) rejBuckets.set(key, zeroDelta());
    rejBuckets.get(key)!.skips_entry_filter++;
  }
  for (const [key, d] of rejBuckets) {
    const [bucketStart, policyVersion] = key.split('\t');
    upsertHourly.run({
      bucketStart: Number(bucketStart),
      policyVersion,
      scoresAboveMin: d.scores_above_min,
      scoresAbovePriority: d.scores_above_priority,
      entryFiltersPassed: d.entry_filters_passed,
      tradesOpened: d.trades_opened,
      tradesClosed: d.trades_closed,
      wins: d.wins,
      losses: d.losses,
      skipsTokenCooldown: d.skips_token_cooldown,
      skipsPolicyCooldown: d.skips_policy_cooldown,
      skipsMaxTradesPerHour: d.skips_max_trades_per_hour,
      skipsEntryFilter: d.skips_entry_filter,
      skipsScoreBelowThreshold: d.skips_score_below_threshold,
      sumTradeScore: d.sum_trade_score,
      countTradeScore: d.count_trade_score,
      sumBlockedTradeScore: d.sum_blocked_trade_score,
      countBlockedTradeScore: d.count_blocked_trade_score,
    });
  }
  if (newRej.length > 0) setOffset('entry_filter_rejections', maxRejId);
  rowsProcessed += newRej.length;
  return rowsProcessed;
}

const MAX_DB_RETRIES = 5;
const DB_RETRY_DELAY_MS = 500;

function isDbLockedError(e: unknown): boolean {
  const msg = (e as Error)?.message?.toLowerCase() ?? '';
  const code = (e as { code?: string })?.code;
  return msg.includes('deadlock detected') || msg.includes('could not serialize access') || code === '40P01';
}

function run(): void {
  const runId = Date.now();
  let attempt = 0;
  let rowsProcessed = 0;
  const tryRun = (): void => {
    try {
      rowsProcessed = db.transaction(runCycle)();
    } catch (e) {
      if (isDbLockedError(e) && attempt < MAX_DB_RETRIES) {
        attempt++;
        const delay = DB_RETRY_DELAY_MS * attempt;
        console.warn('[policy-analytics-worker] DB contention, retry %d/%d in %dms', attempt, MAX_DB_RETRIES, delay);
        setTimeout(tryRun, delay);
        return;
      }
      console.error('[policy-analytics-worker] cycle failed', { runId, err: (e as Error).message });
      scheduleNext(0);
      return;
    }
    const nextDelay =
      rowsProcessed >= BACKFILL_BACKLOG_THRESHOLD ? CATCHUP_INTERVAL_MS : RUN_INTERVAL_MS;
    if (rowsProcessed > 0 && rowsProcessed >= BACKFILL_BACKLOG_THRESHOLD) {
      console.log('[policy-analytics-worker] backfill catch-up: processed %d rows, next run in %ds', rowsProcessed, nextDelay / 1000);
    }
    scheduleNext(nextDelay);
  };
  function scheduleNext(ms: number): void {
    setTimeout(run, ms);
  }
  tryRun();
}

console.log(
  '[policy-analytics-worker] starting (interval %ds, backfill on startup, catch-up when backlog >= %d)',
  RUN_INTERVAL_MS / 1000,
  BACKFILL_BACKLOG_THRESHOLD
);
// Run one cycle immediately to backfill any data missed while worker was down
setTimeout(run, 0);
