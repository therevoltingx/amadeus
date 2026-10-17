/**
 * Backtest worker: polls backtest_runs where status = 'queued', runs the engine, writes results.
 * Read-only with respect to live trading tables; only writes to backtest_* tables.
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';
import { runBacktest } from '../backtesting/engine.js';
import { computeRollingVolumeBaselines } from '../rolling-volume-baselines.js';
import type { BacktestSnapshotRow, PolicyConfig } from '../types/backtest.js';

const POLL_INTERVAL_MS = 5000;

function policyRowToConfig(row: Record<string, unknown>): PolicyConfig {
  const n = (v: unknown): number | null => (v != null && typeof v === 'number' && Number.isFinite(v) ? v : null);
  const s = (v: unknown): string | null => (v != null && typeof v === 'string' ? v : null);
  const boolOrInt = (v: unknown): boolean | number | null =>
    v == null ? null : v === true || v === 1 ? true : v === false || v === 0 ? false : null;
  return {
    policy_version: (row.policy_version as string) ?? 'backtest',
    allowed_dexes: s(row.allowed_dexes),
    max_pair_age_seconds: n(row.max_pair_age_seconds),
    min_token_age_seconds: n(row.min_token_age_seconds),
    min_price_change_1m_pct: n(row.min_price_change_1m_pct),
    max_trades_per_hour: n(row.max_trades_per_hour),
    max_concurrent_trades: n(row.max_concurrent_trades),
    cooldown_seconds_after_loss: n(row.cooldown_seconds_after_loss),
    risk_per_trade_pct: n(row.risk_per_trade_pct),
    time_stop_seconds: n(row.time_stop_seconds),
    stop_loss_pct: n(row.stop_loss_pct),
    take_profit_pct: n(row.take_profit_pct),
    cooldown_on_consecutive_losses: n(row.cooldown_on_consecutive_losses),
    cooldown_on_consecutive_losses_seconds: n(row.cooldown_on_consecutive_losses_seconds),
    pair_loss_cooldown_seconds: n(row.pair_loss_cooldown_seconds),
    max_consecutive_losses_per_pair: n(row.max_consecutive_losses_per_pair),
    token_reentry_cooldown_seconds: n(row.token_reentry_cooldown_seconds),
    token_reentry_cooldown_seconds_after_win: n(row.token_reentry_cooldown_seconds_after_win),
    max_trades_per_token_per_hour: n(row.max_trades_per_token_per_hour),
    priority_trade_score: n(row.priority_trade_score),
    min_trade_score: n(row.min_trade_score),
    volume_collapse_exit_enabled: boolOrInt(row.volume_collapse_exit_enabled),
    volume_collapse_ratio_threshold: n(row.volume_collapse_ratio_threshold),
    volume_collapse_consecutive_checks: n(row.volume_collapse_consecutive_checks),
    volume_collapse_min_samples: n(row.volume_collapse_min_samples),
    liquidity_trend_guard_enabled: boolOrInt(row.liquidity_trend_guard_enabled),
    max_liquidity_drop_pct_30m: n(row.max_liquidity_drop_pct_30m),
    max_liquidity_drop_pct_1h: n(row.max_liquidity_drop_pct_1h),
    liquidity_trend_min_samples: n(row.liquidity_trend_min_samples),
    rug_exit_enabled: boolOrInt(row.rug_exit_enabled),
    rug_liquidity_floor_usd: n(row.rug_liquidity_floor_usd),
    rug_snapshot_stale_seconds: n(row.rug_snapshot_stale_seconds),
    rug_pair_missing_threshold: n(row.rug_pair_missing_threshold),
  };
}

const getNextQueued = db.prepare(`
  SELECT id, policy_version, policy_config, start_time, end_time
  FROM backtest_runs
  WHERE status = 'queued'
  ORDER BY created_at ASC
  LIMIT 1
`);

const setRunning = db.prepare(`UPDATE backtest_runs SET status = 'running' WHERE id = $id`);
const setCompleted = db.prepare(`UPDATE backtest_runs SET status = 'completed', completed_at = $completedAt WHERE id = $id`);
const setFailed = db.prepare(`UPDATE backtest_runs SET status = 'failed', completed_at = $completedAt WHERE id = $id`);

const insertTrade = db.prepare(`
  INSERT INTO backtest_trades (backtest_run_id, pair_address, entry_time, exit_time, entry_price, exit_price, result, exit_reason, pnl, hold_time_seconds, last_volume_ratio)
  VALUES ($backtestRunId, $pairAddress, $entryTime, $exitTime, $entryPrice, $exitPrice, $result, $exitReason, $pnl, $holdTimeSeconds, $lastVolumeRatio)
`);
const insertDiagnostic = db.prepare(`
  INSERT INTO backtest_entry_diagnostics (backtest_run_id, pair_address, timestamp, allowed, failed_checks, score, policy_version)
  VALUES ($backtestRunId, $pairAddress, $timestamp, $allowed, $failedChecks, $score, $policyVersion)
`);
const insertMetrics = db.prepare(`
  INSERT INTO backtest_metrics (backtest_run_id, trades, wins, losses, win_rate, avg_pnl, max_drawdown, avg_hold_time_seconds, entry_diagnostics_summary)
  VALUES ($backtestRunId, $trades, $wins, $losses, $winRate, $avgPnl, $maxDrawdown, $avgHoldTimeSeconds, $entryDiagnosticsSummary)
`);

type SnapshotRow = {
  snapshot_id: number;
  pair_address: string;
  timestamp: number;
  price_usd: number | null;
  volume_5m: number | null;
  rolling_avg_volume_5m: number | null;
  rolling_avg_volume_30m: number | null;
  rolling_avg_volume_1h: number | null;
  rolling_volume_sample_count: number | null;
};

function getSnapshots(startTime: number, endTime: number): BacktestSnapshotRow[] {
  const rows = db.prepare(
    `SELECT snapshot_id, pair_address, timestamp, price_usd, volume_5m, seconds_since_creation,
            liquidity_change_pct_30m, liquidity_change_pct_1h, liquidity_sample_count,
            rolling_avg_volume_5m, rolling_avg_volume_30m, rolling_avg_volume_1h, rolling_volume_sample_count,
            liquidity_usd, price_change_1m
     FROM pair_snapshots
     WHERE timestamp >= $startTime AND timestamp <= $endTime AND price_usd IS NOT NULL
     ORDER BY timestamp ASC`
  ).all({ startTime, endTime }) as (SnapshotRow & {
    seconds_since_creation: number | null;
    liquidity_change_pct_30m: number | null;
    liquidity_change_pct_1h: number | null;
    liquidity_sample_count: number | null;
    liquidity_usd?: number | null;
    price_change_1m: number | null;
  })[];
  // Fill rolling fields on the fly when missing (deterministic for historical data).
  return rows.map((s) => {
    const hasRolling = s.rolling_avg_volume_1h != null || s.rolling_volume_sample_count != null;
    const base = {
      snapshot_id: s.snapshot_id,
      pair_address: s.pair_address,
      timestamp: s.timestamp,
      price_usd: s.price_usd,
      volume_5m: s.volume_5m,
      seconds_since_creation: s.seconds_since_creation ?? undefined,
      liquidity_change_pct_30m: s.liquidity_change_pct_30m ?? undefined,
      liquidity_change_pct_1h: s.liquidity_change_pct_1h ?? undefined,
      liquidity_sample_count: s.liquidity_sample_count ?? undefined,
      liquidity_usd: s.liquidity_usd ?? undefined,
      price_change_1m:
        s.price_change_1m != null && Number.isFinite(s.price_change_1m) ? s.price_change_1m : undefined,
    };
    if (hasRolling) {
      return {
        ...base,
        rolling_avg_volume_5m: s.rolling_avg_volume_5m,
        rolling_avg_volume_30m: s.rolling_avg_volume_30m,
        rolling_avg_volume_1h: s.rolling_avg_volume_1h,
        rolling_volume_sample_count: s.rolling_volume_sample_count,
      };
    }
    const rolled = computeRollingVolumeBaselines(s.pair_address, s.timestamp);
    return {
      ...base,
      rolling_avg_volume_5m: rolled.avg_5m,
      rolling_avg_volume_30m: rolled.avg_30m,
      rolling_avg_volume_1h: rolled.avg_1h,
      rolling_volume_sample_count: rolled.sample_count,
    };
  });
}

function getScores(policyVersion: string, startTime: number, endTime: number): { id: number; pair_address: string; scored_at: number; signal: string; total_score: number | null; snapshot_ids: string | null; market_mode: string | null }[] {
  return db.prepare(
    `SELECT id, pair_address, scored_at, signal, total_score, snapshot_ids, market_mode
     FROM pair_scores
     WHERE policy_version = $policyVersion AND eligible = 1 AND scored_at >= $startTime AND scored_at <= $endTime
       AND signal IN ('TRADE_CANDIDATE', 'PRIORITY_TRADE')
     ORDER BY scored_at ASC`
  ).all({ policyVersion, startTime, endTime }) as { id: number; pair_address: string; scored_at: number; signal: string; total_score: number | null; snapshot_ids: string | null; market_mode: string | null }[];
}

function getPairToTokenMint(): Map<string, string> {
  const rows = db.prepare('SELECT pair_address, base_token_address FROM pairs').all() as { pair_address: string; base_token_address: string }[];
  const m = new Map<string, string>();
  for (const r of rows) {
    if (r.base_token_address != null && r.base_token_address !== '') m.set(r.pair_address, r.base_token_address);
  }
  return m;
}

function processOneRun(): boolean {
  const run = getNextQueued.get() as { id: number; policy_version: string | null; policy_config: string | null; start_time: number; end_time: number } | undefined;
  if (!run) return false;

  const runId = run.id;
  const startTime = run.start_time;
  const endTime = run.end_time;

  setRunning.run({ id: runId });

  let config: PolicyConfig;
  let policyVersionLabel: string;
  let scorePolicyVersion: string;

  if (run.policy_version != null && run.policy_version.trim().length > 0) {
    const row = db.prepare(
      `SELECT policy_version, allowed_dexes, max_pair_age_seconds, min_token_age_seconds,
        max_trades_per_hour, max_concurrent_trades, cooldown_seconds_after_loss,
        risk_per_trade_pct, time_stop_seconds, stop_loss_pct, take_profit_pct,
        cooldown_on_consecutive_losses, cooldown_on_consecutive_losses_seconds,
        pair_loss_cooldown_seconds, max_consecutive_losses_per_pair,
        token_reentry_cooldown_seconds, token_reentry_cooldown_seconds_after_win, max_trades_per_token_per_hour,
        priority_trade_score, min_trade_score,
        volume_collapse_exit_enabled, volume_collapse_ratio_threshold, volume_collapse_consecutive_checks, volume_collapse_min_samples,
        liquidity_trend_guard_enabled, max_liquidity_drop_pct_30m, max_liquidity_drop_pct_1h, liquidity_trend_min_samples,
        rug_exit_enabled, rug_liquidity_floor_usd, rug_snapshot_stale_seconds, rug_pair_missing_threshold
       FROM policies WHERE policy_version = $policyVersion`
    ).get({ policyVersion: run.policy_version }) as Record<string, unknown> | undefined;
    if (!row) {
      const now = Math.floor(Date.now() / 1000);
      setFailed.run({ completedAt: now, id: runId });
      console.error(`[backtest-worker] Run ${runId}: policy not found ${run.policy_version}`);
      return true;
    }
    config = policyRowToConfig(row);
    policyVersionLabel = config.policy_version;
    scorePolicyVersion = config.policy_version;
  } else if (run.policy_config != null && run.policy_config.trim().length > 0) {
    try {
      config = JSON.parse(run.policy_config) as PolicyConfig;
    } catch (e) {
      const now = Math.floor(Date.now() / 1000);
      setFailed.run({ completedAt: now, id: runId });
      console.error(`[backtest-worker] Run ${runId}: invalid policy_config JSON`, e);
      return true;
    }
    policyVersionLabel = 'Hypothetical';
    const first = db.prepare("SELECT policy_version FROM policies WHERE status = 'active' LIMIT 1").get() as { policy_version: string } | undefined;
    if (!first) {
      const now = Math.floor(Date.now() / 1000);
      setFailed.run({ completedAt: now, id: runId });
      console.error(`[backtest-worker] Run ${runId}: no active policy for score source`);
      return true;
    }
    scorePolicyVersion = first.policy_version;
  } else {
    const now = Math.floor(Date.now() / 1000);
    setFailed.run({ completedAt: now, id: runId });
    console.error(`[backtest-worker] Run ${runId}: missing policy_version and policy_config`);
    return true;
  }

  try {
    const snapshots = getSnapshots(startTime, endTime);
    const scores = getScores(scorePolicyVersion, startTime, endTime);
    const pairToTokenMint = getPairToTokenMint();

    const snapshotPriceById = new Map<number, number>();
    for (const s of snapshots) {
      if (s.price_usd != null && Number.isFinite(s.price_usd)) snapshotPriceById.set(s.snapshot_id, s.price_usd);
    }

    const { trades, metrics, diagnostics } = runBacktest({
      policyConfig: config,
      policyVersionLabel,
      startTime,
      endTime,
      snapshots: snapshots.map((s) => ({
        snapshot_id: s.snapshot_id,
        pair_address: s.pair_address,
        timestamp: s.timestamp,
        price_usd: s.price_usd,
        volume_5m: s.volume_5m,
        seconds_since_creation: (s as BacktestSnapshotRow).seconds_since_creation ?? undefined,
        liquidity_change_pct_30m: (s as BacktestSnapshotRow).liquidity_change_pct_30m ?? undefined,
        liquidity_change_pct_1h: (s as BacktestSnapshotRow).liquidity_change_pct_1h ?? undefined,
        liquidity_sample_count: (s as BacktestSnapshotRow).liquidity_sample_count ?? undefined,
        rolling_avg_volume_5m: s.rolling_avg_volume_5m,
        rolling_avg_volume_30m: s.rolling_avg_volume_30m,
        rolling_avg_volume_1h: s.rolling_avg_volume_1h,
        rolling_volume_sample_count: s.rolling_volume_sample_count,
      })),
      scores: scores.map((s) => ({
        id: s.id,
        pair_address: s.pair_address,
        scored_at: s.scored_at,
        signal: s.signal,
        total_score: s.total_score,
        snapshot_ids: s.snapshot_ids,
        market_mode: s.market_mode,
      })),
      pairToTokenMint,
      snapshotPriceById,
    });

    const now = Math.floor(Date.now() / 1000);
    const summaryJson =
      metrics.entry_diagnostics_summary != null
        ? JSON.stringify(metrics.entry_diagnostics_summary)
        : null;
    db.transaction(() => {
      for (const d of diagnostics) {
        insertDiagnostic.run({
          backtestRunId: runId,
          pairAddress: d.pair_address,
          timestamp: d.timestamp,
          allowed: d.allowed ? 1 : 0,
          failedChecks: JSON.stringify(d.failed_checks),
          score: d.score,
          policyVersion: d.policy_version,
        });
      }
      for (const t of trades) {
        insertTrade.run({
          backtestRunId: runId,
          pairAddress: t.pair_address,
          entryTime: t.entry_time,
          exitTime: t.exit_time,
          entryPrice: t.entry_price,
          exitPrice: t.exit_price,
          result: t.result,
          exitReason: t.exit_reason,
          pnl: t.pnl,
          holdTimeSeconds: t.hold_time_seconds,
          lastVolumeRatio: t.last_volume_ratio ?? null,
        });
      }
      insertMetrics.run({
        backtestRunId: runId,
        trades: metrics.trades,
        wins: metrics.wins,
        losses: metrics.losses,
        winRate: metrics.win_rate,
        avgPnl: metrics.avg_pnl,
        maxDrawdown: metrics.max_drawdown,
        avgHoldTimeSeconds: metrics.avg_hold_time_seconds,
        entryDiagnosticsSummary: summaryJson,
      });
      setCompleted.run({ completedAt: now, id: runId });
    })();

    console.log(
      JSON.stringify({
        event: 'backtest_completed',
        run_id: runId,
        trades: metrics.trades,
        win_rate: metrics.win_rate,
        avg_pnl: metrics.avg_pnl,
      })
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const now = Math.floor(Date.now() / 1000);
    setFailed.run({ completedAt: now, id: runId });
    console.error(`[backtest-worker] Run ${runId} failed:`, msg);
  }

  return true;
}

async function runLoop(): Promise<void> {
  console.log(
    JSON.stringify({
      event: 'backtest_worker_started',
      poll_interval_ms: POLL_INTERVAL_MS,
    })
  );
  while (true) {
    try {
      while (processOneRun()) {
        // process until queue empty
      }
    } catch (e) {
      console.error('[backtest-worker] Error in cycle:', e);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

export function startBacktestWorker(): void {
  void runLoop().catch((err) => {
    console.error('[backtest-worker] Fatal:', err);
    process.exit(1);
  });
}

const isMain =
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1]?.endsWith('backtest-worker.js');

if (isMain) {
  startBacktestWorker();
}
