import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';
import { isLiveTradingEnabled, warnIfSolanaKeyMissing } from '../config.js';
import { executeOrderForAccount } from '../executors/index.js';
import { getActiveDeploymentsForPolicy } from '../deployment-resolver.js';
import { resolveMarketMode, isLiquidityHaltApplicable } from '../halts.js';
import type { MarketMode } from '../market-mode.js';
import { computePositionSizeUsd, MIN_POSITION_SIZE_USD } from '../position-sizing.js';
import { getSolPriceUsd } from '../sol-price.js';

const DECISION_LOOP_DELAY_MS = 2000; // 2s between cycles to avoid overloading
const SCORE_MAX_AGE_SECONDS = 120; // ignore scores older than this
/** Minimum SOL to keep for tx fees when checking if we can attempt a live Solana trade (avoid hitting RPC when insufficient). */
const MIN_SOL_RESERVE_FOR_FEES = 0.005;

/** Human-readable remaining cooldown (whole seconds) for logs. */
function formatCooldownTimeLeft(secondsRemaining: number): string {
  const s = Math.max(0, Math.ceil(secondsRemaining));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (s < 3600) return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
  const h = Math.floor(s / 3600);
  const rem = s % 3600;
  const mm = Math.floor(rem / 60);
  const ss = rem % 60;
  const parts: string[] = [`${h}h`];
  if (mm > 0) parts.push(`${mm}m`);
  if (ss > 0) parts.push(`${ss}s`);
  return parts.join(' ');
}

// Policy schema: strategy-only. Account-level risk (max_daily_drawdown_pct, etc.) lives in accounts; policies must NOT override.
interface PolicyRow {
  policy_id: number;
  policy_version: string;
  linked_policy_id: number | null;
  allowed_dexes: string | null;
  max_trades_per_hour: number | null;
  max_concurrent_trades: number | null;
  cooldown_seconds_after_loss: number | null;
  risk_per_trade_pct: number | null;
  time_stop_seconds: number | null;
  stop_loss_pct: number | null;
  min_trade_score: number | null;
  cooldown_on_consecutive_losses: number | null;
  cooldown_on_consecutive_losses_seconds: number | null;
  halt_on_liquidity_drop_pct: number | null;
  pair_loss_cooldown_seconds: number | null;
  max_consecutive_losses_per_pair: number | null;
  token_reentry_cooldown_seconds: number | null;
  token_reentry_cooldown_seconds_after_win: number | null;
  max_trades_per_token_per_hour: number | null;
  priority_trade_score: number | null;
}

interface OpenDecisionRow {
  trade_id: number;
  pair_address: string;
  entry_price: number;
  position_size_usd: number;
  executed_at: number;
  entry_snapshot_id: number | null;
  policy_version: string;
}

interface ScoreRow {
  id: number;
  pair_address: string;
  policy_version: string;
  market_mode: string | null;
  signal: string;
  total_score: number | null;
  scored_at: number;
  snapshot_ids: string | null;
}

const getAllActivePolicies = db.prepare(`
  SELECT policy_id, policy_version, linked_policy_id, allowed_dexes,
    max_trades_per_hour, max_concurrent_trades, cooldown_seconds_after_loss,
    risk_per_trade_pct, time_stop_seconds, stop_loss_pct, min_trade_score,
    cooldown_on_consecutive_losses, cooldown_on_consecutive_losses_seconds, halt_on_liquidity_drop_pct,
    pair_loss_cooldown_seconds, max_consecutive_losses_per_pair,
    token_reentry_cooldown_seconds, token_reentry_cooldown_seconds_after_win, max_trades_per_token_per_hour,
    priority_trade_score
  FROM policies
  WHERE status = 'active'
  ORDER BY activated_at DESC, created_at DESC
`);

/** Open decisions for a specific account (for heat and balance checks). */
const getOpenDecisionsForAccount = db.prepare(`
  SELECT trade_id, pair_address, token_mint, entry_price, position_size_usd, executed_at, entry_snapshot_id, policy_version
  FROM trade_decisions
  WHERE exit_recorded_at IS NULL AND (account_id = $accountId OR (account_id IS NULL AND $accountId = 'paper-default'))
`);

const getPairInfo = db.prepare(`
  SELECT base_token_address, dex FROM pairs WHERE pair_address = $pairAddress
`);

const setDecisionExitRecorded = db.prepare(`
  UPDATE trade_decisions SET exit_recorded_at = $exitRecordedAt WHERE trade_id = $tradeId
`);

const getExecutableScores = db.prepare(`
  SELECT id, pair_address, policy_version, market_mode, signal, total_score, scored_at, snapshot_ids
  FROM pair_scores
  WHERE eligible = 1
    AND policy_version = $policyVersion
    AND signal IN ('TRADE_CANDIDATE', 'PRIORITY_TRADE')
    AND scored_at >= $scoredAt
  ORDER BY scored_at DESC
  LIMIT 50
`);

const getPolicyExecutionState = db.prepare(`
  SELECT last_blocked_at, policy_cooldown_until, consecutive_loss_count
  FROM policy_execution_state WHERE policy_version = $policyVersion
`);
const setPolicyLastBlockedAt = db.prepare(`
  INSERT INTO policy_execution_state (policy_version, last_blocked_at, policy_cooldown_until, consecutive_loss_count) VALUES ($policyVersion, $lastBlockedAt, NULL, 0)
  ON CONFLICT(policy_version) DO UPDATE SET last_blocked_at = excluded.last_blocked_at
`);
const clearPolicyLastBlockedAt = db.prepare(`
  DELETE FROM policy_execution_state WHERE policy_version = $policyVersion
`);
const clearPolicyCooldown = db.prepare(`
  UPDATE policy_execution_state SET policy_cooldown_until = NULL WHERE policy_version = $policyVersion AND policy_cooldown_until IS NOT NULL
`);

const getSnapshotPrice = db.prepare(`
  SELECT snapshot_id, price_usd FROM pair_snapshots WHERE snapshot_id = $snapshotId
`);

const countOpenDecisionsForPolicy = db.prepare(`
  SELECT COUNT(*) AS n FROM trade_decisions WHERE exit_recorded_at IS NULL AND policy_version = $policyVersion
`);
/** Per-account open count (for account max_total_open_trades). */
const countOpenDecisionsForAccount = db.prepare(`
  SELECT COUNT(*) AS n FROM trade_decisions
  WHERE exit_recorded_at IS NULL AND (account_id = $accountId OR (account_id IS NULL AND $accountId = 'paper-default'))
`);

/** Counts decisions in the last hour that count toward max_trades_per_hour (excludes LIVE_FAILED). */
const countDecisionsInLastHourForPolicy = db.prepare(`
  SELECT COUNT(*) AS n FROM trade_decisions
  WHERE policy_version = $policyVersion AND executed_at >= $executedAt
    AND (execution_status IS NULL OR execution_status != 'LIVE_FAILED')
`);

/** Oldest counting decision in the window (excludes LIVE_FAILED) for time-until-reset. */
const minExecutedAtInLastHourForPolicy = db.prepare(`
  SELECT MIN(executed_at) AS min_at FROM trade_decisions
  WHERE policy_version = $policyVersion AND executed_at >= $executedAt
    AND (execution_status IS NULL OR execution_status != 'LIVE_FAILED')
`);

/** Per-account: already have open position in this pair? */
const hasOpenForPairForAccount = db.prepare(`
  SELECT 1 FROM trade_decisions
  WHERE (account_id = $accountId OR (account_id IS NULL AND $accountId = 'paper-default')) AND pair_address = $pairAddress AND exit_recorded_at IS NULL LIMIT 1
`);

/** Per-account: already have open position in this token? */
const hasOpenForTokenForAccount = db.prepare(`
  SELECT 1 FROM trade_decisions
  WHERE (account_id = $accountId OR (account_id IS NULL AND $accountId = 'paper-default')) AND token_mint = $tokenMint AND exit_recorded_at IS NULL LIMIT 1
`);

/** Per-account: already used this score (open or closed decision, or completed trade)? */
const hasUsedScoreInDecisions = db.prepare(`
  SELECT 1 FROM trade_decisions
  WHERE (account_id = $accountId OR (account_id IS NULL AND $accountId = 'paper-default')) AND policy_version = $policyVersion AND entry_score_id = $entryScoreId
  LIMIT 1
`);
const hasUsedScoreInTrades = db.prepare(`
  SELECT 1 FROM trades
  WHERE (account_id = $accountId OR (account_id IS NULL AND $accountId = 'paper-default')) AND policy_version = $policyVersion AND entry_score_id = $entryScoreId
  LIMIT 1
`);

const getRecentTradesByExitForPolicy = db.prepare(`
  SELECT trade_id, pnl_pct, exit_time
  FROM trades
  WHERE policy_version = $policyVersion AND exit_time IS NOT NULL
  ORDER BY exit_time DESC
  LIMIT 20
`);

/** Per-account max_daily_drawdown_pct from accounts table (by account_id) so drawdown limit always matches the deployment's wallet. */
const getAccountMaxDailyDrawdownPct = db.prepare(`
  SELECT max_daily_drawdown_pct FROM accounts WHERE account_id = $accountId
`);

/** Per-account daily drawdown from DB: current_equity and today's realized PnL (same formula as account can_trade). */
const getDailyDrawdownFromDb = db.prepare(`
  SELECT
    a.current_equity,
    (SELECT COALESCE(SUM(t.position_size_usd * t.pnl_pct / 100.0), 0) FROM trades t
     WHERE to_timestamp(t.exit_time)::date = CURRENT_DATE
       AND t.pnl_pct IS NOT NULL
       AND (t.account_id = a.account_id OR (t.account_id IS NULL AND a.account_id = 'paper-default'))
    ) AS realized_pnl_usd
  FROM accounts a
  WHERE a.account_id = $accountId
`);

const getSnapshotTimestamp = db.prepare(`
  SELECT timestamp FROM pair_snapshots WHERE snapshot_id = $snapshotId
`);

const getPairPolicyStats = db.prepare(`
  SELECT last_loss_at, consecutive_losses, updated_at
  FROM pair_policy_stats
  WHERE pair_address = $pairAddress AND policy_version = $policyVersion
`);

const getTokenPolicyStats = db.prepare(`
  SELECT last_loss_at, consecutive_losses, last_exit_reason, updated_at
  FROM token_policy_stats
  WHERE token_mint = $tokenMint AND policy_version = $policyVersion
`);

const insertTradeDecisionSkip = db.prepare(`
  INSERT INTO trade_decision_skips (pair_address, policy_version, reason, decided_at, token_mint)
  VALUES ($pairAddress, $policyVersion, $reason, $decidedAt, $tokenMint)
`);

/** Pairs we should not retry (pool does not exist). */
const getPoolNotFoundPairsForPolicy = db.prepare(`
  SELECT pair_address FROM trade_decision_skips
  WHERE policy_version = $policyVersion AND reason = 'POOL_ACCOUNT_NOT_FOUND'
`);

const getTokenPolicyExecution = db.prepare(`
  SELECT last_exit_at, last_trade_outcome, trades_in_window, window_start, updated_at
  FROM token_policy_execution WHERE token_mint = $tokenMint AND policy_version = $policyVersion
`);
const upsertTokenPolicyExecution = db.prepare(`
  INSERT INTO token_policy_execution (token_mint, policy_version, last_exit_at, trades_in_window, window_start, updated_at)
  VALUES ($tokenMint, $policyVersion, $lastExitAt, $tradesInWindow, $windowStart, $updatedAt)
  ON CONFLICT (token_mint, policy_version) DO UPDATE SET
    last_exit_at = excluded.last_exit_at,
    trades_in_window = excluded.trades_in_window,
    window_start = excluded.window_start,
    updated_at = excluded.updated_at
`);

const releaseBalanceOnExit = db.prepare(`
  UPDATE accounts SET current_equity = current_equity + $realizedPnlUsd, available_balance = available_balance + $positionSizeUsd + $realizedPnlUsd, updated_at = $updatedAt
  WHERE account_id = $accountId
`);

const getPolicyVersionById = db.prepare(
  `SELECT policy_version FROM policies WHERE policy_id = $linkedPolicyId`
);

function resolveLinkedPolicyVersion(linkedPolicyId: number | null): string | null {
  if (linkedPolicyId == null) return null;
  const row = getPolicyVersionById.get({ linkedPolicyId }) as { policy_version: string } | undefined;
  return row?.policy_version ?? null;
}

function maxNullableTs(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

function getPolicyMarketMode(policy: PolicyRow): MarketMode {
  return resolveMarketMode(policy);
}

function isPoolAccountNotFound(skipReason: string | undefined): boolean {
  if (!skipReason) return false;
  return skipReason.includes('Pool account not found');
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

/** Seconds until start of next calendar day (local time). */
function secondsUntilNextMidnight(unixNow: number): number {
  const d = new Date(unixNow * 1000);
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0);
  return Math.max(0, Math.floor(next.getTime() / 1000 - unixNow));
}

function consecutiveLossCountForPolicy(policyVersion: string): number {
  const rows = getRecentTradesByExitForPolicy.all({ policyVersion }) as { pnl_pct: number | null }[];
  let count = 0;
  for (const row of rows) {
    if (row.pnl_pct != null && row.pnl_pct < 0) count++;
    else break;
  }
  return count;
}

/**
 * Account-level daily drawdown from DB: (today's realized PnL in USD) / (equity at start of day) * 100.
 * Uses current_equity and today's realized PnL from SQL. For live Solana, pass balanceUsdOverride (balance_native * SOL price) so drawdown is based on native balance in USD, not current_equity.
 */
function dailyDrawdownPct(accountId: string, balanceUsdOverride?: number): number {
  const row = getDailyDrawdownFromDb.get({ accountId }) as
    | { current_equity: number; realized_pnl_usd: number }
    | undefined;
  if (!row) return 0;
  const balanceUsd =
    balanceUsdOverride != null && Number.isFinite(balanceUsdOverride) ? balanceUsdOverride : row.current_equity;
  const equityAtStartOfDay = balanceUsd - row.realized_pnl_usd;
  if (equityAtStartOfDay <= 0) return 0;
  return (row.realized_pnl_usd / equityAtStartOfDay) * 100;
}

function lastExitTimeForCooldownForPolicy(policyVersion: string): number | null {
  const rows = getRecentTradesByExitForPolicy.all({ policyVersion }) as { pnl_pct: number | null; exit_time: number }[];
  const lastLoss = rows.find((r) => r.pnl_pct != null && r.pnl_pct < 0);
  return lastLoss?.exit_time ?? null;
}

// Account-level drawdown is checked in runCycle before entering policy loop; this is per-policy kill switches only.
// Consecutive-loss cooldown is enforced via policy_cooldown_until in executePolicy (soft skip), not here.
function killSwitchesTriggered(
  _policy: PolicyRow,
  _policyMarketMode: MarketMode,
  globalDrawdownPct: number,
  accountMaxDailyDrawdownPct: number | null
): string | null {
  if (accountMaxDailyDrawdownPct != null && accountMaxDailyDrawdownPct > 0) {
    if (globalDrawdownPct <= -accountMaxDailyDrawdownPct) {
      return `account_max_daily_drawdown: ${globalDrawdownPct.toFixed(1)}% <= -${accountMaxDailyDrawdownPct}%`;
    }
  }

  if (isLiquidityHaltApplicable(_policyMarketMode)) {
    // Liquidity halts only apply in AMM; bonding_curve skips. No live liquidity check in v1 paper.
    // Placeholder: if we had liquidity drop data we would check halt_on_liquidity_drop_pct here.
  }

  return null;
}

// Position sizing is done via computePositionSizeUsd (risk-based + score multiplier + clamps).

function logEligibleScore(score: ScoreRow): void {
  console.log(
    JSON.stringify({
      event: 'eligible_score',
      score_id: score.id,
      pair: score.pair_address.slice(0, 12) + '…',
      signal: score.signal,
      policy_version: score.policy_version,
      scored_at: score.scored_at,
    })
  );
}

function logDecision(
  scoreId: number,
  pair: string,
  decision: string,
  policyVersion: string,
  marketMode: string,
  reason: string,
  positionSize: number
): void {
  console.log(
    JSON.stringify({
      event: 'decision',
      score_id: scoreId,
      pair: pair.slice(0, 12) + '…',
      decision,
      policy: policyVersion,
      market_mode: marketMode,
      reason,
      position_size: Math.round(positionSize * 100) / 100,
    })
  );
}

function logSkipped(
  scoreId: number,
  pair: string,
  reason: string,
  policyVersion: string,
  metadata?: Record<string, number | string | null>,
  policyMode?: string,
  mode?: 'paper' | 'live'
): void {
  console.log(
    JSON.stringify({
      event: 'decision',
      score_id: scoreId,
      pair: pair.slice(0, 12) + '…',
      decision: 'SKIP',
      policy_version: policyVersion,
      policy_mode: policyMode ?? undefined,
      mode: mode ?? undefined,
      reason,
      timestamp: Math.floor(Date.now() / 1000),
      ...metadata,
    })
  );
}

/** Account row used in execution worker (matches deployment resolver; chain fields for executor routing). */
interface AccountRow {
  account_id: string;
  mode: 'paper' | 'live';
  chain: string | null;
  address: string | null;
  name?: string | null;
  starting_equity: number;
  current_equity: number;
  available_balance: number;
  balance_native?: number | null;
  max_daily_drawdown_pct: number | null;
  max_total_open_trades: number | null;
  max_total_risk_pct: number;
  trading_enabled: number;
  is_active?: number;
  updated_at: number;
}

/** Open risk from existing positions: sum(position_size_usd * stop_distance_pct/100) / account_equity * 100. */
function computeOpenRiskPct(
  accountEquity: number,
  openDecisions: OpenDecisionRow[],
  stopLossPctByPolicyVersion: Map<string, number | null>
): number {
  if (!Number.isFinite(accountEquity) || accountEquity <= 0) return 0;
  let totalRiskUsd = 0;
  for (const dec of openDecisions) {
    const stopLossPct = stopLossPctByPolicyVersion.get(dec.policy_version) ?? null;
    const pct = stopLossPct != null && Number.isFinite(stopLossPct) ? Math.abs(stopLossPct) / 100 : 0;
    totalRiskUsd += dec.position_size_usd * pct;
  }
  return (totalRiskUsd / accountEquity) * 100;
}

async function executePolicy(
  policy: PolicyRow,
  account: AccountRow,
  deploymentId: string,
  openDecisions: OpenDecisionRow[],
  stopLossPctByPolicyVersion: Map<string, number | null>,
  cycleNewRiskPctRef: { value: number },
  now: number,
  _runId: string,
  globalDrawdownPct: number,
  accountMaxDailyDrawdownPct: number | null,
): Promise<void> {
  // For live Solana, available_balance in DB is not synced; use balance_native (SOL) * price for checks and logging.
  if (account.mode === 'live' && account.chain === 'solana') {
    try {
      const solPrice = await getSolPriceUsd();
      account.available_balance = (account.balance_native ?? 0) * solPrice;
    } catch {
      // SOL price fetch failed; leave available_balance as-is (DB value, often 0)
    }
  }

  const policyMarketMode = getPolicyMarketMode(policy);
  const linkedPolicyVersion = resolveLinkedPolicyVersion(policy.linked_policy_id);
  const cutoff = now - SCORE_MAX_AGE_SECONDS;
  const state = getPolicyExecutionState.get({ policyVersion: policy.policy_version }) as
    | { last_blocked_at: number | null; policy_cooldown_until: number | null; consecutive_loss_count: number }
    | undefined;
  const lastBlockedAt = state?.last_blocked_at ?? null;
  const policyCooldownUntil = state?.policy_cooldown_until ?? null;
  const effectiveCutoff = Math.max(cutoff, lastBlockedAt ?? 0);

  if (policyCooldownUntil != null && now < policyCooldownUntil) {
    const untilDate = new Date(policyCooldownUntil * 1000);
    const secondsRemaining = policyCooldownUntil - now;
    console.log(
      JSON.stringify({
        event: 'decision',
        decision: 'SKIP',
        policy_version: policy.policy_version,
        reason: 'POLICY_COOLDOWN',
        cooldown_until: policyCooldownUntil,
        cooldown_until_human: untilDate.toISOString(),
        cooldown_seconds_remaining: secondsRemaining,
        cooldown_time_left: formatCooldownTimeLeft(secondsRemaining),
      })
    );
    insertTradeDecisionSkip.run({ pairAddress: '', policyVersion: policy.policy_version, reason: 'POLICY_COOLDOWN', decidedAt: now, tokenMint: null });
    return;
  }
  if (policyCooldownUntil != null && now >= policyCooldownUntil) {
    clearPolicyCooldown.run({ policyVersion: policy.policy_version });
  }

  const recordBlocked = () => {
    setPolicyLastBlockedAt.run({ policyVersion: policy.policy_version, lastBlockedAt: now });
  };
 
  /*
  console.log(
    JSON.stringify({
      event: 'policy_processing',
      policy_id: policy.policy_id,
      policy_version: policy.policy_version,
      market_mode: policyMarketMode,
      allowed_dexes: policy.allowed_dexes,
      max_concurrent_trades: policy.max_concurrent_trades ?? 2,
      max_trades_per_hour: policy.max_trades_per_hour ?? 2,
      pair_loss_cooldown_seconds: policy.pair_loss_cooldown_seconds ?? 0,
      max_consecutive_losses_per_pair: policy.max_consecutive_losses_per_pair ?? null,
      cutoff,
      effective_cutoff: effectiveCutoff,
    })
  );
  */

  const killReason = killSwitchesTriggered(
    policy,
    policyMarketMode,
    globalDrawdownPct,
    accountMaxDailyDrawdownPct
  );
  if (killReason != null) {
    console.log(
      JSON.stringify({
        event: 'decision',
        decision: 'SKIP',
        policy_version: policy.policy_version,
        reason: 'KILL_SWITCH',
        kill_reason: killReason,
      })
    );
    insertTradeDecisionSkip.run({ pairAddress: '', policyVersion: policy.policy_version, reason: 'KILL_SWITCH', decidedAt: now, tokenMint: null });
    recordBlocked();
    return;
  }

  const openCount = (countOpenDecisionsForPolicy.get({ policyVersion: policy.policy_version }) as { n: number }).n;
  const maxConcurrent = policy.max_concurrent_trades ?? 2;
  if (openCount >= maxConcurrent) {
    console.log(
      JSON.stringify({
        event: 'decision',
        decision: 'SKIP',
        policy_version: policy.policy_version,
        reason: 'MAX_CONCURRENT_TRADES',
        open_count: openCount,
        max_concurrent: maxConcurrent,
      })
    );
    insertTradeDecisionSkip.run({ pairAddress: '', policyVersion: policy.policy_version, reason: 'MAX_CONCURRENT_TRADES', decidedAt: now, tokenMint: null });
    recordBlocked();
    return;
  }

  const cooldownSec = policy.cooldown_seconds_after_loss ?? 0;
  if (cooldownSec > 0) {
    const lastLossExit = lastExitTimeForCooldownForPolicy(policy.policy_version);
    if (lastLossExit != null && now - lastLossExit < cooldownSec) {
      const remainingSec = lastLossExit + cooldownSec - now;
      const m = Math.floor(remainingSec / 60);
      const s = Math.floor(remainingSec % 60);
      const timeLeft = m > 0 ? `${m}m ${s}s` : `${s}s`;
      console.log(
        JSON.stringify({
          event: 'decision',
          decision: 'SKIP',
          policy_version: policy.policy_version,
          reason: 'COOLDOWN_AFTER_LOSS',
          cooldown_scope: 'policy',
          time_left: timeLeft,
          remaining_seconds: remainingSec,
        })
      );
      insertTradeDecisionSkip.run({ pairAddress: '', policyVersion: policy.policy_version, reason: 'COOLDOWN_AFTER_LOSS', decidedAt: now, tokenMint: null });
      recordBlocked();
      return;
    }
  }

  const maxPerHour = policy.max_trades_per_hour ?? 2;
  const countHour = (countDecisionsInLastHourForPolicy.get({ policyVersion: policy.policy_version, executedAt: now - 3600 }) as { n: number }).n;
  if (countHour >= maxPerHour) {
    const minRow = minExecutedAtInLastHourForPolicy.get({ policyVersion: policy.policy_version, executedAt: now - 3600 }) as { min_at: number | null } | undefined;
    const timeUntilResetSec = minRow?.min_at != null ? minRow.min_at + 3600 - now : null;
    let timeUntilResetStr = '—';
    if (timeUntilResetSec != null && timeUntilResetSec > 0) {
      const h = Math.floor(timeUntilResetSec / 3600);
      const m = Math.floor((timeUntilResetSec % 3600) / 60);
      const s = timeUntilResetSec % 60;
      timeUntilResetStr = [h > 0 ? `${h}h` : '', m > 0 ? `${m}m` : '', `${s}s`].filter(Boolean).join(' ');
    }
    console.log(
      JSON.stringify({
        event: 'decision',
        decision: 'SKIP',
        policy_version: policy.policy_version,
        reason: 'MAX_TRADES_PER_HOUR',
        count_hour: countHour,
        max_per_hour: maxPerHour,
        time_until_reset: timeUntilResetStr,
        time_until_reset_seconds: timeUntilResetSec,
      })
    );
    insertTradeDecisionSkip.run({ pairAddress: '', policyVersion: policy.policy_version, reason: 'MAX_TRADES_PER_HOUR', decidedAt: now, tokenMint: null });
    recordBlocked();
    return;
  }

  clearPolicyLastBlockedAt.run({ policyVersion: policy.policy_version });

  const scores = getExecutableScores.all({ policyVersion: policy.policy_version, scoredAt: effectiveCutoff }) as ScoreRow[];
  const poolNotFoundPairs = new Set(
    (getPoolNotFoundPairsForPolicy.all({ policyVersion: policy.policy_version }) as { pair_address: string }[]).map((r) => r.pair_address)
  );
  let openNow = openCount;

  /*
  if (scores.length > 0) {
    console.log(
      JSON.stringify({
        event: 'eligible_scores_count',
        count: scores.length,
        policy_version: policy.policy_version,
        effective_cutoff: effectiveCutoff,
      })
    );
  } else {
    console.log(
      JSON.stringify({
        event: 'eligible_scores_count',
        count: 0,
        policy_version: policy.policy_version,
        effective_cutoff: effectiveCutoff,
        message: 'no eligible scores',
      })
    );
  }
  */

  for (const score of scores) {
    // logEligibleScore(score);

    if (poolNotFoundPairs.has(score.pair_address)) continue;

    if (score.policy_version !== policy.policy_version) {
      insertTradeDecisionSkip.run({ pairAddress: score.pair_address, policyVersion: policy.policy_version, reason: 'POLICY_VERSION_MISMATCH', decidedAt: now, tokenMint: null });
      logSkipped(score.id, score.pair_address, 'POLICY_VERSION_MISMATCH', policy.policy_version, undefined, policyMarketMode, account.mode);
      continue;
    }

    if (score.scored_at < effectiveCutoff) {
      insertTradeDecisionSkip.run({ pairAddress: score.pair_address, policyVersion: policy.policy_version, reason: 'STALE_SCORE', decidedAt: now, tokenMint: null });
      logSkipped(score.id, score.pair_address, 'STALE_SCORE', policy.policy_version, undefined, policyMarketMode, account.mode);
      continue;
    }

    if (score.signal !== 'TRADE_CANDIDATE' && score.signal !== 'PRIORITY_TRADE') {
      insertTradeDecisionSkip.run({ pairAddress: score.pair_address, policyVersion: policy.policy_version, reason: 'SIGNAL_GATE', decidedAt: now, tokenMint: null });
      logSkipped(score.id, score.pair_address, 'SIGNAL_GATE', policy.policy_version, undefined, policyMarketMode, account.mode);
      continue;
    }

    const scoreMarketMode = (score.market_mode ?? policyMarketMode) as MarketMode;
    if (scoreMarketMode !== policyMarketMode) {
      insertTradeDecisionSkip.run({ pairAddress: score.pair_address, policyVersion: policy.policy_version, reason: 'MARKET_MODE_MISMATCH', decidedAt: now, tokenMint: null });
      logSkipped(score.id, score.pair_address, 'MARKET_MODE_MISMATCH', policy.policy_version, undefined, policyMarketMode, account.mode);
      continue;
    }

    // Token-scoped duplicate prevention for new trades; legacy fallback by pair_address
    const pairInfo = getPairInfo.get({ pairAddress: score.pair_address }) as { base_token_address: string; dex: string } | undefined;
    const tokenMint = pairInfo?.base_token_address ?? null;
    const hasOpen =
      tokenMint != null && tokenMint !== ''
        ? hasOpenForTokenForAccount.get({ accountId: account.account_id, tokenMint }) != null
        : hasOpenForPairForAccount.get({ accountId: account.account_id, pairAddress: score.pair_address }) != null;
    if (hasOpen) {
      insertTradeDecisionSkip.run({ pairAddress: score.pair_address, policyVersion: policy.policy_version, reason: 'DUPLICATE_OPEN_PAIR', decidedAt: now, tokenMint });
      logSkipped(score.id, score.pair_address, 'DUPLICATE_OPEN_PAIR', policy.policy_version, undefined, policyMarketMode, account.mode);
      continue;
    }

    const alreadyUsedScore =
      hasUsedScoreInDecisions.get({ accountId: account.account_id, policyVersion: policy.policy_version, entryScoreId: score.id }) != null ||
      hasUsedScoreInTrades.get({ accountId: account.account_id, policyVersion: policy.policy_version, entryScoreId: score.id }) != null;
    if (alreadyUsedScore) {
      insertTradeDecisionSkip.run({ pairAddress: score.pair_address, policyVersion: policy.policy_version, reason: 'DUPLICATE_SCORE', decidedAt: now, tokenMint });
      logSkipped(score.id, score.pair_address, 'DUPLICATE_SCORE', policy.policy_version, {
        duplicate_score_id: score.id,
      }, policyMarketMode, account.mode);
      continue;
    }

    if (openNow >= maxConcurrent) {
      insertTradeDecisionSkip.run({ pairAddress: score.pair_address, policyVersion: policy.policy_version, reason: 'MAX_CONCURRENT', decidedAt: now, tokenMint });
      logSkipped(score.id, score.pair_address, 'MAX_CONCURRENT', policy.policy_version, undefined, policyMarketMode, account.mode);
      continue;
    }

    // Token execution controls: re-entry cooldown and max trades per token per hour (token-centric, policy-scoped)
    // When a linked policy exists, also check its stats so cooldowns/limits carry over.
    let executionLastExitAt: number | null = null;
    let executionTradesInWindow = 0;
    let executionWindowStart = now;
    let usedWinReentryCooldown = false;
    if (tokenMint != null && tokenMint !== '') {
      type TokenExecRow = { last_exit_at: number | null; last_trade_outcome: string | null; trades_in_window: number; window_start: number | null; updated_at: number | null };
      const execRow = getTokenPolicyExecution.get({ tokenMint, policyVersion: policy.policy_version }) as TokenExecRow | undefined;
      const linkedExecRow = linkedPolicyVersion
        ? (getTokenPolicyExecution.get({ tokenMint, policyVersion: linkedPolicyVersion }) as TokenExecRow | undefined)
        : undefined;

      const currentLastExitAt = execRow?.last_exit_at ?? null;
      executionLastExitAt = maxNullableTs(currentLastExitAt, linkedExecRow?.last_exit_at ?? null);

      const lastOutcome: string | null =
        (currentLastExitAt ?? 0) >= (linkedExecRow?.last_exit_at ?? 0)
          ? (execRow?.last_trade_outcome ?? linkedExecRow?.last_trade_outcome ?? null)
          : (linkedExecRow?.last_trade_outcome ?? execRow?.last_trade_outcome ?? null);

      let tradesInWindow = execRow?.trades_in_window ?? 0;
      let windowStart = execRow?.window_start ?? now;
      if (now - windowStart >= 3600) {
        tradesInWindow = 0;
        windowStart = now;
        upsertTokenPolicyExecution.run({ tokenMint, policyVersion: policy.policy_version, lastExitAt: currentLastExitAt, tradesInWindow: 0, windowStart: now, updatedAt: now });
      }
      if (linkedExecRow != null && linkedExecRow.window_start != null && now - linkedExecRow.window_start < 3600) {
        tradesInWindow += linkedExecRow.trades_in_window;
      }
      executionTradesInWindow = tradesInWindow;
      executionWindowStart = windowStart;

      const baseReentrySec = policy.token_reentry_cooldown_seconds ?? 0;
      const afterWinSec = policy.token_reentry_cooldown_seconds_after_win ?? null;

      let effectiveCooldownSec = baseReentrySec;
      if (
        baseReentrySec > 0 &&
        afterWinSec != null &&
        afterWinSec < baseReentrySec &&
        lastOutcome === 'WIN'
      ) {
        const tokenStats = getTokenPolicyStats.get({ tokenMint, policyVersion: policy.policy_version }) as
          | { last_loss_at: number | null; consecutive_losses: number; last_exit_reason: string | null; updated_at: number }
          | undefined;
        const linkedTokenStats = linkedPolicyVersion
          ? (getTokenPolicyStats.get({ tokenMint, policyVersion: linkedPolicyVersion }) as typeof tokenStats)
          : undefined;
        const effectiveLastLossAt = maxNullableTs(tokenStats?.last_loss_at ?? null, linkedTokenStats?.last_loss_at ?? null);

        const priorityScore = policy.priority_trade_score ?? 85;
        const scoreNorm = score.total_score != null ? Number(score.total_score) : 0;
        const maxPerTokenPerHour = policy.max_trades_per_token_per_hour;
        const pairLossCooldownSec = policy.pair_loss_cooldown_seconds ?? 0;
        const inPairLossCooldown =
          pairLossCooldownSec > 0 &&
          effectiveLastLossAt != null &&
          now - effectiveLastLossAt < pairLossCooldownSec;

        const gatesPass =
          scoreNorm >= priorityScore &&
          (maxPerTokenPerHour == null || executionTradesInWindow < maxPerTokenPerHour) &&
          !inPairLossCooldown &&
          (policyCooldownUntil == null || now >= policyCooldownUntil);

        if (gatesPass) {
          effectiveCooldownSec = afterWinSec;
        }
      }

      if (effectiveCooldownSec > 0 && executionLastExitAt != null && now - executionLastExitAt < effectiveCooldownSec) {
        const skipReason: 'TOKEN_REENTRY_COOLDOWN_WIN' | 'TOKEN_REENTRY_COOLDOWN_LOSS' =
          afterWinSec != null && effectiveCooldownSec === afterWinSec && lastOutcome === 'WIN'
            ? 'TOKEN_REENTRY_COOLDOWN_WIN'
            : 'TOKEN_REENTRY_COOLDOWN_LOSS';
        insertTradeDecisionSkip.run({ pairAddress: score.pair_address, policyVersion: policy.policy_version, reason: skipReason, decidedAt: now, tokenMint });
        logSkipped(score.id, score.pair_address, skipReason, policy.policy_version, undefined, policyMarketMode, account.mode);
        continue;
      }

      if (effectiveCooldownSec > 0 && executionLastExitAt != null && lastOutcome === 'WIN' && afterWinSec != null && effectiveCooldownSec === afterWinSec) {
        usedWinReentryCooldown = true;
      }

      const maxPerTokenPerHour = policy.max_trades_per_token_per_hour;
      if (maxPerTokenPerHour != null && executionTradesInWindow >= maxPerTokenPerHour) {
        insertTradeDecisionSkip.run({ pairAddress: score.pair_address, policyVersion: policy.policy_version, reason: 'MAX_TRADES_PER_TOKEN', decidedAt: now, tokenMint });
        logSkipped(score.id, score.pair_address, 'MAX_TRADES_PER_TOKEN', policy.policy_version, undefined, policyMarketMode, account.mode);
        continue;
      }
    }

    // Token-scoped cooldowns for new trades; legacy fallback by pair_address.
    // When a linked policy exists, also check its stats so loss cooldowns carry over.
    type PairStatsRow = { last_loss_at: number | null; consecutive_losses: number; updated_at: number } | undefined;
    const pairLossCooldownSec = policy.pair_loss_cooldown_seconds ?? 0;
    if (pairLossCooldownSec > 0) {
      let stats: PairStatsRow;
      let linkedStats: PairStatsRow;
      if (tokenMint != null && tokenMint !== '') {
        stats = getTokenPolicyStats.get({ tokenMint, policyVersion: policy.policy_version }) as PairStatsRow;
        linkedStats = linkedPolicyVersion
          ? (getTokenPolicyStats.get({ tokenMint, policyVersion: linkedPolicyVersion }) as PairStatsRow)
          : undefined;
      } else {
        stats = getPairPolicyStats.get({ pairAddress: score.pair_address, policyVersion: policy.policy_version }) as PairStatsRow;
        linkedStats = linkedPolicyVersion
          ? (getPairPolicyStats.get({ pairAddress: score.pair_address, policyVersion: linkedPolicyVersion }) as PairStatsRow)
          : undefined;
      }
      const effectiveLastLossAt = maxNullableTs(stats?.last_loss_at ?? null, linkedStats?.last_loss_at ?? null);
      if (
        effectiveLastLossAt != null &&
        now - effectiveLastLossAt < pairLossCooldownSec
      ) {
        const remainingSec = effectiveLastLossAt + pairLossCooldownSec - now;
        const m = Math.floor(remainingSec / 60);
        const s = Math.floor(remainingSec % 60);
        const timeLeft = m > 0 ? `${m}m ${s}s` : `${s}s`;
        insertTradeDecisionSkip.run({ pairAddress: score.pair_address, policyVersion: policy.policy_version, reason: 'COOLDOWN_AFTER_PAIR_LOSS', decidedAt: now, tokenMint: tokenMint ?? null });
        logSkipped(score.id, score.pair_address, 'COOLDOWN_AFTER_PAIR_LOSS', policy.policy_version, undefined, policyMarketMode, account.mode);
        continue;
      }
    }

    const maxConsecutivePerPair = policy.max_consecutive_losses_per_pair;
    if (maxConsecutivePerPair != null && maxConsecutivePerPair >= 1) {
      let stats: PairStatsRow;
      let linkedStats: PairStatsRow;
      if (tokenMint != null && tokenMint !== '') {
        stats = getTokenPolicyStats.get({ tokenMint, policyVersion: policy.policy_version }) as PairStatsRow;
        linkedStats = linkedPolicyVersion
          ? (getTokenPolicyStats.get({ tokenMint, policyVersion: linkedPolicyVersion }) as PairStatsRow)
          : undefined;
      } else {
        stats = getPairPolicyStats.get({ pairAddress: score.pair_address, policyVersion: policy.policy_version }) as PairStatsRow;
        linkedStats = linkedPolicyVersion
          ? (getPairPolicyStats.get({ pairAddress: score.pair_address, policyVersion: linkedPolicyVersion }) as PairStatsRow)
          : undefined;
      }
      // Use whichever policy has the most recent data for this token/pair
      const effectiveStats = (stats?.updated_at ?? 0) >= (linkedStats?.updated_at ?? 0) ? stats : linkedStats;
      const effectiveConsecutive =
        effectiveStats?.last_loss_at != null && isSameCalendarDay(effectiveStats.last_loss_at, now)
          ? effectiveStats.consecutive_losses
          : 0;
      if (effectiveConsecutive >= maxConsecutivePerPair) {
        const remainingSec = secondsUntilNextMidnight(now);
        const h = Math.floor(remainingSec / 3600);
        const m = Math.floor((remainingSec % 3600) / 60);
        const s = Math.floor(remainingSec % 60);
        const timeLeft = h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
        insertTradeDecisionSkip.run({ pairAddress: score.pair_address, policyVersion: policy.policy_version, reason: 'MAX_CONSECUTIVE_LOSSES_PER_PAIR', decidedAt: now, tokenMint: tokenMint ?? null });
        logSkipped(score.id, score.pair_address, 'MAX_CONSECUTIVE_LOSSES_PER_PAIR', policy.policy_version, {
          time_left: timeLeft,
          remaining_seconds: remainingSec,
          resets_at: 'midnight',
          consecutive_losses: effectiveConsecutive,
          max_allowed: maxConsecutivePerPair,
        }, policyMarketMode, account.mode);
        continue;
      }
    }

    let entryPrice: number;
    let entrySnapshotId: number | null = null;
    try {
      const idsJson = score.snapshot_ids;
      const ids = idsJson ? (JSON.parse(idsJson) as number[]) : [];
      const firstId = ids[0];
      if (firstId != null) {
        const row = getSnapshotPrice.get({ snapshotId: firstId }) as { snapshot_id: number; price_usd: number | null } | undefined;
        if (row?.price_usd != null && Number.isFinite(row.price_usd)) {
          entryPrice = row.price_usd;
          entrySnapshotId = row.snapshot_id;
        } else {
          insertTradeDecisionSkip.run({ pairAddress: score.pair_address, policyVersion: policy.policy_version, reason: 'NO_ENTRY_PRICE', decidedAt: now, tokenMint: tokenMint ?? null });
          logSkipped(score.id, score.pair_address, 'NO_ENTRY_PRICE', policy.policy_version, undefined, policyMarketMode, account.mode);
          continue;
        }
      } else {
        insertTradeDecisionSkip.run({ pairAddress: score.pair_address, policyVersion: policy.policy_version, reason: 'NO_SNAPSHOT_IDS', decidedAt: now, tokenMint: tokenMint ?? null });
        logSkipped(score.id, score.pair_address, 'NO_SNAPSHOT_IDS', policy.policy_version, undefined, policyMarketMode, account.mode);
        continue;
      }
    } catch {
      insertTradeDecisionSkip.run({ pairAddress: score.pair_address, policyVersion: policy.policy_version, reason: 'NO_ENTRY_PRICE', decidedAt: now, tokenMint: tokenMint ?? null });
      logSkipped(score.id, score.pair_address, 'NO_ENTRY_PRICE', policy.policy_version, undefined, policyMarketMode, account.mode);
      continue;
    }

    // 1) Risk-based size → 2) Score multiplier → 3) Heat limit → 4) Balance → 5) Place trade (per-account)
    // For live Solana, use current USD balance for sizing; DB starting_equity is not synced.
    const sizingEquity =
      account.mode === 'live' && account.chain === 'solana'
        ? account.available_balance
        : account.starting_equity;
    const sizing = computePositionSizeUsd({
      account_equity: sizingEquity,
      risk_per_trade_pct: policy.risk_per_trade_pct,
      stop_loss_pct: policy.stop_loss_pct,
      score: score.total_score,
      min_trade_score: policy.min_trade_score,
      priority_trade_score: policy.priority_trade_score,
    });
    let positionSize = sizing.position_size_usd;
    if (positionSize <= 0) {
      insertTradeDecisionSkip.run({ pairAddress: score.pair_address, policyVersion: policy.policy_version, reason: 'INSUFFICIENT_BALANCE', decidedAt: now, tokenMint: tokenMint ?? null });
      const insufMeta: Record<string, number | string | null> = {
        account_name: account.name ?? account.account_id,
        amount_needed: positionSize,
        amount_in_account: account.available_balance,
      };
      if (account.mode === 'live' && account.chain === 'solana') {
        if (account.balance_native != null) insufMeta.amount_in_account_sol = account.balance_native;
        try {
          const solPrice = await getSolPriceUsd();
          insufMeta.amount_needed_sol = positionSize / solPrice;
        } catch {
          // omit amount_needed_sol if price fetch fails
        }
      }
      logSkipped(score.id, score.pair_address, 'INSUFFICIENT_BALANCE', policy.policy_version, insufMeta, policyMarketMode, account.mode);
      continue;
    }

    const newTradeRiskPct = sizing.risk_pct_at_entry ?? policy.risk_per_trade_pct ?? 5;
    const openRiskPct = computeOpenRiskPct(sizingEquity, openDecisions, stopLossPctByPolicyVersion);
    const currentOpenRiskPct = openRiskPct + cycleNewRiskPctRef.value;
    // Use actual risk % of this trade (position size may have been scaled by score multiplier and clamped)
    const stopLossPct = policy.stop_loss_pct != null && Number.isFinite(policy.stop_loss_pct) ? Math.abs(policy.stop_loss_pct) : 0;
    let actualNewTradeRiskPct =
      sizingEquity > 0 && stopLossPct > 0 && Number.isFinite(positionSize)
        ? (positionSize * (stopLossPct / 100) / sizingEquity) * 100
        : newTradeRiskPct;
    const deploymentAccountMaxRiskPct = account.max_total_risk_pct;
    const riskRoomPct = Math.max(0, deploymentAccountMaxRiskPct - currentOpenRiskPct);
    // Cap position size to fit within remaining risk room so we don't reject when a single trade would exceed max total risk
    if (actualNewTradeRiskPct > riskRoomPct && riskRoomPct >= 0 && stopLossPct > 0 && sizingEquity > 0) {
      const maxPositionForRoom = (riskRoomPct / 100) * sizingEquity / (stopLossPct / 100);
      if (maxPositionForRoom >= MIN_POSITION_SIZE_USD && maxPositionForRoom < positionSize) {
        positionSize = maxPositionForRoom;
        actualNewTradeRiskPct = (positionSize * (stopLossPct / 100) / sizingEquity) * 100;
      }
    }
    const computedRiskPct = currentOpenRiskPct + actualNewTradeRiskPct;
    if (computedRiskPct > deploymentAccountMaxRiskPct) {
      insertTradeDecisionSkip.run({ pairAddress: score.pair_address, policyVersion: policy.policy_version, reason: 'PORTFOLIO_HEAT_LIMIT', decidedAt: now, tokenMint: tokenMint ?? null });
      logSkipped(score.id, score.pair_address, 'PORTFOLIO_HEAT_LIMIT', policy.policy_version, {
        open_risk_pct: currentOpenRiskPct,
        new_trade_risk_pct: actualNewTradeRiskPct,
        computed_risk_pct: computedRiskPct,
        max_total_risk_pct: deploymentAccountMaxRiskPct,
      }, policyMarketMode, account.mode);
      continue;
    }

    if (positionSize > account.available_balance) {
      insertTradeDecisionSkip.run({ pairAddress: score.pair_address, policyVersion: policy.policy_version, reason: 'INSUFFICIENT_BALANCE', decidedAt: now, tokenMint: tokenMint ?? null });
      const insufMeta2: Record<string, number | string | null> = {
        account_name: account.name ?? account.account_id,
        amount_needed: positionSize,
        amount_in_account: account.available_balance,
      };
      if (account.mode === 'live' && account.chain === 'solana') {
        if (account.balance_native != null) insufMeta2.amount_in_account_sol = account.balance_native;
        try {
          const solPrice = await getSolPriceUsd();
          insufMeta2.amount_needed_sol = positionSize / solPrice;
        } catch {
          // omit amount_needed_sol if price fetch fails
        }
      }
      logSkipped(score.id, score.pair_address, 'INSUFFICIENT_BALANCE', policy.policy_version, insufMeta2, policyMarketMode, account.mode);
      continue;
    }

    // For live Solana: require enough SOL for trade + fees so we skip without hitting RPC when insufficient
    if (account.mode === 'live' && account.chain === 'solana') {
      const balanceSol = account.balance_native ?? 0;
      let requiredSol: number;
      try {
        const solPrice = await getSolPriceUsd();
        requiredSol = positionSize / solPrice + MIN_SOL_RESERVE_FOR_FEES;
      } catch {
        requiredSol = MIN_SOL_RESERVE_FOR_FEES; // require at least fee buffer when price unknown
      }
      if (balanceSol < requiredSol) {
        insertTradeDecisionSkip.run({ pairAddress: score.pair_address, policyVersion: policy.policy_version, reason: 'INSUFFICIENT_BALANCE', decidedAt: now, tokenMint: tokenMint ?? null });
        logSkipped(score.id, score.pair_address, 'INSUFFICIENT_BALANCE', policy.policy_version, {
          account_name: account.name ?? account.account_id,
          amount_needed: positionSize,
          amount_in_account: account.available_balance,
          amount_in_account_sol: balanceSol,
          required_sol: requiredSol,
          reason: 'insufficient SOL for trade + fees; skipping without RPC call',
        }, policyMarketMode, account.mode);
        continue;
      }
    }

    const reason = `signal=${score.signal}`;
    const entryDex = pairInfo?.dex ?? null;
    const entrySnapshotTs =
      entrySnapshotId != null
        ? (getSnapshotTimestamp.get({ snapshotId: entrySnapshotId }) as { timestamp: number } | undefined)?.timestamp ?? now
        : now;
    const order = {
      pair_address: score.pair_address,
      token_mint: tokenMint,
      entry_dex: entryDex,
      policy_version: policy.policy_version,
      market_mode: scoreMarketMode,
      signal: score.signal,
      entry_price: entryPrice,
      position_size_usd: positionSize,
      entry_snapshot_id: entrySnapshotId,
      entry_score_id: score.id,
      risk_pct_at_entry: Number.isFinite(actualNewTradeRiskPct) ? actualNewTradeRiskPct : (sizing.risk_pct_at_entry ?? null),
      score_size_multiplier: sizing.score_size_multiplier ?? null,
      entry_snapshot_ts: entrySnapshotTs,
      deployment_id: deploymentId,
      reason,
    };
    const result = await executeOrderForAccount(
      account as unknown as import('../executors/index.js').AccountForExecutor,
      order
    );
    if (!result.success) {
      const skipReason = isPoolAccountNotFound(result.skipReason)
        ? 'POOL_ACCOUNT_NOT_FOUND'
        : (result.skipReason ?? 'INSUFFICIENT_BALANCE');
      insertTradeDecisionSkip.run({ pairAddress: score.pair_address, policyVersion: policy.policy_version, reason: skipReason, decidedAt: now, tokenMint: tokenMint ?? null });
      let skipMetadata: Record<string, number | string | null> | undefined;
      if (skipReason === 'INSUFFICIENT_BALANCE') {
        skipMetadata = {
          account_name: account.name ?? account.account_id,
          amount_needed: order.position_size_usd,
          amount_in_account: account.available_balance,
        };
        if (account.mode === 'live' && account.chain === 'solana') {
          if (account.balance_native != null) skipMetadata.amount_in_account_sol = account.balance_native;
          try {
            const solPrice = await getSolPriceUsd();
            skipMetadata.amount_needed_sol = order.position_size_usd / solPrice;
          } catch {
            // omit amount_needed_sol if price fetch fails
          }
        }
      }
      logSkipped(score.id, score.pair_address, skipReason, policy.policy_version, skipMetadata, policyMarketMode, account.mode);
      continue;
    }
    cycleNewRiskPctRef.value += actualNewTradeRiskPct;

    if (usedWinReentryCooldown && tokenMint != null) {
      const afterWinSec = policy.token_reentry_cooldown_seconds_after_win ?? 0;
      console.log(
        JSON.stringify({
          event: 'TOKEN_REENTERED_AFTER_WIN',
          token_mint: tokenMint,
          policy_version: policy.policy_version,
          cooldown_seconds_used: afterWinSec,
        })
      );
    }

    account.available_balance -= positionSize;
    if (tokenMint != null && tokenMint !== '') {
      upsertTokenPolicyExecution.run({
        tokenMint,
        policyVersion: policy.policy_version,
        lastExitAt: executionLastExitAt,
        tradesInWindow: executionTradesInWindow + 1,
        windowStart: executionWindowStart,
        updatedAt: now,
      });
    }
    logDecision(
      score.id,
      score.pair_address,
      'EXECUTED',
      policy.policy_version,
      scoreMarketMode,
      reason,
      positionSize
    );
    openNow++;
  }
}

async function runCycle(runId: string): Promise<void> {
  const activePolicies = getAllActivePolicies.all() as PolicyRow[];
  if (activePolicies.length === 0) return;

  const now = Math.floor(Date.now() / 1000);
  const stopLossPctByPolicyVersion = new Map<string, number | null>();
  for (const p of activePolicies) {
    stopLossPctByPolicyVersion.set(p.policy_version, p.stop_loss_pct);
  }

  // Per-deployment: get deployments for each policy; for each deployment run executePolicy with that account.
  for (const policy of activePolicies) {
    const deployments = getActiveDeploymentsForPolicy(policy.policy_id);
    for (const { deployment_id, account, policy: _p } of deployments) {
      // Safety: account.is_active, deployment.is_active, policy.status already enforced by resolver.
      if (account.trading_enabled !== 1) continue;

      if (account.mode === 'live' && !isLiveTradingEnabled()) {
        console.log(
          JSON.stringify({
            event: 'execution_worker',
            reason: 'LIVE_DISABLED',
            account_id: account.account_id,
            policy_version: policy.policy_version,
            message: 'Live trading disabled (LIVE_TRADING_ENABLED), skipping',
          })
        );
        continue;
      }

      let balanceUsdForDrawdown: number | undefined;
      if (account.mode === 'live' && account.chain === 'solana' && account.balance_native != null && Number.isFinite(account.balance_native)) {
        try {
          const solPrice = await getSolPriceUsd();
          balanceUsdForDrawdown = account.balance_native * solPrice;
        } catch {
          balanceUsdForDrawdown = undefined;
        }
      }
      const globalDrawdownPct = dailyDrawdownPct(account.account_id, balanceUsdForDrawdown);
      const accountMaxDailyDrawdownPctRow = getAccountMaxDailyDrawdownPct.get({ accountId: account.account_id }) as { max_daily_drawdown_pct: number | null } | undefined;
      const accountMaxDailyDrawdownPct = accountMaxDailyDrawdownPctRow?.max_daily_drawdown_pct ?? null;

      if (
        accountMaxDailyDrawdownPct != null &&
        accountMaxDailyDrawdownPct > 0 &&
        globalDrawdownPct <= -accountMaxDailyDrawdownPct
      ) {
        console.log(
          JSON.stringify({
            event: 'execution_worker',
            message: 'Global drawdown limit reached, skipping deployment',
            account_id: account.account_id,
            deployment_id,
            policy_version: policy.policy_version,
            global_drawdown_pct: globalDrawdownPct,
            account_max_daily_drawdown_pct: accountMaxDailyDrawdownPct,
          })
        );
        continue;
      }

      const openTotal = (countOpenDecisionsForAccount.get({ accountId: account.account_id }) as { n: number }).n;
      const maxTotal = account.max_total_open_trades ?? null;
      if (maxTotal != null && maxTotal > 0 && openTotal >= maxTotal) continue;

      const openDecisions = getOpenDecisionsForAccount.all({ accountId: account.account_id }) as OpenDecisionRow[];
      const cycleNewRiskPctRef = { value: 0 };
      await executePolicy(
        policy,
        account as AccountRow,
        deployment_id,
        openDecisions,
        stopLossPctByPolicyVersion,
        cycleNewRiskPctRef,
        now,
        runId,
        globalDrawdownPct,
        accountMaxDailyDrawdownPct
      );
    }
  }
}

async function runContinuously(): Promise<void> {
  const countLiveSolana = db.prepare(
    `SELECT COUNT(*) AS n FROM accounts WHERE mode = 'live' AND chain = 'solana'`
  );
  const liveSolanaCount = (countLiveSolana.get({}) as { n: number }).n;
  warnIfSolanaKeyMissing(liveSolanaCount);
  console.log(
    JSON.stringify({
      event: 'execution_worker',
      message: 'Starting, running continuously',
      decision_loop_delay_ms: DECISION_LOOP_DELAY_MS,
    })
  );
  while (true) {
    await runCycle(randomUUID());
    await new Promise((r) => setTimeout(r, DECISION_LOOP_DELAY_MS));
  }
}

export function startExecutionWorker(): void {
  void runContinuously().catch((err) => {
    console.error('[execution-worker] Fatal:', err);
    process.exit(1);
  });
}

const isMain =
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1]?.endsWith('execution-worker.js');

if (isMain) {
  startExecutionWorker();
}
