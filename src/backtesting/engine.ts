/**
 * Deterministic backtest engine. Read-only replay over historical snapshots and scores.
 * Does not read from policies table; accepts a fully-resolved PolicyConfig.
 */
import type { MarketMode } from '../market-mode.js';
import { isFeatureSupported, resolveMarketMode } from '../market-mode.js';
import { computeVolumePersistence } from '../rolling-volume-baselines.js';
import {
  ENTRY_REJECTION_REASONS,
  type BacktestEntryDiagnostic,
  type BacktestExitReason,
  type BacktestMetrics,
  type EntryDiagnosticsSummary,
  type BacktestSnapshotRow,
  type BacktestScoreRow,
  type BacktestTrade,
  type PolicyConfig,
} from '../types/backtest.js';
import { computePositionSizeUsd } from '../position-sizing.js';
import { evaluateRugExit } from '../rug-exit.js';

const SIM_STARTING_EQUITY = 100;
/** Account-level portfolio heat cap for backtest (parity with live default). */
const BACKTEST_MAX_TOTAL_RISK_PCT = 15;

type ExitReason = BacktestExitReason;

interface OpenPosition {
  pair_address: string;
  token_mint: string | null;
  entry_time: number;
  entry_price: number;
  position_size_usd: number;
  entry_snapshot_id: number | null;
  market_mode: string;
  consecutive_volume_collapse_count: number;
  last_volume_ratio: number | null;
  pair_missing_failures: number;
  last_snapshot_timestamp: number | null;
}

interface TokenStats {
  last_loss_at: number | null;
  consecutive_losses: number;
  last_exit_at: number | null;
  last_trade_outcome: string | null;
  trades_in_window: number;
  window_start: number;
}

function isSameCalendarDay(unixA: number, unixB: number): boolean {
  const dA = new Date(unixA * 1000);
  const dB = new Date(unixB * 1000);
  return (
    dA.getFullYear() === dB.getFullYear() &&
    dA.getMonth() === dB.getMonth() &&
    dA.getDate() === dB.getDate()
  );
}

/** Open risk from current open positions (same formula as live). */
function openRiskPctBacktest(
  openPositions: OpenPosition[],
  stopLossPct: number | null,
  accountEquity: number
): number {
  if (!Number.isFinite(accountEquity) || accountEquity <= 0) return 0;
  const stopDist = stopLossPct != null && Number.isFinite(stopLossPct) ? Math.abs(stopLossPct) / 100 : 0;
  let totalRiskUsd = 0;
  for (const pos of openPositions) {
    totalRiskUsd += pos.position_size_usd * stopDist;
  }
  return (totalRiskUsd / accountEquity) * 100;
}

export interface EvaluateExitResult {
  shouldExit: boolean;
  exitReason?: ExitReason;
  /** Updated collapse state to apply to position when not exiting. */
  volumeCollapseState?: { consecutive: number; lastRatio: number | null };
  last_volume_ratio?: number | null;
}

function evaluateExit(
  pos: OpenPosition,
  config: PolicyConfig,
  currentPrice: number,
  now: number,
  snapshot: BacktestSnapshotRow | null
): EvaluateExitResult {
  const pnlPct =
    pos.entry_price !== 0
      ? ((currentPrice - pos.entry_price) / pos.entry_price) * 100
      : 0;
  const stopLossPct = config.stop_loss_pct;
  const takeProfitPct = config.take_profit_pct;
  const timeStopSec = config.time_stop_seconds;

  if (stopLossPct != null && Number.isFinite(stopLossPct) && pnlPct <= stopLossPct) {
    return { shouldExit: true, exitReason: 'STOP_LOSS' };
  }
  if (takeProfitPct != null && Number.isFinite(takeProfitPct) && pnlPct >= takeProfitPct) {
    return { shouldExit: true, exitReason: 'TAKE_PROFIT' };
  }

  let volumeCollapseState: { consecutive: number; lastRatio: number | null } | undefined;
  const collapseEnabled =
    config.volume_collapse_exit_enabled === true ||
    config.volume_collapse_exit_enabled === 1;
  const collapseThreshold = config.volume_collapse_ratio_threshold ?? 0.35;
  const collapseChecks = config.volume_collapse_consecutive_checks ?? 2;
  const minSamples = config.volume_collapse_min_samples ?? 6;

  if (collapseEnabled && snapshot != null) {
    const ratio = computeVolumePersistence(
      {
        volume_5m: snapshot.volume_5m ?? undefined,
        volume_5m_usd: snapshot.volume_5m ?? undefined,
        rolling_avg_volume_1h: snapshot.rolling_avg_volume_1h ?? undefined,
        rolling_volume_sample_count: snapshot.rolling_volume_sample_count ?? undefined,
      },
      minSamples
    );
    if (ratio != null) {
      const belowThreshold = ratio < collapseThreshold;
      const newConsecutive = belowThreshold ? pos.consecutive_volume_collapse_count + 1 : 0;
      volumeCollapseState = { consecutive: newConsecutive, lastRatio: ratio };
      if (newConsecutive >= collapseChecks) {
        return { shouldExit: true, exitReason: 'VOLUME_COLLAPSE', last_volume_ratio: ratio };
      }
    }
  }

  if (timeStopSec != null && timeStopSec > 0 && now - pos.entry_time >= timeStopSec) {
    return { shouldExit: true, exitReason: 'TIME_STOP' };
  }
  return { shouldExit: false, ...(volumeCollapseState != null && { volumeCollapseState }) };
}

export interface RunBacktestInput {
  policyConfig: PolicyConfig;
  /** Label for this run (e.g. policy_version or 'hypothetical') */
  policyVersionLabel: string;
  startTime: number;
  endTime: number;
  snapshots: BacktestSnapshotRow[];
  scores: BacktestScoreRow[];
  /** pair_address -> token_mint (base_token_address) */
  pairToTokenMint: Map<string, string>;
  /** snapshot_id -> price_usd */
  snapshotPriceById: Map<number, number>;
}

export interface RunBacktestResult {
  trades: BacktestTrade[];
  metrics: BacktestMetrics;
  diagnostics: BacktestEntryDiagnostic[];
}

/** Simulated state at a point in time for entry evaluation */
export interface EntryEvaluationState {
  openCount: number;
  countInLastHour: number;
  lastLossExitTime: number | null;
  policyCooldownUntil: number | null;
  hasOpenForToken: boolean;
  tokenMint: string | null;
  tokenStats: TokenStats | null;
  availableBalance: number;
  now: number;
}

export interface EvaluateEntryResult {
  allowed: boolean;
  failed_checks: string[];
}

const R = ENTRY_REJECTION_REASONS;

/**
 * Evaluate all entry checks; do not early-return. Populate failed_checks with every blocking reason.
 * Used only by backtest engine; live trading is unchanged.
 * @param pairAgeSeconds - Age of pair/token at score time (from snapshot). Used for min/max age entry filters.
 * @param liquidityMetrics - Optional liquidity trend from snapshot for liquidity_drain guard.
 * @param entryPriceChange1mPct - Optional price_change_1m from entry snapshot for min_price_change_1m_pct.
 */
export function evaluateEntry(
  config: PolicyConfig,
  score: BacktestScoreRow,
  state: EntryEvaluationState,
  marketMode: MarketMode,
  snapshotPriceById: Map<number, number>,
  policyVersionLabel: string,
  pairAgeSeconds?: number | null,
  liquidityMetrics?: { liquidity_change_pct_30m: number | null; liquidity_change_pct_1h: number | null; liquidity_sample_count: number | null },
  entryPriceChange1mPct?: number | null
): EvaluateEntryResult {
  const failed_checks: string[] = [];
  const {
    openCount,
    countInLastHour,
    lastLossExitTime,
    policyCooldownUntil,
    hasOpenForToken,
    tokenMint,
    tokenStats,
    availableBalance,
    now,
  } = state;

  if (pairAgeSeconds != null) {
    const minAge = config.min_token_age_seconds;
    if (minAge != null && pairAgeSeconds < minAge) {
      failed_checks.push(R.MIN_TOKEN_AGE);
    }
    const maxAge = config.max_pair_age_seconds;
    if (maxAge != null && pairAgeSeconds > maxAge) {
      failed_checks.push(R.PAIR_TOO_OLD);
    }
  }

  const guardEnabled = config.liquidity_trend_guard_enabled === true || config.liquidity_trend_guard_enabled === 1;
  if (guardEnabled && liquidityMetrics != null) {
    const minSamples = config.liquidity_trend_min_samples ?? 6;
    const sampleCount = liquidityMetrics.liquidity_sample_count ?? 0;
    if (sampleCount >= minSamples) {
      const maxDrop30m = config.max_liquidity_drop_pct_30m ?? -0.25;
      const maxDrop1h = config.max_liquidity_drop_pct_1h ?? -0.35;
      const change30m = liquidityMetrics.liquidity_change_pct_30m ?? null;
      const change1h = liquidityMetrics.liquidity_change_pct_1h ?? null;
      const drain30m = change30m != null && maxDrop30m != null && change30m <= maxDrop30m;
      const drain1h = change1h != null && maxDrop1h != null && change1h <= maxDrop1h;
      if (drain30m || drain1h) {
        failed_checks.push(R.LIQUIDITY_DRAIN);
      }
    }
  }

  const minPc = config.min_price_change_1m_pct;
  if (
    minPc != null &&
    Number.isFinite(minPc) &&
    isFeatureSupported('price_change_1m', marketMode)
  ) {
    const chg = entryPriceChange1mPct;
    if (chg == null || !Number.isFinite(chg) || chg < minPc) {
      failed_checks.push(R.MIN_PRICE_CHANGE_1M_PCT);
    }
  }

  const scoreNorm = score.total_score != null ? Number(score.total_score) : 0;
  const minTradeScore = config.min_trade_score ?? 70;
  const maxConcurrent = config.max_concurrent_trades ?? 2;
  const maxPerHour = config.max_trades_per_hour ?? 2;
  const cooldownSec = config.cooldown_seconds_after_loss ?? 0;
  const pairLossCooldownSec = config.pair_loss_cooldown_seconds ?? 0;
  const maxConsecutivePerPair = config.max_consecutive_losses_per_pair ?? null;

  if (scoreNorm < minTradeScore) {
    failed_checks.push(R.MIN_SCORE);
  }

  if (policyCooldownUntil != null && now < policyCooldownUntil) {
    failed_checks.push(R.POLICY_COOLDOWN);
  }
  if (openCount >= maxConcurrent) {
    failed_checks.push(R.MAX_CONCURRENT_TRADES);
  }
  if (countInLastHour >= maxPerHour) {
    failed_checks.push(R.MAX_TRADES_PER_HOUR);
  }
  if (cooldownSec > 0 && lastLossExitTime != null && now - lastLossExitTime < cooldownSec) {
    failed_checks.push(R.COOLDOWN_AFTER_LOSS);
  }
  if (hasOpenForToken) {
    failed_checks.push(R.ALREADY_OPEN);
  }

  const scoreMarketMode = (score.market_mode ?? marketMode) as MarketMode;
  if (scoreMarketMode !== marketMode) {
    failed_checks.push(R.MARKET_MODE_MISMATCH);
  }

  if (tokenMint != null && tokenMint !== '') {
    const s = tokenStats;
    if (s) {
      const baseReentry = config.token_reentry_cooldown_seconds ?? 0;
      if (baseReentry > 0 && s.last_exit_at != null && now - s.last_exit_at < baseReentry) {
        failed_checks.push(R.TOKEN_COOLDOWN);
      }
      const maxPerToken = config.max_trades_per_token_per_hour ?? null;
      if (maxPerToken != null && s.trades_in_window >= maxPerToken) {
        failed_checks.push(R.MAX_TRADES_PER_TOKEN);
      }
    }
  }

  if (pairLossCooldownSec > 0 && tokenStats?.last_loss_at != null && now - tokenStats.last_loss_at < pairLossCooldownSec) {
    failed_checks.push(R.PAIR_LOSS_COOLDOWN);
  }
  if (maxConsecutivePerPair != null && maxConsecutivePerPair >= 1 && tokenStats != null) {
    const effective =
      tokenStats.last_loss_at != null && isSameCalendarDay(tokenStats.last_loss_at, now)
        ? tokenStats.consecutive_losses
        : 0;
    if (effective >= maxConsecutivePerPair) {
      failed_checks.push(R.MAX_CONSECUTIVE_LOSSES_PAIR);
    }
  }

  let entryPrice: number | null = null;
  try {
    const idsJson = score.snapshot_ids;
    const ids = idsJson ? (JSON.parse(idsJson) as number[]) : [];
    const firstId = ids[0];
    if (firstId == null) {
      failed_checks.push(R.INSUFFICIENT_DATA);
    } else {
      const price = snapshotPriceById.get(firstId);
      if (price == null || !Number.isFinite(price)) {
        failed_checks.push(R.INSUFFICIENT_DATA);
      } else {
        entryPrice = price;
      }
    }
  } catch {
    failed_checks.push(R.INSUFFICIENT_DATA);
  }

  if (entryPrice != null) {
    const sizing = computePositionSizeUsd({
      account_equity: SIM_STARTING_EQUITY,
      risk_per_trade_pct: config.risk_per_trade_pct,
      stop_loss_pct: config.stop_loss_pct,
      score: score.total_score ?? null,
      min_trade_score: config.min_trade_score,
      priority_trade_score: config.priority_trade_score,
    });
    const positionSize = Math.min(sizing.position_size_usd, availableBalance);
    if (positionSize <= 0) {
      failed_checks.push(R.INSUFFICIENT_BALANCE);
    }
  }

  return {
    allowed: failed_checks.length === 0,
    failed_checks,
  };
}

/**
 * Run a deterministic backtest. Pure function: no DB or I/O.
 */
export function runBacktest(input: RunBacktestInput): RunBacktestResult {
  const {
    policyConfig: config,
    policyVersionLabel: _policyVersionLabel,
    startTime,
    endTime,
    snapshots,
    scores,
    pairToTokenMint,
    snapshotPriceById,
  } = input;

  const marketMode: MarketMode = resolveMarketMode(config);

  type Event = { t: number; type: 'snapshot'; data: BacktestSnapshotRow } | { t: number; type: 'score'; data: BacktestScoreRow };
  const events: Event[] = [];
  for (const s of snapshots) {
    if (s.timestamp >= startTime && s.timestamp <= endTime && s.price_usd != null && Number.isFinite(s.price_usd)) {
      events.push({ t: s.timestamp, type: 'snapshot', data: s });
    }
  }
  for (const s of scores) {
    if (s.scored_at >= startTime && s.scored_at <= endTime) {
      events.push({ t: s.scored_at, type: 'score', data: s });
    }
  }
  events.sort((a, b) => a.t - b.t || (a.type === 'score' ? 0 : 1) - (b.type === 'score' ? 0 : 1));

  let availableBalance = SIM_STARTING_EQUITY;
  const openPositions: OpenPosition[] = [];
  const closedTrades: BacktestTrade[] = [];
  const lastPriceByPair = new Map<string, number>();
  /** Latest snapshot per pair for rug evaluation (and entry snapshot when opening). */
  const lastSnapshotByPair = new Map<string, BacktestSnapshotRow>();

  let lastLossExitTime: number | null = null;
  const tradesExecutedAt: number[] = [];
  let policyCooldownUntil: number | null = null;
  let consecutiveLossCount = 0;
  const tokenStats = new Map<string, TokenStats>();

  const diagnostics: BacktestEntryDiagnostic[] = [];
  const policyVersionLabel = input.policyVersionLabel;
  const maxConcurrent = config.max_concurrent_trades ?? 2;
  const maxPerHour = config.max_trades_per_hour ?? 2;
  const cooldownSec = config.cooldown_seconds_after_loss ?? 0;
  const pairLossCooldownSec = config.pair_loss_cooldown_seconds ?? 0;
  const maxConsecutivePerPair = config.max_consecutive_losses_per_pair ?? null;
  const minTradeScore = config.min_trade_score ?? 70;

  const snapshotById = new Map<number, BacktestSnapshotRow>();
  for (const s of snapshots) {
    snapshotById.set(s.snapshot_id, s);
  }

  function getTokenStats(tokenMint: string): TokenStats {
    let s = tokenStats.get(tokenMint);
    if (!s) {
      s = {
        last_loss_at: null,
        consecutive_losses: 0,
        last_exit_at: null,
        last_trade_outcome: null,
        trades_in_window: 0,
        window_start: 0,
      };
      tokenStats.set(tokenMint, s);
    }
    return s;
  }

  function countInLastHour(now: number): number {
    const cutoff = now - 3600;
    return tradesExecutedAt.filter((at) => at >= cutoff).length;
  }

  function closePosition(
    pos: OpenPosition,
    exitTime: number,
    exitPrice: number,
    exitReason: ExitReason,
    last_volume_ratio?: number | null
  ): void {
    const pnlPct =
      pos.entry_price !== 0
        ? ((exitPrice - pos.entry_price) / pos.entry_price) * 100
        : 0;
    const pnlUsd = pos.position_size_usd * (pnlPct / 100);
    const holdSeconds = exitTime - pos.entry_time;
    availableBalance += pos.position_size_usd + pnlUsd;

    closedTrades.push({
      pair_address: pos.pair_address,
      entry_time: pos.entry_time,
      exit_time: exitTime,
      entry_price: pos.entry_price,
      exit_price: exitPrice,
      result: pnlPct >= 0 ? 'win' : 'loss',
      exit_reason: exitReason,
      pnl: pnlPct,
      hold_time_seconds: holdSeconds,
      last_volume_ratio: last_volume_ratio ?? undefined,
    });

    if (pnlPct < 0) {
      lastLossExitTime = exitTime;
      consecutiveLossCount++;
      const cooldownN = config.cooldown_on_consecutive_losses ?? null;
      const cooldownSec = config.cooldown_on_consecutive_losses_seconds ?? null;
      if (
        cooldownN != null &&
        cooldownN >= 1 &&
        cooldownSec != null &&
        cooldownSec > 0 &&
        consecutiveLossCount >= cooldownN
      ) {
        policyCooldownUntil = exitTime + cooldownSec;
      }
    } else {
      consecutiveLossCount = 0;
    }

    if (pos.token_mint != null && pos.token_mint !== '') {
      const s = getTokenStats(pos.token_mint);
      if (pnlPct < 0) {
        const sameDay = s.last_loss_at != null && isSameCalendarDay(s.last_loss_at, exitTime);
        s.consecutive_losses = sameDay ? s.consecutive_losses + 1 : 1;
        s.last_loss_at = exitTime;
      } else {
        s.consecutive_losses = 0;
        s.last_loss_at = null;
      }
      s.last_exit_at = exitTime;
      s.last_trade_outcome = pnlPct >= 0 ? 'WIN' : 'LOSS';
    }
  }

  for (const ev of events) {
    const now = ev.t;

    if (ev.type === 'snapshot') {
      const snap = ev.data;
      lastPriceByPair.set(snap.pair_address, snap.price_usd!);
      lastSnapshotByPair.set(snap.pair_address, snap);

      // Rug `pair_missing_failures` (PAIR_UNAVAILABLE): live exit worker increments only when
      // *this* pair has no RPC/snapshot data that cycle — not when other pairs update. Do not
      // count unrelated snapshot events here (that spuriously tripped the threshold in replay).
      for (const pos of openPositions) {
        if (pos.pair_address === snap.pair_address) {
          pos.pair_missing_failures = 0;
          pos.last_snapshot_timestamp = snap.timestamp;
        }
      }

      const rugEnabled = config.rug_exit_enabled === true || config.rug_exit_enabled === 1;
      for (let i = openPositions.length - 1; i >= 0; i--) {
        const pos = openPositions[i];
        const latestSnapshot = lastSnapshotByPair.get(pos.pair_address) ?? null;
        const snapshotForRug =
          latestSnapshot == null
            ? null
            : {
                timestamp: latestSnapshot.timestamp,
                liquidity_usd: latestSnapshot.liquidity_usd ?? null,
                price_usd: latestSnapshot.price_usd ?? null,
              };

        if (rugEnabled) {
          const rug = evaluateRugExit({
            trade: {
              pair_missing_failures: pos.pair_missing_failures,
              last_snapshot_timestamp: pos.last_snapshot_timestamp,
            },
            policy: {
              rug_exit_enabled: config.rug_exit_enabled ?? null,
              rug_liquidity_floor_usd: config.rug_liquidity_floor_usd ?? null,
              rug_snapshot_stale_seconds: config.rug_snapshot_stale_seconds ?? null,
              rug_pair_missing_threshold: config.rug_pair_missing_threshold ?? null,
            },
            latestSnapshot: snapshotForRug,
            nowTs: now,
          });
          if (rug.shouldExit && rug.reason) {
            const exitPrice = latestSnapshot?.price_usd != null && Number.isFinite(latestSnapshot.price_usd) ? latestSnapshot.price_usd : pos.entry_price;
            openPositions.splice(i, 1);
            closePosition(pos, now, exitPrice, rug.reason, undefined);
            continue;
          }
        }

        if (pos.pair_address !== snap.pair_address) continue;
        const result = evaluateExit(pos, config, snap.price_usd!, now, snap);
        if (result.volumeCollapseState != null) {
          pos.consecutive_volume_collapse_count = result.volumeCollapseState.consecutive;
          pos.last_volume_ratio = result.volumeCollapseState.lastRatio;
        }
        if (result.shouldExit && result.exitReason) {
          openPositions.splice(i, 1);
          closePosition(pos, now, snap.price_usd!, result.exitReason, result.last_volume_ratio);
        }
      }
      continue;
    }

    if (ev.type === 'score') {
      const score = ev.data;
      if (score.signal !== 'TRADE_CANDIDATE' && score.signal !== 'PRIORITY_TRADE') continue;
      const scoreNorm = score.total_score != null ? Number(score.total_score) : 0;
      if (scoreNorm < minTradeScore) continue;

      if (policyCooldownUntil != null && now >= policyCooldownUntil) policyCooldownUntil = null;

      const tokenMint = pairToTokenMint.get(score.pair_address) ?? null;
      const hasOpenForToken =
        tokenMint != null
          ? openPositions.some((p) => p.token_mint === tokenMint)
          : openPositions.some((p) => p.pair_address === score.pair_address);

      let tokenStatsForEntry: TokenStats | null = null;
      if (tokenMint != null && tokenMint !== '') {
        const s = getTokenStats(tokenMint);
        if (now - s.window_start >= 3600) {
          s.trades_in_window = 0;
          s.window_start = now;
        }
        tokenStatsForEntry = s;
      }

      const state: EntryEvaluationState = {
        openCount: openPositions.length,
        countInLastHour: countInLastHour(now),
        lastLossExitTime,
        policyCooldownUntil,
        hasOpenForToken,
        tokenMint,
        tokenStats: tokenStatsForEntry,
        availableBalance,
        now,
      };

      let pairAgeSeconds: number | null = null;
      let liquidityMetrics: { liquidity_change_pct_30m: number | null; liquidity_change_pct_1h: number | null; liquidity_sample_count: number | null } | undefined;
      let entryPriceChange1mPct: number | null | undefined;
      try {
        const idsJson = score.snapshot_ids;
        const ids = idsJson ? (JSON.parse(idsJson) as number[]) : [];
        const firstId = ids[0];
        if (firstId != null) {
          const snap = snapshotById.get(firstId);
          if (snap) {
            if (snap.seconds_since_creation != null && Number.isFinite(snap.seconds_since_creation)) {
              pairAgeSeconds = snap.seconds_since_creation;
            }
            liquidityMetrics = {
              liquidity_change_pct_30m: snap.liquidity_change_pct_30m ?? null,
              liquidity_change_pct_1h: snap.liquidity_change_pct_1h ?? null,
              liquidity_sample_count: snap.liquidity_sample_count ?? null,
            };
            entryPriceChange1mPct =
              snap.price_change_1m != null && Number.isFinite(snap.price_change_1m) ? snap.price_change_1m : null;
          }
        }
      } catch {
        // leave pairAgeSeconds and liquidityMetrics null/undefined
      }

      const entryResult = evaluateEntry(
        config,
        score,
        state,
        marketMode,
        snapshotPriceById,
        policyVersionLabel,
        pairAgeSeconds,
        liquidityMetrics,
        entryPriceChange1mPct
      );

      let entryPrice: number;
      let entrySnapshotId: number | null = null;
      try {
        const idsJson = score.snapshot_ids;
        const ids = idsJson ? (JSON.parse(idsJson) as number[]) : [];
        const firstId = ids[0];
        if (firstId == null) continue;
        const price = snapshotPriceById.get(firstId);
        if (price == null || !Number.isFinite(price)) continue;
        entryPrice = price;
        entrySnapshotId = firstId;
      } catch {
        continue;
      }

      const sizing = computePositionSizeUsd({
        account_equity: SIM_STARTING_EQUITY,
        risk_per_trade_pct: config.risk_per_trade_pct,
        stop_loss_pct: config.stop_loss_pct,
        score: score.total_score ?? null,
        min_trade_score: config.min_trade_score,
        priority_trade_score: config.priority_trade_score,
      });
      const positionSize = Math.min(sizing.position_size_usd, availableBalance);
      const newTradeRiskPct = sizing.risk_pct_at_entry ?? config.risk_per_trade_pct ?? 5;
      const stopLossPct = config.stop_loss_pct != null && Number.isFinite(config.stop_loss_pct) ? Math.abs(config.stop_loss_pct) : 0;
      const actualNewTradeRiskPct =
        SIM_STARTING_EQUITY > 0 && stopLossPct > 0 && Number.isFinite(positionSize)
          ? (positionSize * (stopLossPct / 100) / SIM_STARTING_EQUITY) * 100
          : newTradeRiskPct;
      const openRiskPct = openRiskPctBacktest(openPositions, config.stop_loss_pct, SIM_STARTING_EQUITY);
      const failedChecks = [...entryResult.failed_checks];
      if (positionSize <= 0) failedChecks.push(ENTRY_REJECTION_REASONS.INSUFFICIENT_BALANCE);
      if (openRiskPct + actualNewTradeRiskPct > BACKTEST_MAX_TOTAL_RISK_PCT) {
        failedChecks.push(ENTRY_REJECTION_REASONS.PORTFOLIO_HEAT_LIMIT);
      }
      const allowed = entryResult.allowed && failedChecks.length === 0;

      diagnostics.push({
        pair_address: score.pair_address,
        timestamp: now,
        allowed,
        failed_checks: failedChecks,
        score: score.total_score ?? null,
        policy_version: policyVersionLabel,
      });

      if (!allowed) continue;

      availableBalance -= positionSize;
      tradesExecutedAt.push(now);
      if (tokenMint != null && tokenMint !== '') {
        const s = getTokenStats(tokenMint);
        s.trades_in_window++;
      }

      const entrySnap = entrySnapshotId != null ? snapshotById.get(entrySnapshotId) : null;
      if (entrySnap) lastSnapshotByPair.set(score.pair_address, entrySnap);
      openPositions.push({
        pair_address: score.pair_address,
        token_mint: tokenMint,
        entry_time: now,
        entry_price: entryPrice,
        position_size_usd: positionSize,
        entry_snapshot_id: entrySnapshotId,
        market_mode: score.market_mode ?? 'amm',
        consecutive_volume_collapse_count: 0,
        last_volume_ratio: null,
        pair_missing_failures: 0,
        last_snapshot_timestamp: entrySnap?.timestamp ?? now,
      });
    }
  }

  // Close any remaining open positions at end_time at last known price (or entry as fallback)
  for (const pos of openPositions) {
    const exitPrice = lastPriceByPair.get(pos.pair_address) ?? pos.entry_price;
    closePosition(pos, endTime, exitPrice, 'TIME_STOP', undefined);
  }

  const n = closedTrades.length;
  const wins = closedTrades.filter((t) => t.result === 'win').length;
  const losses = n - wins;
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const t of closedTrades) {
    cumulative += t.pnl;
    if (cumulative > peak) peak = cumulative;
    const dd = peak - cumulative;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }
  const avgPnl = n > 0 ? closedTrades.reduce((a, t) => a + t.pnl, 0) / n : 0;
  const avgHold = n > 0 ? closedTrades.reduce((a, t) => a + t.hold_time_seconds, 0) / n : 0;

  const totalEntryChecks = diagnostics.length;
  const entriesAllowed = diagnostics.filter((d) => d.allowed).length;
  const entriesRejected = totalEntryChecks - entriesAllowed;
  const rejectionBreakdown: Record<string, number> = {};
  for (const d of diagnostics) {
    for (const r of d.failed_checks) {
      rejectionBreakdown[r] = (rejectionBreakdown[r] ?? 0) + 1;
    }
  }
  const entry_diagnostics_summary: EntryDiagnosticsSummary = {
    total_entry_checks: totalEntryChecks,
    entries_allowed: entriesAllowed,
    entries_rejected: entriesRejected,
    rejection_breakdown: rejectionBreakdown,
  };

  const metrics: BacktestMetrics = {
    trades: n,
    wins,
    losses,
    win_rate: n > 0 ? wins / n : 0,
    avg_pnl: avgPnl,
    max_drawdown: maxDrawdown,
    avg_hold_time_seconds: avgHold,
    entry_diagnostics_summary,
  };

  return { trades: closedTrades, metrics, diagnostics };
}
