import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Connection } from '@solana/web3.js';
import { db, DEFAULT_PAPER_ACCOUNT_ID } from '../db.js';
import { getSolanaRpcUrl } from '../config.js';
import { computeVolumePersistence } from '../rolling-volume-baselines.js';
import { evaluateRugExit, type RugExitReason } from '../rug-exit.js';
import { getAccountById } from '../deployment-resolver.js';
import { executeLiveExitSell } from '../executors/solana.js';
import { getSolPriceUsd } from '../sol-price.js';
import { getPaperExitQuote } from '../pool-quote.js';
import { getPoolPriceLiquidityBatch } from '../pools/pool-price-liquidity-batch.js';
import type { AccountForExecutor, ExecutionOrder } from '../executors/types.js';

const POLL_INTERVAL_MS = 10_000; // 10 seconds between cycles

export type ExitReason = 'STOP_LOSS' | 'TAKE_PROFIT' | 'TIME_STOP' | 'TIME_STOP_NO_SNAPSHOTS' | 'VOLUME_COLLAPSE' | RugExitReason;

export interface OpenDecisionRow {
  trade_id: number;
  pair_address: string;
  token_mint: string | null;
  entry_dex: string | null;
  policy_version: string;
  market_mode: string;
  entry_price: number;
  position_size_usd: number;
  executed_at: number;
  entry_snapshot_id: number | null;
  entry_score_id: number | null;
  consecutive_volume_collapse_count: number;
  last_volume_ratio: number | null;
  risk_pct_at_entry: number | null;
  score_size_multiplier: number | null;
  pair_missing_failures: number;
  account_id: string | null;
  deployment_id: string | null;
  execution_mode: string | null;
  chain: string | null;
  last_snapshot_timestamp: number | null;
  /** Entry (open) transaction fields from live fill */
  tx_signature: string | null;
  execution_status: string | null;
  actual_entry_price: number | null;
  sol_price_at_entry: number | null;
  slippage_bps_realized: number | null;
  execution_latency_ms: number | null;
  entry_slippage_bps_used: number | null;
  tokens_received: number | null;
  actual_usd_bought: number | null;
}

export interface PolicyRow {
  policy_id: number;
  time_stop_seconds: number | null;
  stop_loss_pct: number | null;
  take_profit_pct: number | null;
  cooldown_on_consecutive_losses: number | null;
  cooldown_on_consecutive_losses_seconds: number | null;
  volume_collapse_exit_enabled: number | null;
  volume_collapse_ratio_threshold: number | null;
  volume_collapse_consecutive_checks: number | null;
  volume_collapse_min_samples: number | null;
  rug_exit_enabled: number | null;
  rug_liquidity_floor_usd: number | null;
  rug_snapshot_stale_seconds: number | null;
  rug_pair_missing_threshold: number | null;
}

export interface ExitEvaluationResult {
  shouldExit: boolean;
  exitReason?: ExitReason;
  exitPrice?: number;
  last_volume_ratio?: number | null;
  volumeCollapseState?: { consecutive: number; lastRatio: number | null };
}

/** True if the swap failed because the pool does not exist (do not retry for this pair). */
function isPoolAccountNotFound(skipReason: string | undefined): boolean {
  if (!skipReason) return false;
  return skipReason.includes('Pool account not found');
}

/** When true, we close the trade in DB (no exit tx) so we don't retry. */
function shouldCloseTradeOnExitSellFailure(skipReason: string | undefined): boolean {
  if (!skipReason) return false;
  if (isPoolAccountNotFound(skipReason)) return true;
  if (skipReason === 'SOLANA_SWAP_SELL_INSUFFICIENT_TOKEN_BALANCE') return true;
  if (skipReason.includes('SOLANA_SWAP_SELL_ZERO_OUTPUT')) return true; // pool too illiquid (pre-check)
  if (skipReason.includes('0x1789') || skipReason.includes('DivisionByZero') || skipReason.includes('Error Number: 6025')) return true; // PumpSwap division by zero (simulation/on-chain)
  if (skipReason.includes('0x1780') || skipReason.includes('Error Number: 6016') || skipReason.includes('buyMoreBaseAmountThanPoolReserves')) return true; // PumpSwap requesting more base than pool reserves
  if (skipReason.includes('ZeroBaseAmount')) return true; // liquidity rug (pool has no base to give)
  return false;
}

/** Build an ExecutionOrder for a live exit sell from an open decision and exit reason. */
function buildExitOrder(dec: OpenDecisionRow, exitReason: string): ExecutionOrder {
  return {
    pair_address: dec.pair_address,
    token_mint: dec.token_mint,
    entry_dex: dec.entry_dex,
    policy_version: dec.policy_version,
    market_mode: dec.market_mode,
    signal: 'SELL',
    entry_price: dec.entry_price,
    position_size_usd: dec.position_size_usd,
    entry_snapshot_id: dec.entry_snapshot_id,
    entry_score_id: dec.entry_score_id ?? null,
    risk_pct_at_entry: dec.risk_pct_at_entry ?? null,
    score_size_multiplier: dec.score_size_multiplier ?? null,
    entry_snapshot_ts: dec.executed_at,
    deployment_id: dec.deployment_id ?? '',
    reason: `exit=${exitReason}`,
  };
}

// Open positions: trade_decisions (exit_recorded_at IS NULL). Process ALL open decisions regardless of
// policy_deployments.is_active or policy status so exits complete even when a deployment is deactivated.
const getOpenDecisions = db.prepare(`
  SELECT trade_id, pair_address, token_mint, entry_dex, policy_version, market_mode, entry_price, position_size_usd, executed_at, entry_snapshot_id, entry_score_id,
    COALESCE(consecutive_volume_collapse_count, 0) AS consecutive_volume_collapse_count, last_volume_ratio,
    risk_pct_at_entry, score_size_multiplier,
    COALESCE(pair_missing_failures, 0) AS pair_missing_failures, last_snapshot_timestamp,
    account_id, deployment_id, execution_mode, chain,
    tx_signature, execution_status, actual_entry_price, slippage_bps_realized, execution_latency_ms,
    sol_price_at_entry, entry_slippage_bps_used, tokens_received, actual_usd_bought
  FROM trade_decisions
  WHERE exit_recorded_at IS NULL
`);

const getOpenDecisionByTradeId = db.prepare(`
  SELECT trade_id, pair_address, token_mint, entry_dex, policy_version, market_mode, entry_price, position_size_usd, executed_at, entry_snapshot_id, entry_score_id,
    COALESCE(consecutive_volume_collapse_count, 0) AS consecutive_volume_collapse_count, last_volume_ratio,
    risk_pct_at_entry, score_size_multiplier,
    COALESCE(pair_missing_failures, 0) AS pair_missing_failures, last_snapshot_timestamp,
    account_id, deployment_id, execution_mode, chain,
    tx_signature, execution_status, actual_entry_price, slippage_bps_realized, execution_latency_ms,
    sol_price_at_entry, entry_slippage_bps_used, tokens_received, actual_usd_bought
  FROM trade_decisions
  WHERE trade_id = $tradeId AND exit_recorded_at IS NULL
`);

/** Load policy by version regardless of status so exits are evaluated for open trades from inactive/retired policies. */
const getPolicyByVersion = db.prepare(`
  SELECT policy_id, time_stop_seconds, stop_loss_pct, take_profit_pct,
    cooldown_on_consecutive_losses, cooldown_on_consecutive_losses_seconds,
    volume_collapse_exit_enabled, volume_collapse_ratio_threshold, volume_collapse_consecutive_checks, volume_collapse_min_samples,
    rug_exit_enabled, rug_liquidity_floor_usd, rug_snapshot_stale_seconds, rug_pair_missing_threshold
  FROM policies
  WHERE policy_version = $policyVersion
`);

const getLatestSnapshotByPair = db.prepare(`
  SELECT volume_5m, rolling_avg_volume_1h, rolling_volume_sample_count
  FROM pair_snapshots WHERE pair_address = $pairAddress ORDER BY timestamp DESC LIMIT 1
`);

/** Latest snapshot for rug evaluation and exit_snapshot_id: snapshot_id, timestamp, liquidity_usd, price_usd. */
const getLatestSnapshotFullByPair = db.prepare(`
  SELECT snapshot_id, timestamp, liquidity_usd, price_usd
  FROM pair_snapshots WHERE pair_address = $pairAddress ORDER BY timestamp DESC LIMIT 1
`);

const updateDecisionCollapseState = db.prepare(`
  UPDATE trade_decisions SET consecutive_volume_collapse_count = $consecutive, last_volume_ratio = $lastVolumeRatio WHERE trade_id = $tradeId
`);

const updateDecisionRugState = db.prepare(`
  UPDATE trade_decisions SET pair_missing_failures = $pairMissingFailures, last_snapshot_timestamp = $lastSnapshotTimestamp WHERE trade_id = $tradeId
`);

const getPolicyExecutionState = db.prepare(`
  SELECT consecutive_loss_count, policy_cooldown_until FROM policy_execution_state WHERE policy_version = $policyVersion
`);
const upsertPolicyExecutionStateCooldown = db.prepare(`
  INSERT INTO policy_execution_state (policy_version, last_blocked_at, policy_cooldown_until, consecutive_loss_count)
  VALUES ($policyVersion, NULL, $policyCooldownUntil, $consecutiveLossCount)
  ON CONFLICT(policy_version) DO UPDATE SET
    policy_cooldown_until = excluded.policy_cooldown_until,
    consecutive_loss_count = excluded.consecutive_loss_count
`);

const getBaseTokenByPairAddress = db.prepare(`
  SELECT base_token_address FROM pairs WHERE pair_address = $pairAddress
`);

const setDecisionExitRecorded = db.prepare(`
  UPDATE trade_decisions SET exit_recorded_at = $exitRecordedAt WHERE trade_id = $tradeId
`);

const releaseBalanceOnExit = db.prepare(`
  UPDATE accounts SET current_equity = current_equity + $realizedPnlUsd, available_balance = available_balance + $positionSizeUsd + $realizedPnlUsd, updated_at = $updatedAt
  WHERE account_id = $accountId
`);

const insertTrade = db.prepare(`
  INSERT INTO trades (
    pair_address, token_mint, entry_pair_address, entry_dex, policy_version, entry_snapshot_id, entry_score_id, exit_snapshot_id, entry_time, exit_time,
    entry_price, exit_price, position_size_usd, exit_reason, pnl_pct, last_volume_ratio, risk_pct_at_entry, score_size_multiplier,
    is_forced_exit, exit_metadata, exit_liquidity_usd, snapshot_age_at_exit,
    account_id, deployment_id, execution_mode, chain,
    tx_signature, execution_status, actual_entry_price, slippage_bps_realized, execution_latency_ms, exit_tx_signature,
    actual_usd_bought, actual_usd_sold, sol_received, sol_price_used, sol_price_at_entry, actual_exit_price,
    entry_slippage_bps_used, exit_slippage_bps_used, tokens_received, tokens_sold, fee_lamports
  ) VALUES ($pairAddress, $tokenMint, $entryPairAddress, $entryDex, $policyVersion, $entrySnapshotId, $entryScoreId, $exitSnapshotId, $entryTime, $exitTime,
    $entryPrice, $exitPrice, $positionSizeUsd, $exitReason, $pnlPct, $lastVolumeRatio, $riskPctAtEntry, $scoreSizeMultiplier,
    $isForcedExit, $exitMetadata, $exitLiquidityUsd, $snapshotAgeAtExit,
    $accountId, $deploymentId, $executionMode, $chain,
    $txSignature, $executionStatus, $actualEntryPrice, $slippageBpsRealized, $executionLatencyMs, $exitTxSignature,
    $actualUsdBought, $actualUsdSold, $solReceived, $solPriceUsed, $solPriceAtEntry, $actualExitPrice,
    $entrySlippageBpsUsed, $exitSlippageBpsUsed, $tokensReceived, $tokensSold, $feeLamports)
`);

const getPairPolicyStats = db.prepare(`
  SELECT last_loss_at, consecutive_losses, updated_at
  FROM pair_policy_stats
  WHERE pair_address = $pairAddress AND policy_version = $policyVersion
`);

const upsertPairPolicyStats = db.prepare(`
  INSERT OR REPLACE INTO pair_policy_stats (pair_address, policy_version, last_loss_at, consecutive_losses, last_exit_reason, updated_at)
  VALUES ($pairAddress, $policyVersion, $lastLossAt, $consecutiveLosses, $lastExitReason, $updatedAt)
`);

const getTokenPolicyStats = db.prepare(`
  SELECT last_loss_at, consecutive_losses, updated_at
  FROM token_policy_stats
  WHERE token_mint = $tokenMint AND policy_version = $policyVersion
`);

const upsertTokenPolicyStats = db.prepare(`
  INSERT OR REPLACE INTO token_policy_stats (token_mint, policy_version, last_loss_at, consecutive_losses, last_exit_reason, updated_at)
  VALUES ($tokenMint, $policyVersion, $lastLossAt, $consecutiveLosses, $lastExitReason, $updatedAt)
`);

const updateTokenPolicyExecutionExit = db.prepare(`
  UPDATE token_policy_execution SET last_exit_at = $lastExitAt, last_trade_outcome = $lastTradeOutcome, updated_at = $updatedAt WHERE token_mint = $tokenMint AND policy_version = $policyVersion
`);
const insertTokenPolicyExecutionExit = db.prepare(`
  INSERT INTO token_policy_execution (token_mint, policy_version, last_exit_at, last_trade_outcome, trades_in_window, window_start, updated_at)
  VALUES ($tokenMint, $policyVersion, $lastExitAt, $lastTradeOutcome, 0, $windowStart, $updatedAt)
`);

function isSameCalendarDay(unixA: number, unixB: number): boolean {
  const dA = new Date(unixA * 1000);
  const dB = new Date(unixB * 1000);
  return (
    dA.getFullYear() === dB.getFullYear() &&
    dA.getMonth() === dB.getMonth() &&
    dA.getDate() === dB.getDate()
  );
}

/** Snapshot row for volume collapse (volume_5m, rolling_avg_volume_1h, rolling_volume_sample_count). */
export type VolumeSnapshotRow = {
  volume_5m: number | null;
  rolling_avg_volume_1h: number | null;
  rolling_volume_sample_count: number | null;
} | null;

const EXIT_LOG_PREFIX = '[exit-worker]';

/**
 * Centralized exit evaluation (pure). Order: hard stop loss → take profit → volume collapse → time stop.
 */
export function evaluateExitConditions(
  trade: OpenDecisionRow,
  policy: PolicyRow,
  currentPrice: number,
  now: number,
  volumeSnapshot: VolumeSnapshotRow
): ExitEvaluationResult {
  const pnlPct =
    trade.entry_price !== 0
      ? ((currentPrice - trade.entry_price) / trade.entry_price) * 100
      : 0;

  const stopLossPct = policy.stop_loss_pct;
  const takeProfitPct = policy.take_profit_pct;
  const timeStopSec = policy.time_stop_seconds;

  if (stopLossPct != null && Number.isFinite(stopLossPct) && pnlPct <= stopLossPct) {
    return { shouldExit: true, exitReason: 'STOP_LOSS', exitPrice: currentPrice };
  }
  if (takeProfitPct != null && Number.isFinite(takeProfitPct) && pnlPct >= takeProfitPct) {
    return { shouldExit: true, exitReason: 'TAKE_PROFIT', exitPrice: currentPrice };
  }

  const collapseEnabled = policy.volume_collapse_exit_enabled === 1;
  const threshold = policy.volume_collapse_ratio_threshold ?? 0.35;
  const consecutiveChecks = policy.volume_collapse_consecutive_checks ?? 2;
  const minSamples = policy.volume_collapse_min_samples ?? 6;
  const currentConsecutive = trade.consecutive_volume_collapse_count ?? 0;

  if (collapseEnabled && volumeSnapshot != null) {
    const ratio = computeVolumePersistence(
      {
        volume_5m: volumeSnapshot.volume_5m ?? undefined,
        volume_5m_usd: volumeSnapshot.volume_5m ?? undefined,
        rolling_avg_volume_1h: volumeSnapshot.rolling_avg_volume_1h ?? undefined,
        rolling_volume_sample_count: volumeSnapshot.rolling_volume_sample_count ?? undefined,
      },
      minSamples
    );
    if (ratio != null) {
      const belowThreshold = ratio < threshold;
      const newConsecutive = belowThreshold ? currentConsecutive + 1 : 0;
      if (newConsecutive >= consecutiveChecks) {
        if (belowThreshold && currentConsecutive + 1 === consecutiveChecks) {
          console.debug(`${EXIT_LOG_PREFIX} volume_collapse exit trade_id=${trade.trade_id} ratio=${ratio.toFixed(3)}`);
        }
        return { shouldExit: true, exitReason: 'VOLUME_COLLAPSE', exitPrice: currentPrice, last_volume_ratio: ratio };
      }
      if (belowThreshold && newConsecutive > 0) {
        console.debug(`${EXIT_LOG_PREFIX} volume_collapse counter=${newConsecutive} trade_id=${trade.trade_id} ratio=${ratio.toFixed(3)}`);
      } else if (!belowThreshold && currentConsecutive > 0) {
        console.debug(`${EXIT_LOG_PREFIX} volume_collapse reset trade_id=${trade.trade_id}`);
      }
      return { shouldExit: false, volumeCollapseState: { consecutive: newConsecutive, lastRatio: ratio } };
    }
  }

  if (timeStopSec != null && timeStopSec > 0 && now - trade.executed_at >= timeStopSec) {
    return { shouldExit: true, exitReason: 'TIME_STOP', exitPrice: currentPrice };
  }
  return { shouldExit: false };
}

/**
 * When there is no valid snapshot price, only time stop can be evaluated.
 * If time stop is exceeded, return shouldExit with reason TIME_STOP_NO_SNAPSHOTS.
 */
function evaluateTimeStopOnly(
  trade: OpenDecisionRow,
  policy: PolicyRow,
  now: number
): { shouldExit: false } | { shouldExit: true; exitReason: 'TIME_STOP_NO_SNAPSHOTS' } {
  const timeStopSec = policy.time_stop_seconds;
  if (timeStopSec == null || timeStopSec <= 0) return { shouldExit: false };
  if (now - trade.executed_at >= timeStopSec) {
    return { shouldExit: true, exitReason: 'TIME_STOP_NO_SNAPSHOTS' };
  }
  return { shouldExit: false };
}

async function runCycle(_runId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const openDecisions = getOpenDecisions.all({}) as OpenDecisionRow[];

  /** Batched RPC price + liquidity for PumpSwap pairs with open positions. Fetched once per cycle. */
  let rpcPriceLiquidityByPair = new Map<string, { priceUsd: number; liquidityUsd: number } | null>();
  if (openDecisions.length > 0) {
    const rpcUrl = getSolanaRpcUrl();
    if (rpcUrl) {
      try {
        const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
        const pairs = openDecisions.map((d) => ({
          pairAddress: d.pair_address,
          tokenMint: d.token_mint ?? '',
          entryDex: d.entry_dex,
        }));
        rpcPriceLiquidityByPair = await getPoolPriceLiquidityBatch(connection, pairs, getSolPriceUsd);
      } catch {
        // Fall back to snapshot-only for this cycle
      }
    }
  }

  for (const dec of openDecisions) {
    const policy = getPolicyByVersion.get({ policyVersion: dec.policy_version }) as PolicyRow | undefined;
    if (!policy) continue;

    const latestSnapshotRow = getLatestSnapshotFullByPair.get({ pairAddress: dec.pair_address }) as
      | { snapshot_id: number; timestamp: number; liquidity_usd: number | null; price_usd: number | null }
      | undefined;

    const rpcData = rpcPriceLiquidityByPair.get(dec.pair_address);
    const latestSnapshotForRug =
      rpcData != null
        ? { timestamp: now, liquidity_usd: rpcData.liquidityUsd, price_usd: rpcData.priceUsd }
        : latestSnapshotRow != null
          ? {
              timestamp: latestSnapshotRow.timestamp,
              liquidity_usd: latestSnapshotRow.liquidity_usd ?? null,
              price_usd: latestSnapshotRow.price_usd ?? null,
            }
          : null;

    const pairMissingFailures = latestSnapshotForRug == null ? dec.pair_missing_failures + 1 : 0;
    const lastSnapshotTimestamp = latestSnapshotForRug?.timestamp ?? dec.last_snapshot_timestamp;
    updateDecisionRugState.run({ pairMissingFailures, lastSnapshotTimestamp, tradeId: dec.trade_id });

    const decWithUpdatedRugState: OpenDecisionRow = {
      ...dec,
      pair_missing_failures: pairMissingFailures,
      last_snapshot_timestamp: lastSnapshotTimestamp,
    };

    if (policy.rug_exit_enabled === 1) {
      const rug = evaluateRugExit({
        trade: { pair_missing_failures: decWithUpdatedRugState.pair_missing_failures, last_snapshot_timestamp: decWithUpdatedRugState.last_snapshot_timestamp },
        policy: {
          rug_exit_enabled: policy.rug_exit_enabled,
          rug_liquidity_floor_usd: policy.rug_liquidity_floor_usd,
          rug_snapshot_stale_seconds: policy.rug_snapshot_stale_seconds,
          rug_pair_missing_threshold: policy.rug_pair_missing_threshold,
        },
        latestSnapshot: latestSnapshotForRug,
        nowTs: now,
      });
      if (rug.shouldExit && rug.reason != null) {
        const exitPrice = latestSnapshotForRug?.price_usd != null && Number.isFinite(latestSnapshotForRug.price_usd)
          ? latestSnapshotForRug.price_usd
          : dec.entry_price;
        const exitLiquidityUsd = latestSnapshotForRug?.liquidity_usd ?? (rug.metadata?.liquidity_usd as number | undefined) ?? null;
        const snapshotAgeAtExit =
          rug.metadata?.snapshot_age_seconds != null
            ? (rug.metadata.snapshot_age_seconds as number)
            : decWithUpdatedRugState.last_snapshot_timestamp != null
              ? now - decWithUpdatedRugState.last_snapshot_timestamp
              : null;
        const actualUsdBought = dec.actual_usd_bought ?? dec.position_size_usd;
        let actualUsdSold =
          dec.entry_price !== 0 ? dec.position_size_usd * (exitPrice / dec.entry_price) : dec.position_size_usd;

        const accountId = dec.account_id ?? DEFAULT_PAPER_ACCOUNT_ID;
        const executionMode = dec.execution_mode ?? 'paper';
        let exitTxSignature: string | null = null;
        let solReceived: number | null = null;
        let solPriceUsed: number | null = null;
        let effectiveExitPriceUsd: number | null = null;
        let exitSlippageBpsUsed: number | null = null;
        /** From chain only (exit tx token balance delta). Never derived from USD/notional. */
        let tokensSold: number | null = null;
        let feeLamports: number | null = null;
        /** When sell fails with this, we treat as liquidity rug (everything lost). */
        let exitSellSkipReason: string | undefined;
        if (executionMode === 'live' && dec.token_mint) {
          const account = getAccountById(accountId);
          if (account && account.chain === 'solana') {
            const exitOrder = buildExitOrder(dec, rug.reason);
            const sellResult = await executeLiveExitSell(
              account as AccountForExecutor,
              exitOrder
            );
            if (!sellResult.success) {
              console.error(
                JSON.stringify({
                  worker: 'ExitWorker',
                  event: 'LiveExitSellFailed',
                  trade_id: dec.trade_id,
                  reason: rug.reason,
                  skip_reason: sellResult.skipReason,
                })
              );
              if (shouldCloseTradeOnExitSellFailure(sellResult.skipReason)) {
                exitTxSignature = null;
                exitSellSkipReason = sellResult.skipReason;
                // Fall through to close position in DB so we don't retry
              } else {
                continue;
              }
            } else {
              exitTxSignature = sellResult.txSignature ?? null;
              if (sellResult.actualUsdReceived != null && Number.isFinite(sellResult.actualUsdReceived)) {
                actualUsdSold = sellResult.actualUsdReceived;
              }
              if (sellResult.solReceived != null && Number.isFinite(sellResult.solReceived)) solReceived = sellResult.solReceived;
              if (sellResult.solPriceUsd != null && Number.isFinite(sellResult.solPriceUsd)) solPriceUsed = sellResult.solPriceUsd;
              if (sellResult.effectiveExitPriceUsd != null && Number.isFinite(sellResult.effectiveExitPriceUsd)) {
                effectiveExitPriceUsd = sellResult.effectiveExitPriceUsd;
              }
              if (sellResult.slippageBpsUsed != null && Number.isFinite(sellResult.slippageBpsUsed)) exitSlippageBpsUsed = sellResult.slippageBpsUsed;
              if (sellResult.tokensSold != null && Number.isFinite(sellResult.tokensSold)) tokensSold = sellResult.tokensSold;
              if (sellResult.feeLamports != null && Number.isFinite(sellResult.feeLamports)) feeLamports = sellResult.feeLamports;
            }
          }
        }
        if (rug.reason === 'LIQUIDITY_RUG_FLOOR' || (exitSellSkipReason != null && exitSellSkipReason.includes('ZeroBaseAmount'))) {
          actualUsdSold = 0;
          solReceived = null;
          tokensSold = null;
          effectiveExitPriceUsd = null;
        }
        if (solPriceUsed == null) {
          try {
            solPriceUsed = await getSolPriceUsd();
          } catch {
            // leave null if fetch fails
          }
        }
        if (solReceived == null && actualUsdSold != null && solPriceUsed != null && solPriceUsed > 0) {
          solReceived = actualUsdSold / solPriceUsed;
        }
        const realizedPnlUsd = actualUsdSold - actualUsdBought;
        const pnlPct =
          actualUsdBought !== 0 ? (realizedPnlUsd / actualUsdBought) * 100 : 0;
        const actualExitPrice =
          effectiveExitPriceUsd != null && Number.isFinite(effectiveExitPriceUsd)
            ? effectiveExitPriceUsd
            : dec.position_size_usd !== 0 &&
              actualUsdSold != null &&
              Number.isFinite(actualUsdSold)
            ? (actualUsdSold * dec.entry_price) / dec.position_size_usd
            : null;
    db.transaction(() => {
      const recheck = getOpenDecisionByTradeId.get({ tradeId: dec.trade_id }) as OpenDecisionRow | undefined;
      if (!recheck) return;
      releaseBalanceOnExit.run({ realizedPnlUsd, positionSizeUsd: dec.position_size_usd, updatedAt: now, accountId });
      setDecisionExitRecorded.run({ exitRecordedAt: now, tradeId: dec.trade_id });
      insertTrade.run({
        pairAddress: dec.pair_address,
        tokenMint: dec.token_mint ?? null,
        entryPairAddress: dec.pair_address,
        entryDex: dec.entry_dex ?? null,
        policyVersion: dec.policy_version,
        entrySnapshotId: dec.entry_snapshot_id,
        entryScoreId: dec.entry_score_id ?? null,
        exitSnapshotId: latestSnapshotRow?.snapshot_id ?? null,
        entryTime: dec.executed_at,
        exitTime: now,
        entryPrice: dec.entry_price,
        exitPrice,
        positionSizeUsd: dec.position_size_usd,
        exitReason: rug.reason,
        pnlPct,
        lastVolumeRatio: null,
        riskPctAtEntry: dec.risk_pct_at_entry ?? null,
        scoreSizeMultiplier: dec.score_size_multiplier ?? null,
        isForcedExit: 1,
        exitMetadata: rug.metadata != null ? JSON.stringify(rug.metadata) : null,
        exitLiquidityUsd: exitLiquidityUsd ?? null,
        snapshotAgeAtExit: snapshotAgeAtExit ?? null,
        accountId,
        deploymentId: dec.deployment_id ?? null,
        executionMode,
        chain: dec.chain ?? 'paper',
        txSignature: dec.tx_signature ?? null,
        executionStatus: dec.execution_status ?? null,
        actualEntryPrice: dec.actual_entry_price ?? null,
        slippageBpsRealized: dec.slippage_bps_realized ?? null,
        executionLatencyMs: dec.execution_latency_ms ?? null,
        exitTxSignature,
        actualUsdBought,
        actualUsdSold,
        solReceived,
        solPriceUsed,
        solPriceAtEntry: dec.sol_price_at_entry ?? null,
        actualExitPrice,
        entrySlippageBpsUsed: dec.entry_slippage_bps_used ?? null,
        exitSlippageBpsUsed,
        tokensReceived: dec.tokens_received ?? null,
        tokensSold,
        feeLamports,
      });
        })();
        continue;
      }
    }

    const tokenMintForPrice =
      dec.token_mint != null && dec.token_mint !== ''
        ? dec.token_mint
        : (getBaseTokenByPairAddress.get({ pairAddress: dec.pair_address }) as { base_token_address: string } | undefined)?.base_token_address ?? null;

    if (!tokenMintForPrice) continue;

    const rpcPriceLiquidity = rpcPriceLiquidityByPair.get(dec.pair_address);
    const hasValidRpcPrice = rpcPriceLiquidity != null && Number.isFinite(rpcPriceLiquidity.priceUsd) && rpcPriceLiquidity.priceUsd > 0;
    const hasValidSnapshotPrice =
      latestSnapshotRow != null &&
      latestSnapshotRow.price_usd != null &&
      Number.isFinite(latestSnapshotRow.price_usd);

    const hasValidPrice = hasValidRpcPrice || hasValidSnapshotPrice;
    const currentPriceFromRpc = hasValidRpcPrice ? rpcPriceLiquidity!.priceUsd : null;
    const currentPriceFromSnapshot = hasValidSnapshotPrice ? latestSnapshotRow!.price_usd! : null;
    const currentPrice = currentPriceFromRpc ?? currentPriceFromSnapshot;

    let exitReason: ExitReason;
    let exitPrice: number;
    let exitSnapshotIdFromSnapshot: number | null;
    let lastVolumeRatio: number | null = null;

    if (hasValidPrice && currentPrice != null && Number.isFinite(currentPrice)) {
      exitSnapshotIdFromSnapshot = latestSnapshotRow?.snapshot_id ?? null;
      const volumeSnapshot = (getLatestSnapshotByPair.get({ pairAddress: dec.pair_address }) ?? null) as VolumeSnapshotRow;
      const result = evaluateExitConditions(dec, policy, currentPrice, now, volumeSnapshot);

      if (result.volumeCollapseState != null) {
        updateDecisionCollapseState.run({
          consecutive: result.volumeCollapseState.consecutive,
          lastVolumeRatio: result.volumeCollapseState.lastRatio,
          tradeId: dec.trade_id,
        });
      }
      if (!result.shouldExit || result.exitReason == null || result.exitPrice == null) continue;

      exitReason = result.exitReason;
      exitPrice = result.exitPrice;
      lastVolumeRatio = result.last_volume_ratio ?? null;
    } else {
      const timeStopOnly = evaluateTimeStopOnly(dec, policy, now);
      if (!timeStopOnly.shouldExit) continue;
      exitReason = timeStopOnly.exitReason;
      exitPrice = dec.entry_price;
      exitSnapshotIdFromSnapshot = latestSnapshotRow?.snapshot_id ?? null;
    }

    const holdSeconds = now - dec.executed_at;
    const actualUsdBought = dec.actual_usd_bought ?? dec.position_size_usd;
    let actualUsdSold =
      dec.entry_price !== 0 ? dec.position_size_usd * (exitPrice / dec.entry_price) : dec.position_size_usd;

    const accountId = dec.account_id ?? DEFAULT_PAPER_ACCOUNT_ID;
    const executionMode = dec.execution_mode ?? 'paper';
    let exitTxSignature: string | null = null;
    let solReceived: number | null = null;
    let solPriceUsed: number | null = null;
    let effectiveExitPriceUsd: number | null = null;
        let exitSlippageBpsUsed: number | null = null;
        /** From chain only (exit tx token balance delta). Never derived from USD/notional. */
        let tokensSold: number | null = null;
        let feeLamports: number | null = null;
        /** When sell fails with this, we treat as liquidity rug (everything lost). */
        let exitSellSkipReason: string | undefined;

    if (executionMode === 'paper' && dec.token_mint && dec.pair_address && dec.entry_dex && dec.entry_price > 0) {
      const tokenAmountToSell = dec.tokens_received ?? dec.position_size_usd / dec.entry_price;
      if (Number.isFinite(tokenAmountToSell) && tokenAmountToSell > 0) {
        const rpcUrl = getSolanaRpcUrl();
        if (rpcUrl) {
          try {
            const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
            const quote = await getPaperExitQuote({
              connection,
              pairAddress: dec.pair_address,
              tokenMint: dec.token_mint,
              tokenAmountToSell,
              entryDex: dec.entry_dex,
              getSolPriceUsd,
            });
            if (quote != null && Number.isFinite(quote.actualUsdSold) && quote.actualUsdSold >= 0) {
              actualUsdSold = quote.actualUsdSold;
              solReceived = quote.solReceived;
              solPriceUsed = quote.solPriceUsd;
              tokensSold = tokenAmountToSell;
              const minLiquidityUsd = policy.rug_liquidity_floor_usd ?? 1;
              if (
                Number.isFinite(quote.liquidityUsd) &&
                (quote.liquidityUsd === 0 || quote.liquidityUsd < minLiquidityUsd)
              ) {
                actualUsdSold = 0;
                solReceived = null;
                tokensSold = null;
                exitReason = 'LIQUIDITY_RUG_FLOOR';
                exitPrice = 0;
              }
            } else {
              if (quote == null) {
                actualUsdSold = 0;
                solReceived = null;
                tokensSold = null;
                exitReason = 'LIQUIDITY_RUG_FLOOR';
                exitPrice = 0;
              }
            }
          } catch {
            // keep notional actualUsdSold on quote/network error
          }
        }
      }
    }

        if (executionMode === 'live' && dec.token_mint) {
          const account = getAccountById(accountId);
          if (account && account.chain === 'solana') {
            const exitOrder = buildExitOrder(dec, exitReason);
        const sellResult = await executeLiveExitSell(
          account as AccountForExecutor,
          exitOrder
        );
        if (!sellResult.success) {
          console.error(
            JSON.stringify({
              worker: 'ExitWorker',
              event: 'LiveExitSellFailed',
              trade_id: dec.trade_id,
              exit_reason: exitReason,
              skip_reason: sellResult.skipReason,
            })
          );
          if (shouldCloseTradeOnExitSellFailure(sellResult.skipReason)) {
            exitTxSignature = null;
            exitSellSkipReason = sellResult.skipReason;
            // Fall through to close position in DB so we don't retry
          } else {
            continue;
          }
        } else {
          exitTxSignature = sellResult.txSignature ?? null;
          if (sellResult.actualUsdReceived != null && Number.isFinite(sellResult.actualUsdReceived)) {
            actualUsdSold = sellResult.actualUsdReceived;
          }
          if (sellResult.solReceived != null && Number.isFinite(sellResult.solReceived)) solReceived = sellResult.solReceived;
          if (sellResult.solPriceUsd != null && Number.isFinite(sellResult.solPriceUsd)) solPriceUsed = sellResult.solPriceUsd;
          if (sellResult.effectiveExitPriceUsd != null && Number.isFinite(sellResult.effectiveExitPriceUsd)) {
            effectiveExitPriceUsd = sellResult.effectiveExitPriceUsd;
          }
          if (sellResult.slippageBpsUsed != null && Number.isFinite(sellResult.slippageBpsUsed)) exitSlippageBpsUsed = sellResult.slippageBpsUsed;
          if (sellResult.tokensSold != null && Number.isFinite(sellResult.tokensSold)) tokensSold = sellResult.tokensSold;
          if (sellResult.feeLamports != null && Number.isFinite(sellResult.feeLamports)) feeLamports = sellResult.feeLamports;
        }
      }
    }
    if (exitSellSkipReason != null && exitSellSkipReason.includes('ZeroBaseAmount')) {
      actualUsdSold = 0;
      solReceived = null;
      tokensSold = null;
      effectiveExitPriceUsd = null;
      exitReason = 'LIQUIDITY_RUG_FLOOR';
      exitPrice = 0;
    }
    if (solPriceUsed == null) {
      try {
        solPriceUsed = await getSolPriceUsd();
      } catch {
        // leave null if fetch fails
      }
    }
    if (solReceived == null && actualUsdSold != null && solPriceUsed != null && solPriceUsed > 0) {
      solReceived = actualUsdSold / solPriceUsed;
    }
    const realizedPnlUsd = actualUsdSold - actualUsdBought;
    const pnlPct =
      actualUsdBought !== 0 ? (realizedPnlUsd / actualUsdBought) * 100 : 0;
    const actualExitPrice =
      effectiveExitPriceUsd != null && Number.isFinite(effectiveExitPriceUsd)
        ? effectiveExitPriceUsd
        : dec.position_size_usd !== 0 &&
          actualUsdSold != null &&
          Number.isFinite(actualUsdSold)
        ? (actualUsdSold * dec.entry_price) / dec.position_size_usd
        : null;
    db.transaction(() => {
      const recheck = getOpenDecisionByTradeId.get({ tradeId: dec.trade_id }) as OpenDecisionRow | undefined;
      if (!recheck) return;

      releaseBalanceOnExit.run({ realizedPnlUsd, positionSizeUsd: dec.position_size_usd, updatedAt: now, accountId });
      setDecisionExitRecorded.run({ exitRecordedAt: now, tradeId: dec.trade_id });
      insertTrade.run({
        pairAddress: dec.pair_address,
        tokenMint: dec.token_mint ?? null,
        entryPairAddress: dec.pair_address,
        entryDex: dec.entry_dex ?? null,
        policyVersion: dec.policy_version,
        entrySnapshotId: dec.entry_snapshot_id,
        entryScoreId: dec.entry_score_id ?? null,
        exitSnapshotId: exitSnapshotIdFromSnapshot,
        entryTime: dec.executed_at,
        exitTime: now,
        entryPrice: dec.entry_price,
        exitPrice,
        positionSizeUsd: dec.position_size_usd,
        exitReason,
        pnlPct,
        lastVolumeRatio,
        riskPctAtEntry: dec.risk_pct_at_entry ?? null,
        scoreSizeMultiplier: dec.score_size_multiplier ?? null,
        isForcedExit: 0,
        exitMetadata: null,
        exitLiquidityUsd: null,
        snapshotAgeAtExit: null,
        accountId,
        deploymentId: dec.deployment_id ?? null,
        executionMode,
        chain: dec.chain ?? 'paper',
        txSignature: dec.tx_signature ?? null,
        executionStatus: dec.execution_status ?? null,
        actualEntryPrice: dec.actual_entry_price ?? null,
        slippageBpsRealized: dec.slippage_bps_realized ?? null,
        executionLatencyMs: dec.execution_latency_ms ?? null,
        exitTxSignature,
        actualUsdBought,
        actualUsdSold,
        solReceived,
        solPriceUsed,
        solPriceAtEntry: dec.sol_price_at_entry ?? null,
        actualExitPrice,
        entrySlippageBpsUsed: dec.entry_slippage_bps_used ?? null,
        exitSlippageBpsUsed,
        tokensReceived: dec.tokens_received ?? null,
        tokensSold,
        feeLamports,
      });
    })();

    if (dec.token_mint != null && dec.token_mint !== '') {
      const row = getTokenPolicyStats.get({ tokenMint: dec.token_mint, policyVersion: dec.policy_version }) as
        | { last_loss_at: number | null; consecutive_losses: number; updated_at: number }
        | undefined;
      let newConsecutive: number;
      let newLastLossAt: number | null;
      if (pnlPct < 0) {
        const sameDay = row != null && isSameCalendarDay(row.updated_at, now);
        newConsecutive = sameDay ? row.consecutive_losses + 1 : 1;
        newLastLossAt = now;
      } else {
        newConsecutive = 0;
        newLastLossAt = null;
      }
      upsertTokenPolicyStats.run({
        tokenMint: dec.token_mint,
        policyVersion: dec.policy_version,
        lastLossAt: newLastLossAt,
        consecutiveLosses: newConsecutive,
        lastExitReason: exitReason,
        updatedAt: now,
      });
      const lastOutcome = pnlPct >= 0 ? 'WIN' : 'LOSS';
      const upd = updateTokenPolicyExecutionExit.run({ lastExitAt: now, lastTradeOutcome: lastOutcome, updatedAt: now, tokenMint: dec.token_mint, policyVersion: dec.policy_version }) as { changes: number };
      if (upd.changes === 0) {
        insertTokenPolicyExecutionExit.run({ tokenMint: dec.token_mint, policyVersion: dec.policy_version, lastExitAt: now, lastTradeOutcome: lastOutcome, windowStart: now, updatedAt: now });
      }
    } else {
      const row = getPairPolicyStats.get({ pairAddress: dec.pair_address, policyVersion: dec.policy_version }) as
        | { last_loss_at: number | null; consecutive_losses: number; updated_at: number }
        | undefined;
      let newConsecutive: number;
      let newLastLossAt: number | null;
      if (pnlPct < 0) {
        const sameDay = row != null && isSameCalendarDay(row.updated_at, now);
        newConsecutive = sameDay ? row.consecutive_losses + 1 : 1;
        newLastLossAt = now;
      } else {
        newConsecutive = 0;
        newLastLossAt = null;
      }
      upsertPairPolicyStats.run({
        pairAddress: dec.pair_address,
        policyVersion: dec.policy_version,
        lastLossAt: newLastLossAt,
        consecutiveLosses: newConsecutive,
        lastExitReason: exitReason,
        updatedAt: now,
      });
    }

    // Policy-level consecutive loss and soft cooldown (pause, not halt)
    const cooldownThreshold = policy.cooldown_on_consecutive_losses ?? null;
    const cooldownSeconds = policy.cooldown_on_consecutive_losses_seconds ?? 1800;
    if (cooldownThreshold != null && cooldownThreshold > 0) {
      const state = getPolicyExecutionState.get({ policyVersion: dec.policy_version }) as
        | { consecutive_loss_count: number; policy_cooldown_until: number | null }
        | undefined;
      const currentCount = state?.consecutive_loss_count ?? 0;
      if (pnlPct < 0) {
        const newCount = currentCount + 1;
        if (newCount >= cooldownThreshold) {
          const cooldownUntil = now + cooldownSeconds;
          upsertPolicyExecutionStateCooldown.run({ policyVersion: dec.policy_version, policyCooldownUntil: cooldownUntil, consecutiveLossCount: 0 });
          console.log(
            JSON.stringify({
              event: 'POLICY_COOLDOWN_TRIGGERED',
              policy_version: dec.policy_version,
              loss_count: newCount,
              cooldown_seconds: cooldownSeconds,
              timestamp: now,
            })
          );
        } else {
          upsertPolicyExecutionStateCooldown.run({ policyVersion: dec.policy_version, policyCooldownUntil: state?.policy_cooldown_until ?? null, consecutiveLossCount: newCount });
        }
      } else {
        upsertPolicyExecutionStateCooldown.run({ policyVersion: dec.policy_version, policyCooldownUntil: state?.policy_cooldown_until ?? null, consecutiveLossCount: 0 });
      }
    }

    console.log(
      JSON.stringify({
        worker: 'ExitWorker',
        event: 'TradeExit',
        trade_id: dec.trade_id,
        token_mint: dec.token_mint ?? undefined,
        exit_reason: exitReason,
        exit_price: exitPrice,
        hold_seconds: holdSeconds,
      })
    );
  }
}

export interface ForceExitResult {
  success: boolean;
  trade_id: number;
  exit_reason: string;
  tx_signature?: string | null;
  actual_usd_sold?: number | null;
  sol_received?: number | null;
  error?: string;
}

/**
 * Immediately exit an open trade: executes the sell on-chain (for live) and records
 * the trade in DB. Called by the MCP force_exit_trade tool.
 */
export async function forceExitDecision(tradeId: number): Promise<ForceExitResult> {
  const dec = getOpenDecisionByTradeId.get({ tradeId }) as OpenDecisionRow | undefined;
  if (!dec) throw new Error(`Trade ${tradeId} not found or already closed`);

  const exitReason = 'MANUAL_EXIT';
  const now = Math.floor(Date.now() / 1000);
  const accountId = dec.account_id ?? DEFAULT_PAPER_ACCOUNT_ID;
  const executionMode = dec.execution_mode ?? 'paper';
  const actualUsdBought = dec.actual_usd_bought ?? dec.position_size_usd;

  let exitTxSignature: string | null = null;
  let actualUsdSold = dec.position_size_usd;
  let solReceived: number | null = null;
  let solPriceUsed: number | null = null;
  let effectiveExitPriceUsd: number | null = null;
  let exitSlippageBpsUsed: number | null = null;
  let tokensSold: number | null = null;
  let feeLamports: number | null = null;
  let exitPrice = dec.entry_price;
  let effectiveExitReason: string = exitReason;

  if (executionMode === 'paper' && dec.token_mint && dec.pair_address && dec.entry_dex && dec.entry_price > 0) {
    const tokenAmountToSell = dec.tokens_received ?? dec.position_size_usd / dec.entry_price;
    if (Number.isFinite(tokenAmountToSell) && tokenAmountToSell > 0) {
      const rpcUrl = getSolanaRpcUrl();
      if (rpcUrl) {
        try {
          const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
          const quote = await getPaperExitQuote({
            connection,
            pairAddress: dec.pair_address,
            tokenMint: dec.token_mint,
            tokenAmountToSell,
            entryDex: dec.entry_dex,
            getSolPriceUsd,
          });
          if (quote != null && Number.isFinite(quote.actualUsdSold) && quote.actualUsdSold >= 0) {
            actualUsdSold = quote.actualUsdSold;
            solReceived = quote.solReceived;
            solPriceUsed = quote.solPriceUsd;
            tokensSold = tokenAmountToSell;
            const policyRow = getPolicyByVersion.get({ policyVersion: dec.policy_version }) as PolicyRow | undefined;
            const minLiquidityUsd = policyRow?.rug_liquidity_floor_usd ?? 1;
            if (
              Number.isFinite(quote.liquidityUsd) &&
              (quote.liquidityUsd === 0 || quote.liquidityUsd < minLiquidityUsd)
            ) {
              actualUsdSold = 0;
              solReceived = null;
              tokensSold = null;
              effectiveExitReason = 'LIQUIDITY_RUG_FLOOR';
              exitPrice = 0;
            }
          } else {
            if (quote == null) {
              actualUsdSold = 0;
              solReceived = null;
              tokensSold = null;
              effectiveExitReason = 'LIQUIDITY_RUG_FLOOR';
              exitPrice = 0;
            }
          }
        } catch {
          // keep position_size_usd as actualUsdSold on quote/network error
        }
      }
    }
  }

  if (executionMode === 'live' && dec.token_mint) {
    const account = getAccountById(accountId);
    if (!account || account.chain !== 'solana') {
      throw new Error(`Account ${accountId} not found or not a Solana account`);
    }
    const exitOrder = buildExitOrder(dec, exitReason);
    const sellResult = await executeLiveExitSell(
      account as unknown as AccountForExecutor,
      exitOrder
    );
    if (!sellResult.success) {
      throw new Error(`Sell failed: ${sellResult.skipReason ?? 'unknown'}`);
    }
    exitTxSignature = sellResult.txSignature ?? null;
    if (sellResult.actualUsdReceived != null && Number.isFinite(sellResult.actualUsdReceived)) {
      actualUsdSold = sellResult.actualUsdReceived;
    }
    if (sellResult.solReceived != null && Number.isFinite(sellResult.solReceived)) solReceived = sellResult.solReceived;
    if (sellResult.solPriceUsd != null && Number.isFinite(sellResult.solPriceUsd)) solPriceUsed = sellResult.solPriceUsd;
    if (sellResult.effectiveExitPriceUsd != null && Number.isFinite(sellResult.effectiveExitPriceUsd)) {
      effectiveExitPriceUsd = sellResult.effectiveExitPriceUsd;
      exitPrice = effectiveExitPriceUsd;
    }
    if (sellResult.slippageBpsUsed != null && Number.isFinite(sellResult.slippageBpsUsed)) exitSlippageBpsUsed = sellResult.slippageBpsUsed;
    if (sellResult.tokensSold != null && Number.isFinite(sellResult.tokensSold)) tokensSold = sellResult.tokensSold;
    if (sellResult.feeLamports != null && Number.isFinite(sellResult.feeLamports)) feeLamports = sellResult.feeLamports;
  }

  if (solPriceUsed == null) {
    try { solPriceUsed = await getSolPriceUsd(); } catch { /* leave null */ }
  }
  if (solReceived == null && actualUsdSold != null && solPriceUsed != null && solPriceUsed > 0) {
    solReceived = actualUsdSold / solPriceUsed;
  }

  const realizedPnlUsd = actualUsdSold - actualUsdBought;
  const pnlPct = actualUsdBought !== 0 ? (realizedPnlUsd / actualUsdBought) * 100 : 0;
  const actualExitPrice =
    effectiveExitPriceUsd != null && Number.isFinite(effectiveExitPriceUsd)
      ? effectiveExitPriceUsd
      : dec.position_size_usd !== 0 && actualUsdSold != null && Number.isFinite(actualUsdSold)
        ? (actualUsdSold * dec.entry_price) / dec.position_size_usd
        : null;

  db.transaction(() => {
    const recheck = getOpenDecisionByTradeId.get({ tradeId }) as OpenDecisionRow | undefined;
    if (!recheck) return;
    releaseBalanceOnExit.run({ realizedPnlUsd, positionSizeUsd: dec.position_size_usd, updatedAt: now, accountId });
    setDecisionExitRecorded.run({ exitRecordedAt: now, tradeId });
    insertTrade.run({
      pairAddress: dec.pair_address,
      tokenMint: dec.token_mint ?? null,
      entryPairAddress: dec.pair_address,
      entryDex: dec.entry_dex ?? null,
      policyVersion: dec.policy_version,
      entrySnapshotId: dec.entry_snapshot_id,
      entryScoreId: dec.entry_score_id ?? null,
      exitSnapshotId: null,
      entryTime: dec.executed_at,
      exitTime: now,
      entryPrice: dec.entry_price,
      exitPrice,
      positionSizeUsd: dec.position_size_usd,
      exitReason: effectiveExitReason,
      pnlPct,
      lastVolumeRatio: null,
      riskPctAtEntry: dec.risk_pct_at_entry ?? null,
      scoreSizeMultiplier: dec.score_size_multiplier ?? null,
      isForcedExit: 1,
      exitMetadata: null,
      exitLiquidityUsd: null,
      snapshotAgeAtExit: null,
      accountId,
      deploymentId: dec.deployment_id ?? null,
      executionMode,
      chain: dec.chain ?? 'paper',
      txSignature: dec.tx_signature ?? null,
      executionStatus: dec.execution_status ?? null,
      actualEntryPrice: dec.actual_entry_price ?? null,
      slippageBpsRealized: dec.slippage_bps_realized ?? null,
      executionLatencyMs: dec.execution_latency_ms ?? null,
      exitTxSignature,
      actualUsdBought,
      actualUsdSold,
      solReceived,
      solPriceUsed,
      solPriceAtEntry: dec.sol_price_at_entry ?? null,
      actualExitPrice,
      entrySlippageBpsUsed: dec.entry_slippage_bps_used ?? null,
      exitSlippageBpsUsed,
      tokensReceived: dec.tokens_received ?? null,
      tokensSold,
      feeLamports,
    });
  })();

  return {
    success: true,
    trade_id: tradeId,
    exit_reason: effectiveExitReason,
    tx_signature: exitTxSignature,
    actual_usd_sold: actualUsdSold,
    sol_received: solReceived,
  };
}

function isDatabaseLockedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  const code = typeof err === 'object' && err != null && 'code' in err ? String((err as { code?: string }).code) : '';
  return msg.includes('deadlock detected') || msg.includes('could not serialize access') || code === '40P01';
}

/**
 * Run the exit worker continuously: one cycle, then 2 second delay, then repeat.
 * On database locked errors the loop continues (no restart needed).
 */
export async function startExitWorker(): Promise<never> {
  console.log(`[exit-worker] Starting (paper + live Solana exits), running continuously with ${POLL_INTERVAL_MS / 1000}s delay between cycles`);
  while (true) {
    try {
      await runCycle(randomUUID());
    } catch (err: unknown) {
      if (isDatabaseLockedError(err)) {
        console.error('[exit-worker] DB contention (serialization/deadlock), continuing', err);
      } else {
        console.error('[exit-worker] runCycle error', err);
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

const isMain =
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1]?.endsWith('exit-worker.js');

if (isMain) {
  void startExitWorker();
}
