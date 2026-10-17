/**
 * Shared snapshot persistence: insert into pair_snapshots, rolling baselines,
 * pair updates, and tier logic. Used by both the DexScreener-based snapshots
 * worker and the chain-based snapshots worker.
 */
import { db } from './db.js';
import { computeRollingLiquidityMetrics } from './rolling-liquidity-metrics.js';
import {
  computeRollingVolumeBaselines,
  logRollingBaselineEvent,
  logVolumeOutlierIfAny,
} from './rolling-volume-baselines.js';

export const SNAPSHOT_SOURCE_DEXSCREENER = 'dexscreener';
export const SNAPSHOT_SOURCE_CHAIN = 'chain';

/** Params for inserting a single snapshot row (matches pair_snapshots columns). */
export interface InsertSnapshotParams {
  pairAddress: string;
  tokenMint: string;
  timestamp: number;
  secondsSinceCreation: number | null;
  priceUsd: number | null;
  priceChange1m: number | null;
  priceChange5m: number | null;
  marketCap: number | null;
  fdv: number | null;
  liquidityUsd: number | null;
  liquidityChange1m: number | null;
  lpLocked: number | null;
  lpLockDuration: number | null;
  volume1m: number | null;
  volume5m: number | null;
  volume15m: number | null;
  buyVolume1m: number | null;
  buyVolume5m: number | null;
  buyVolume15m: number | null;
  sellVolume1m: number | null;
  sellVolume5m: number | null;
  sellVolume15m: number | null;
  totalVolume: number | null;
  buys1m: number | null;
  sells1m: number | null;
  buySellRatio1m: number | null;
  totalBuys: number | null;
  totalSells: number | null;
  totalTransactions: number | null;
  transactions1m: number | null;
  buySellRatio: number | null;
  buyPressure1m: number | null;
  sellPressure1m: number | null;
  volumeAcceleration1m: number | null;
  velocityScore1m: number | null;
  hasMintAuthority: number | null;
  hasFreezeAuthority: number | null;
  canRemoveLiquidity: number | null;
  topHolderPct: number | null;
  top5HolderPct: number | null;
  holderCount: number | null;
  walletConcentrationScore: number | null;
  snapshotReason: string;
  method: string;
  source: string;
}

const insertSnapshotStmt = db.prepare(`
  INSERT INTO pair_snapshots (
    pair_address,
    token_mint,
    timestamp,
    seconds_since_creation,
    price_usd,
    price_change_1m,
    price_change_5m,
    market_cap,
    fdv,
    liquidity_usd,
    liquidity_change_1m,
    lp_locked,
    lp_lock_duration,
    volume_1m,
    volume_5m,
    volume_15m,
    buy_volume_1m,
    buy_volume_5m,
    buy_volume_15m,
    sell_volume_1m,
    sell_volume_5m,
    sell_volume_15m,
    total_volume,
    buys_1m,
    sells_1m,
    buy_sell_ratio_1m,
    total_buys,
    total_sells,
    total_transactions,
    transactions_1m,
    buy_sell_ratio,
    buy_pressure_1m,
    sell_pressure_1m,
    volume_acceleration_1m,
    velocity_score_1m,
    has_mint_authority,
    has_freeze_authority,
    can_remove_liquidity,
    top_holder_pct,
    top_5_holder_pct,
    holder_count,
    wallet_concentration_score,
    snapshot_reason,
    method,
    source
  ) VALUES ($pairAddress, $tokenMint, $timestamp, $secondsSinceCreation, $priceUsd, $priceChange1m, $priceChange5m, $marketCap, $fdv, $liquidityUsd, $liquidityChange1m, $lpLocked, $lpLockDuration, $volume1m, $volume5m, $volume15m, $buyVolume1m, $buyVolume5m, $buyVolume15m, $sellVolume1m, $sellVolume5m, $sellVolume15m, $totalVolume, $buys1m, $sells1m, $buySellRatio1m, $totalBuys, $totalSells, $totalTransactions, $transactions1m, $buySellRatio, $buyPressure1m, $sellPressure1m, $volumeAcceleration1m, $velocityScore1m, $hasMintAuthority, $hasFreezeAuthority, $canRemoveLiquidity, $topHolderPct, $top5HolderPct, $holderCount, $walletConcentrationScore, $snapshotReason, $method, $source)
`);

/** Insert a snapshot row and return snapshot_id. */
export function insertSnapshotRow(params: InsertSnapshotParams): number {
  const result = insertSnapshotStmt.run(params);
  return (result as { lastInsertRowid: number }).lastInsertRowid;
}

export const hasIngestSnapshot = db.prepare(`
  SELECT 1 FROM pair_snapshots WHERE pair_address = $pairAddress AND snapshot_reason = 'PAIR_INGEST' LIMIT 1
`);

export const updatePairLastSnapshotAt = db.prepare(`
  UPDATE pairs SET last_snapshot_at = $lastSnapshotAt WHERE pair_address = $pairAddress
`);

export const updatePairBaseSymbolIfUnknown = db.prepare(`
  UPDATE pairs SET base_symbol = $baseSymbol
  WHERE pair_address = $pairAddress
    AND (
      base_symbol IS NULL OR TRIM(base_symbol) = ''
      OR LOWER(TRIM(base_symbol)) IN ('unknown', 'dex', '?')
    )
`);

export const updatePairQuoteSymbolIfUnknown = db.prepare(`
  UPDATE pairs SET quote_symbol = $quoteSymbol
  WHERE pair_address = $pairAddress
    AND (quote_symbol IS NULL OR TRIM(quote_symbol) = '' OR LOWER(TRIM(quote_symbol)) = 'unknown')
`);

/** Set quote_symbol to 'SOL' for pairs where quote is Wrapped SOL and quote_symbol is unknown. Run each cycle so snapshot list shows SOL. */
export const bulkUpdateQuoteSymbolSolWhereUnknown = db.prepare(`
  UPDATE pairs SET quote_symbol = 'SOL'
  WHERE (quote_symbol IS NULL OR TRIM(quote_symbol) = '' OR LOWER(TRIM(quote_symbol)) = 'unknown')
    AND LOWER(TRIM(quote_token_address)) = $quoteTokenAddressLower
`);

const updateSnapshotRollingStmt = db.prepare(`
  UPDATE pair_snapshots
  SET rolling_avg_volume_5m = $rollingAvgVolume5m, rolling_avg_volume_30m = $rollingAvgVolume30m, rolling_avg_volume_1h = $rollingAvgVolume1h, rolling_volume_sample_count = $rollingVolumeSampleCount
  WHERE snapshot_id = $snapshotId
`);

const updateSnapshotLiquidityTrendStmt = db.prepare(`
  UPDATE pair_snapshots
  SET rolling_avg_liquidity_30m = $rollingAvgLiquidity30m, rolling_avg_liquidity_1h = $rollingAvgLiquidity1h, liquidity_change_pct_30m = $liquidityChangePct30m, liquidity_change_pct_1h = $liquidityChangePct1h, liquidity_sample_count = $liquiditySampleCount
  WHERE snapshot_id = $snapshotId
`);

const getPreviousRollingSampleCount = db.prepare(`
  SELECT rolling_volume_sample_count FROM pair_snapshots
  WHERE pair_address = $pairAddress AND timestamp < $timestamp
  ORDER BY timestamp DESC LIMIT 1
`);

/** After inserting a snapshot, compute rolling volume baselines and update the row. */
export function applyRollingBaselinesToSnapshot(
  pairAddress: string,
  now: number,
  snapshotId: number,
  volume5m: number | null
): void {
  const prevRow = getPreviousRollingSampleCount.get({ pairAddress, timestamp: now }) as
    | { rolling_volume_sample_count: number | null }
    | undefined;
  const previousSampleCount = prevRow?.rolling_volume_sample_count ?? null;
  const result = computeRollingVolumeBaselines(pairAddress, now);
  updateSnapshotRollingStmt.run({
    rollingAvgVolume5m: result.avg_5m,
    rollingAvgVolume30m: result.avg_30m,
    rollingAvgVolume1h: result.avg_1h,
    rollingVolumeSampleCount: result.sample_count,
    snapshotId,
  });
  if (result.sample_count === 0) return;
  logRollingBaselineEvent(pairAddress, result, previousSampleCount);
  if (volume5m != null && Number.isFinite(volume5m)) {
    logVolumeOutlierIfAny(pairAddress, volume5m, result.avg_1h);
  }
}

/** After inserting a snapshot, compute rolling liquidity metrics and update the row. */
export function applyRollingLiquidityToSnapshot(
  pairAddress: string,
  now: number,
  snapshotId: number,
  liquidityUsd: number | null
): void {
  const result = computeRollingLiquidityMetrics(pairAddress, now, liquidityUsd);
  updateSnapshotLiquidityTrendStmt.run({
    rollingAvgLiquidity30m: result.avg_liquidity_30m,
    rollingAvgLiquidity1h: result.avg_liquidity_1h,
    liquidityChangePct30m: result.liquidity_change_pct_30m,
    liquidityChangePct1h: result.liquidity_change_pct_1h,
    liquiditySampleCount: result.sample_count,
    snapshotId,
  });
}

// --- Tier logic (shared so chain-snapshots worker can update tier too) ---
export const ULTRA_EARLY_MAX_AGE_SEC = 1200; // 20 min
export const RUNNER_LIQUIDITY_THRESHOLD = 10_000;
export const RUNNER_VOLUME_THRESHOLD = 5_000;
export const MAX_TRACKING_AGE_SEC = 24 * 3600;
export const MIN_VOLUME_THRESHOLD = 100;
export const MIN_LIQUIDITY_THRESHOLD = 1_000;

/** Snapshot interval for ultra_early tier (seconds). */
export const INTERVAL_ULTRA_EARLY_SEC = 45;
/** Snapshot interval for active tier (seconds). */
export const INTERVAL_ACTIVE_SEC = 90;

export type TrackingTier = 'ultra_early' | 'active' | 'dormant';

export function computeNextTier(
  currentTier: TrackingTier,
  tokenAgeSeconds: number | null,
  liquidityUsd: number | null,
  volume5m: number | null,
  hasOpenTrade: boolean,
  lpLocked?: number | null
): { tier: TrackingTier; lastActiveAt: number | null } {
  const age = tokenAgeSeconds ?? 0;
  // No liquidity → dormant (e.g. chain snapshot sees drained pool)
  if ((liquidityUsd ?? 0) <= 0) {
    return { tier: 'dormant', lastActiveAt: null };
  }
  // Liquidity not locked and under $2 → dormant (e.g. drained or abandoned)
  if (lpLocked !== undefined && lpLocked !== 1 && (liquidityUsd ?? 0) < 2) {
    return { tier: 'dormant', lastActiveAt: null };
  }
  if (
    !hasOpenTrade &&
    age > MAX_TRACKING_AGE_SEC &&
    (volume5m ?? 0) < MIN_VOLUME_THRESHOLD &&
    (liquidityUsd ?? 0) < MIN_LIQUIDITY_THRESHOLD
  ) {
    return { tier: 'dormant', lastActiveAt: null };
  }
  if (
    age > ULTRA_EARLY_MAX_AGE_SEC &&
    (liquidityUsd ?? 0) >= RUNNER_LIQUIDITY_THRESHOLD &&
    (volume5m ?? 0) >= RUNNER_VOLUME_THRESHOLD
  ) {
    return { tier: 'active', lastActiveAt: Math.floor(Date.now() / 1000) };
  }
  if (currentTier === 'ultra_early' && age <= ULTRA_EARLY_MAX_AGE_SEC) {
    return { tier: 'ultra_early', lastActiveAt: null };
  }
  if (currentTier === 'ultra_early' && age > ULTRA_EARLY_MAX_AGE_SEC) {
    return { tier: 'dormant', lastActiveAt: null };
  }
  return { tier: currentTier, lastActiveAt: null };
}

export const updatePairAfterSnapshot = db.prepare(`
  UPDATE pairs SET tracking_tier = $trackingTier, last_active_at = $lastActiveAt, last_snapshot_at = $lastSnapshotAt
  WHERE pair_address = $pairAddress
`);

export function updatePairTierAfterSnapshot(
  pairAddress: string,
  currentTier: string,
  now: number,
  tokenAgeSeconds: number | null,
  liquidityUsd: number | null,
  volume5m: number | null,
  hasOpenTrade: boolean,
  logPrefix: string = '[snapshots-worker]',
  lpLocked?: number | null
): { newTier: TrackingTier } {
  const { tier: newTier, lastActiveAt } = computeNextTier(
    currentTier as TrackingTier,
    tokenAgeSeconds,
    liquidityUsd,
    volume5m,
    hasOpenTrade,
    lpLocked
  );
  if (currentTier === 'ultra_early' && newTier === 'active') {
    console.log(`${logPrefix} Tier transition ultra_early → active ${pairAddress}`);
  }
  if (currentTier === 'active' && newTier === 'dormant') {
    console.log(`${logPrefix} Tier transition active → dormant ${pairAddress}`);
  }
  updatePairAfterSnapshot.run({
    trackingTier: newTier,
    lastActiveAt,
    lastSnapshotAt: now,
    pairAddress,
  });
  return { newTier };
}
