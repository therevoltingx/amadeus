/**
 * Chain snapshots worker: builds pair_snapshots from on-chain data only (no DexScreener).
 * PumpSwap only for now; Raydium can be added later.
 *
 * Runs every N seconds (configurable via SNAPSHOT_POLL_INTERVAL_SEC; only 15, 30, or 60 allowed; default 60). All time-window metrics (1m, 5m, 15m) are rolling windows based on
 * pair_swap_events timestamps (e.g. transactions_1m = count where created_at >= now - 60s);
 * snapshot frequency does not change their meaning.
 *
 * Eligibility (tier, age, open trade, LP lock vs policies) is shared with vault swap worker and
 * get_eligible_for_snapshot_count — see `snapshot-pair-eligibility-sql.ts`.
 *
 * Requires HELIUS_RPC_URL. Respects ENABLED_DEXES (if set, must include pumpswap).
 * Uses SOL price cache per cycle, batched mint fetches, and 429 retry with backoff to reduce RPC load.
 */
import 'dotenv/config';
import { Redis } from 'ioredis';
import { Connection } from '@solana/web3.js';
import { db } from '../db.js';
import { getSolanaRpcUrl } from '../config.js';
import { getEnabledDexes } from '../config.js';
import { getSolPriceUsd } from '../sol-price.js';
import { getPumpSwapPoolSnapshot } from '../pools/pumpswap-pool-state.js';
// Token holders disabled to reduce RPC; re-enable later.
// import { getTokenHolderInfoFromChain } from '../token-holders.js';
import type { HolderInfo } from '../types/holder.js';
import {
  insertSnapshotRow,
  updatePairLastSnapshotAt,
  applyRollingBaselinesToSnapshot,
  applyRollingLiquidityToSnapshot,
  updatePairTierAfterSnapshot,
  SNAPSHOT_SOURCE_CHAIN,
  type InsertSnapshotParams,
} from '../snapshot-persistence.js';
import { scorePairNow } from './scoring-worker.js';
import { swapEventCreatedAtMsExpr } from './swap-event-time-sql.js';
import { SNAPSHOT_PAIR_ELIGIBILITY_CONDS, MAX_PAIR_AGE_UNBOUNDED_SEC } from './snapshot-pair-eligibility-sql.js';

const CHAIN = 'solana';
const DEX_PUMPSWAP = 'pumpswap';
/** Allowed snapshot poll intervals (seconds). Only these values are accepted from SNAPSHOT_POLL_INTERVAL_SEC. */
const ALLOWED_SNAPSHOT_INTERVAL_SEC = [15, 30, 60] as const;
/** Snapshot cycle interval in ms. From env SNAPSHOT_POLL_INTERVAL_SEC; only 15, 30, or 60 allowed; default 60. */
const POLL_INTERVAL_MS = (() => {
  const raw = process.env.SNAPSHOT_POLL_INTERVAL_SEC?.trim();
  const sec = raw != null && raw !== '' ? parseInt(raw, 10) : 60;
  const allowed = ALLOWED_SNAPSHOT_INTERVAL_SEC.includes(sec as (typeof ALLOWED_SNAPSHOT_INTERVAL_SEC)[number])
    ? sec
    : 60;
  if (raw != null && raw !== '' && allowed !== sec) {
    console.warn(
      `[chain-snapshots-worker] SNAPSHOT_POLL_INTERVAL_SEC=${raw} is not allowed (use 15, 30, or 60). Using ${allowed}s.`
    );
  }
  return allowed * 1000;
})();
const REASON_SCHEDULED = 'SCHEDULED';
const LOG_PREFIX = '[chain-snapshots-worker]';
const REDIS_CHANNEL_PAIRS_DORMANT = 'pairs:dormant';

type SnapshotPairRow = {
  pair_address: string;
  base_token_address: string;
  tracking_tier: string;
  pair_created_at: number | null;
  last_snapshot_at: number | null;
  base_decimals: number | null;
  base_has_mint_authority: number | null;
  base_has_freeze_authority: number | null;
  base_supply_raw: string | null;
  has_open_trade: number | null;
};

const ONE_MINUTE_SEC = 60;
const FIVE_MINUTES_SEC = 300;
const LAMPORTS_PER_SOL = 1e9;

/** Coerce PG int8/bigint (often string) or number to a finite integer for snapshot math / inserts. */
function coerceDbInt(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  return 0;
}
const ONE_MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 300_000;
const FIFTEEN_MINUTES_MS = 900_000;

/** Rolling-window time column — see `swap-event-time-sql.ts`. */
const SWAP_EVENT_TIME_MS_EXPR = swapEventCreatedAtMsExpr();

/** Batch size for parallel snapshot taking (pairs per batch). From env SNAPSHOT_BATCH_SIZE; default 8. */
const SNAPSHOT_BATCH_SIZE = Math.max(1, Math.min(20, Number(process.env.SNAPSHOT_BATCH_SIZE) || 8));
/** Delay between batches (ms). Helps avoid RPC thundering herd. From env SNAPSHOT_BATCH_DELAY_MS; default 100. */
const DELAY_BETWEEN_BATCHES_MS = Math.max(0, Number(process.env.SNAPSHOT_BATCH_DELAY_MS) || 100);
/** 429 retry: initial backoff, max backoff, max retries. */
const RPC_429_FIRST_MS = 500;
const RPC_429_MAX_MS = 15_000;
const RPC_429_MAX_RETRIES = 4;

/** Redis client for publishing dormant-pair events. Only created when REDIS_URL is set. */
let redis: Redis | null = null;
function getRedis(): Redis | null {
  if (redis != null) return redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    redis = new Redis(url);
    return redis;
  } catch {
    return null;
  }
}

/** Run an async operation and retry on 429 with exponential backoff + jitter. */
async function executeWith429Retry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  let sleepMs = RPC_429_FIRST_MS;
  for (let attempt = 0; attempt <= RPC_429_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < RPC_429_MAX_RETRIES && (msg.includes('429') || msg.includes('Too Many Requests'))) {
        const jitter = Math.floor(Math.random() * 200);
        const wait = Math.min(sleepMs + jitter, RPC_429_MAX_MS);
        console.warn(`${LOG_PREFIX} 429/rate limit, retrying after ${wait}ms (attempt ${attempt + 1}/${RPC_429_MAX_RETRIES})`);
        await new Promise((r) => setTimeout(r, wait));
        sleepMs = Math.min(sleepMs * 2, RPC_429_MAX_MS);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/** Pairs eligible for chain snapshots — same rules as `SNAPSHOT_PAIR_ELIGIBILITY_CONDS`. */
const selectPumpswapEligiblePairs = db.prepare(`
  SELECT
    p.pair_address,
    p.chain,
    p.base_token_address,
    p.dex,
    COALESCE(p.tracking_tier, 'ultra_early') AS tracking_tier,
    p.pair_created_at,
    p.last_snapshot_at,
    p.base_decimals,
    p.base_has_mint_authority,
    p.base_has_freeze_authority,
    p.base_supply_raw,
    (SELECT 1 FROM trade_decisions td WHERE td.pair_address = p.pair_address AND td.exit_recorded_at IS NULL LIMIT 1) AS has_open_trade
  FROM pairs p
  WHERE p.dex = $dex
  ${SNAPSHOT_PAIR_ELIGIBILITY_CONDS}
`);

/** Same eligibility as selectPumpswapEligiblePairs, but only pairs with base_vault and quote_vault (vault swap worker). */
const selectEligiblePumpswapPairsWithVaults = db.prepare(`
  SELECT p.pair_address, p.base_vault, p.quote_vault
  FROM pairs p
  WHERE p.dex = $dex
    AND p.base_vault IS NOT NULL AND TRIM(p.base_vault) != ''
    AND p.quote_vault IS NOT NULL AND TRIM(p.quote_vault) != ''
  ${SNAPSHOT_PAIR_ELIGIBILITY_CONDS}
`);

/** Single-pair eligibility (pairs:new / vault worker). Same rules as `SNAPSHOT_PAIR_ELIGIBILITY_CONDS`. */
const selectEligiblePairForSnapshotSubscription = db.prepare(`
  SELECT 1 AS one
  FROM pairs p
  WHERE p.pair_address = $pairAddress
    AND p.dex = $dex
    AND p.base_vault IS NOT NULL AND TRIM(p.base_vault) != ''
    AND p.quote_vault IS NOT NULL AND TRIM(p.quote_vault) != ''
  ${SNAPSHOT_PAIR_ELIGIBILITY_CONDS}
  LIMIT 1
`);

function eligibleSnapshotParams(): { dex: string; nowSeconds: number; maxAgeUnbound: number } {
  return {
    dex: DEX_PUMPSWAP,
    nowSeconds: Math.floor(Date.now() / 1000),
    maxAgeUnbound: MAX_PAIR_AGE_UNBOUNDED_SEC,
  };
}

/** Count of pairs eligible for chain snapshots (for UI / get_eligible_for_snapshot_count). */
export function getEligibleForSnapshotCount(): number {
  return (selectPumpswapEligiblePairs.all(eligibleSnapshotParams()) as unknown[]).length;
}

/** Pairs eligible for snapshots that have vaults (for pumpswap-vault-swap worker startup). Same set as "eligible for snapshots" on pairs page. */
export function getEligiblePumpswapPairsWithVaults(): { pair_address: string; base_vault: string; quote_vault: string }[] {
  const rows = selectEligiblePumpswapPairsWithVaults.all(eligibleSnapshotParams()) as { pair_address: string; base_vault: string; quote_vault: string }[];
  return rows.filter(
    (r) =>
      typeof r.pair_address === 'string' &&
      typeof r.base_vault === 'string' &&
      typeof r.quote_vault === 'string' &&
      r.base_vault.trim() !== '' &&
      r.quote_vault.trim() !== ''
  );
}

/** Single-pair check: true if this pair is in the eligible set (for vault-swap worker when handling pairs:new). */
export function isPairEligibleForSnapshotSubscription(pairAddress: string): boolean {
  const row = selectEligiblePairForSnapshotSubscription.get({
    pairAddress: String(pairAddress).trim(),
    ...eligibleSnapshotParams(),
  }) as { one: number } | undefined;
  return row?.one === 1;
}

/** Count buys and sells in the last 1 minute for a pair (created_at ms, or legacy seconds — see SWAP_EVENT_TIME_MS_EXPR). */
const getBuySellCounts1m = db.prepare(`
  SELECT direction, COUNT(*) AS cnt
  FROM pair_swap_events
  WHERE pair_address = $pairAddress AND ${SWAP_EVENT_TIME_MS_EXPR} >= $sinceMs
  GROUP BY direction
`);

/** Total buy and sell event counts for a pair (aggregated from pair_swap_events; used for snapshot total_buys/total_sells). */
const getTotalBuySellCountsForPair = db.prepare(`
  SELECT
    COALESCE(SUM(CASE WHEN direction = 'buy' THEN 1 ELSE 0 END), 0) AS total_buys,
    COALESCE(SUM(CASE WHEN direction = 'sell' THEN 1 ELSE 0 END), 0) AS total_sells
  FROM pair_swap_events
  WHERE pair_address = $pairAddress
`);

/** Total SOL volume (lamports) for a pair from pair_swap_events (sum of abs(quote_delta)); quote is SOL. */
const getTotalVolumeLamportsForPair = db.prepare(`
  SELECT COALESCE(SUM(ABS(CAST(quote_delta AS BIGINT))), 0) AS total_lamports
  FROM pair_swap_events
  WHERE pair_address = $pairAddress
`);

/** SOL volume (lamports) for a pair in the last N ms (created_at normalized — see SWAP_EVENT_TIME_MS_EXPR). */
const getVolumeLamportsSinceMs = db.prepare(`
  SELECT COALESCE(SUM(ABS(CAST(quote_delta AS BIGINT))), 0) AS lamports
  FROM pair_swap_events
  WHERE pair_address = $pairAddress AND ${SWAP_EVENT_TIME_MS_EXPR} >= $sinceMs
`);

/** Buy and sell SOL volume (lamports) for a pair in the last N ms (created_at normalized — see SWAP_EVENT_TIME_MS_EXPR). */
const getBuySellVolumeLamports1m = db.prepare(`
  SELECT
    direction,
    COALESCE(SUM(ABS(CAST(quote_delta AS BIGINT))), 0) AS lamports
  FROM pair_swap_events
  WHERE pair_address = $pairAddress AND ${SWAP_EVENT_TIME_MS_EXPR} >= $sinceMs
  GROUP BY direction
`);

/** Snapshot for this pair with timestamp at least N seconds ago (most recent such). Used for price_change_1m / price_change_5m. */
const selectPriceSnapshotAtLeastNAgo = db.prepare(`
  SELECT price_usd FROM pair_snapshots
  WHERE pair_address = $pairAddress AND timestamp <= $maxTimestamp
  ORDER BY timestamp DESC LIMIT 1
`);

/** Snapshot liquidity for this pair with timestamp at least 1 minute ago (for liquidity_change_1m). */
const selectLiquiditySnapshotAtLeast1mAgo = db.prepare(`
  SELECT liquidity_usd FROM pair_snapshots
  WHERE pair_address = $pairAddress AND timestamp <= $maxTimestamp
  ORDER BY timestamp DESC LIMIT 1
`);

/** Most recent snapshot for this pair with timestamp at least 1 minute ago (for volume_acceleration_1m). */
const selectVolume1mSnapshotAtLeast1mAgo = db.prepare(`
  SELECT timestamp, volume_1m FROM pair_snapshots
  WHERE pair_address = $pairAddress AND timestamp <= $maxTimestamp
  ORDER BY timestamp DESC LIMIT 1
`);

/** Most recent previous snapshot for this pair (timestamp < $timestamp); used for velocity_score_1m. Index: (pair_address, timestamp). */
const selectPrevSnapshotTransactions1m = db.prepare(`
  SELECT transactions_1m FROM pair_snapshots
  WHERE pair_address = $pairAddress AND timestamp < $timestamp
  ORDER BY timestamp DESC LIMIT 1
`);

function computePriceChange(
  currentPriceUsd: number,
  pairAddress: string,
  now: number,
  minAgeSeconds: number
): number | null {
  const maxTimestamp = now - minAgeSeconds;
  const row = selectPriceSnapshotAtLeastNAgo.get({
    pairAddress,
    maxTimestamp,
  }) as { price_usd: number } | undefined;
  const oldPrice = row?.price_usd;
  if (oldPrice == null || !Number.isFinite(oldPrice) || oldPrice <= 0) return null;
  if (!Number.isFinite(currentPriceUsd)) return null;
  const pct = ((currentPriceUsd - oldPrice) / oldPrice) * 100;
  return Number.isFinite(pct) ? pct : null;
}

function computePriceChange5m(
  currentPriceUsd: number,
  pairAddress: string,
  now: number
): number | null {
  return computePriceChange(currentPriceUsd, pairAddress, now, FIVE_MINUTES_SEC);
}

function computeLiquidityChange1m(
  currentLiquidityUsd: number,
  pairAddress: string,
  now: number
): number | null {
  const maxTimestamp = now - ONE_MINUTE_SEC;
  const row = selectLiquiditySnapshotAtLeast1mAgo.get({
    pairAddress,
    maxTimestamp,
  }) as { liquidity_usd: number | null } | undefined;
  const oldLiquidity = row?.liquidity_usd;
  if (oldLiquidity == null || !Number.isFinite(oldLiquidity) || oldLiquidity <= 0) return null;
  if (!Number.isFinite(currentLiquidityUsd)) return null;
  const pct = ((currentLiquidityUsd - oldLiquidity) / oldLiquidity) * 100;
  return Number.isFinite(pct) ? pct : null;
}

/**
 * Volume acceleration 1m: (current volume_1m - previous volume_1m) per minute.
 * Uses the most recent snapshot at least 1 minute old. Matches scoring worker formula.
 */
function computeVolumeAcceleration1m(
  volume1m: number | null,
  pairAddress: string,
  now: number
): number | null {
  if (volume1m == null || !Number.isFinite(volume1m)) return null;
  const maxTimestamp = now - ONE_MINUTE_SEC;
  const row = selectVolume1mSnapshotAtLeast1mAgo.get({
    pairAddress,
    maxTimestamp,
  }) as { timestamp: number; volume_1m: number | null } | undefined;
  const prevVolume = row?.volume_1m;
  const prevTimestamp = row?.timestamp;
  if (prevVolume == null || !Number.isFinite(prevVolume) || prevTimestamp == null || !Number.isFinite(prevTimestamp)) return null;
  const elapsedMinutes = Math.max(1, (now - prevTimestamp) / 60);
  const delta = volume1m - prevVolume;
  const acceleration = delta / elapsedMinutes;
  return Number.isFinite(acceleration) ? acceleration : null;
}

function buildSnapshotParams(
  pairAddress: string,
  _baseTokenAddress: string,
  now: number,
  pairCreatedAt: number | null,
  pool: NonNullable<Awaited<ReturnType<typeof getPumpSwapPoolSnapshot>>>,
  priceChange1m: number | null,
  priceChange5m: number | null,
  liquidityChange1m: number | null,
  volume1m: number | null,
  volume5m: number | null,
  volume15m: number | null,
  buyVolume1m: number | null,
  buyVolume5m: number | null,
  buyVolume15m: number | null,
  sellVolume1m: number | null,
  sellVolume5m: number | null,
  sellVolume15m: number | null,
  totalVolume: number | null,
  buys1m: number | null,
  sells1m: number | null,
  totalBuys: number | null,
  totalSells: number | null,
  volumeAcceleration1m: number | null,
  buyPressure1m: number | null,
  sellPressure1m: number | null,
  velocityScore1m: number | null,
  holderInfo: HolderInfo | null
): InsertSnapshotParams {
  const secondsSinceCreation =
    pairCreatedAt != null ? now - coerceDbInt(pairCreatedAt) : null;
  const buySellRatio1m =
    buys1m != null && sells1m != null && sells1m > 0
      ? buys1m / sells1m
      : null;
  const buySellRatio =
    totalBuys != null && totalSells != null && totalSells > 0
      ? totalBuys / totalSells
      : null;
  const totalTransactions =
    totalBuys != null && totalSells != null
      ? totalBuys + totalSells
      : null;
  const transactions1m =
    buys1m != null && sells1m != null
      ? buys1m + sells1m
      : null;
  return {
    pairAddress,
    tokenMint: pool.tokenMint,
    timestamp: now,
    secondsSinceCreation,
    priceUsd: pool.priceUsd,
    priceChange1m,
    priceChange5m,
    marketCap: pool.marketCap,
    fdv: pool.marketCap,
    liquidityUsd: pool.liquidityUsd,
    liquidityChange1m,
    lpLocked: pool.lpLocked ?? null,
    lpLockDuration: null,
    volume1m,
    volume5m,
    volume15m,
    buyVolume1m,
    buyVolume5m,
    buyVolume15m,
    sellVolume1m,
    sellVolume5m,
    sellVolume15m,
    totalVolume,
    buys1m,
    sells1m,
    buySellRatio1m,
    totalBuys,
    totalSells,
    totalTransactions,
    transactions1m,
    buySellRatio,
    buyPressure1m,
    sellPressure1m,
    volumeAcceleration1m,
    velocityScore1m,
    hasMintAuthority: pool.hasMintAuthority,
    hasFreezeAuthority: pool.hasFreezeAuthority,
    canRemoveLiquidity: pool.lpLocked === 1 ? 0 : 1,
    topHolderPct: holderInfo?.topHolderPct ?? null,
    top5HolderPct: holderInfo?.top5HolderPct ?? null,
    holderCount: holderInfo?.holderCount ?? null,
    walletConcentrationScore: holderInfo?.walletConcentrationScore ?? null,
    snapshotReason: REASON_SCHEDULED,
    method: 'rpc',
    source: SNAPSHOT_SOURCE_CHAIN,
  };
}

async function runCycle(connection: Connection): Promise<void> {
  const cycleStartMs = Date.now();
  const logCycleTiming = () => {
    const durationMs = Date.now() - cycleStartMs;
    const timeUntilNextMs = Math.max(0, POLL_INTERVAL_MS - durationMs);
    console.log(
      `${LOG_PREFIX} Cycle finished in ${(durationMs / 1000).toFixed(1)}s, next run in ${(timeUntilNextMs / 1000).toFixed(1)}s`
    );
  };

  const now = Math.floor(Date.now() / 1000);

  const rows = selectPumpswapEligiblePairs.all(eligibleSnapshotParams()) as SnapshotPairRow[];

  if (rows.length === 0) {
    logCycleTiming();
    return;
  }

  console.log(`${LOG_PREFIX} Processing ${rows.length} pair(s) in batches of ${SNAPSHOT_BATCH_SIZE}`);

  // 1. Cache SOL price once per cycle.
  let solPriceUsd: number;
  try {
    console.log(`${LOG_PREFIX} RPC call: getSolPriceUsd`);
    solPriceUsd = await getSolPriceUsd();
  } catch (err) {
    console.error(`${LOG_PREFIX} Failed to get SOL price, skipping cycle:`, err);
    logCycleTiming();
    return;
  }
  if (!Number.isFinite(solPriceUsd) || solPriceUsd <= 0) {
    console.warn(`${LOG_PREFIX} Invalid SOL price, skipping cycle`);
    logCycleTiming();
    return;
  }

  async function snapshotOnePair(
    connection: Connection,
    row: SnapshotPairRow,
    solPriceUsd: number,
    now: number
  ): Promise<void> {
    try {
      await executeWith429Retry(async () => {
        const cachedMint =
          row.base_decimals != null &&
          row.base_has_mint_authority != null &&
          row.base_has_freeze_authority != null &&
          row.base_supply_raw != null
            ? {
                decimals: row.base_decimals,
                hasMintAuthority: row.base_has_mint_authority !== 0,
                hasFreezeAuthority: row.base_has_freeze_authority !== 0,
                supplyRaw: BigInt(row.base_supply_raw),
              }
            : null;
        console.log(`${LOG_PREFIX} RPC call: getPumpSwapPoolSnapshot pool=${row.pair_address.slice(0, 12)}…`);
        const pool = await getPumpSwapPoolSnapshot(
          connection,
          row.pair_address,
          row.base_token_address,
          getSolPriceUsd,
          {
            solPriceUsd,
            cachedMint,
          }
        );
        if (!pool) return;

        if (row.last_snapshot_at == null) {
          console.log(`${LOG_PREFIX} New pair ${row.pair_address.slice(0, 12)}…`);
        }

        const priceChange1m = computePriceChange(
          pool.priceUsd,
          row.pair_address,
          now,
          ONE_MINUTE_SEC
        );
        const priceChange5m = computePriceChange5m(
          pool.priceUsd,
          row.pair_address,
          now
        );
        const liquidityChange1m = computeLiquidityChange1m(
          pool.liquidityUsd,
          row.pair_address,
          now
        );
        const totalBuySellRow = getTotalBuySellCountsForPair.get({ pairAddress: row.pair_address }) as
          | { total_buys: number | null; total_sells: number | null }
          | undefined;
        const totalBuys = coerceDbInt(totalBuySellRow?.total_buys);
        const totalSells = coerceDbInt(totalBuySellRow?.total_sells);
        const totalVolumeLamportsRow = getTotalVolumeLamportsForPair.get({ pairAddress: row.pair_address }) as
          | { total_lamports: unknown }
          | undefined;
        const totalLamports = coerceDbInt(totalVolumeLamportsRow?.total_lamports);
        const totalVolumeUsd =
          Number.isFinite(totalLamports) && Number.isFinite(solPriceUsd) && solPriceUsd > 0
            ? (totalLamports / LAMPORTS_PER_SOL) * solPriceUsd
            : null;
        const nowMs = Date.now();
        const lamportsToUsd = (lamports: number): number | null =>
          Number.isFinite(lamports) && Number.isFinite(solPriceUsd) && solPriceUsd > 0
            ? (lamports / LAMPORTS_PER_SOL) * solPriceUsd
            : null;
        const vol1mRow = getVolumeLamportsSinceMs.get({ pairAddress: row.pair_address, sinceMs: nowMs - ONE_MINUTE_MS }) as { lamports: unknown } | undefined;
        const vol5mRow = getVolumeLamportsSinceMs.get({ pairAddress: row.pair_address, sinceMs: nowMs - FIVE_MINUTES_MS }) as { lamports: unknown } | undefined;
        const vol15mRow = getVolumeLamportsSinceMs.get({ pairAddress: row.pair_address, sinceMs: nowMs - FIFTEEN_MINUTES_MS }) as { lamports: unknown } | undefined;
        const volume1m = lamportsToUsd(coerceDbInt(vol1mRow?.lamports));
        const volume5m = lamportsToUsd(coerceDbInt(vol5mRow?.lamports));
        const volume15m = lamportsToUsd(coerceDbInt(vol15mRow?.lamports));
        // 1m buy/sell counts from pair_swap_events (created_at in ms).
        const sinceMs = nowMs - ONE_MINUTE_MS;
        const counts1mRows = getBuySellCounts1m.all({ pairAddress: row.pair_address, sinceMs }) as Array<{ direction: string; cnt: unknown }>;
        let buys1m: number | null = null;
        let sells1m: number | null = null;
        for (const r of counts1mRows) {
          if (r.direction === 'buy') buys1m = coerceDbInt(r.cnt);
          else if (r.direction === 'sell') sells1m = coerceDbInt(r.cnt);
        }
        // Buy/sell volume 1m (SOL) for buy_pressure_1m = buy_volume_1m / (buy_volume_1m + sell_volume_1m).
        const buySellVol1mRows = getBuySellVolumeLamports1m.all({ pairAddress: row.pair_address, sinceMs }) as Array<{ direction: string; lamports: unknown }>;
        let buyLamports1m = 0;
        let sellLamports1m = 0;
        for (const r of buySellVol1mRows) {
          if (r.direction === 'buy') buyLamports1m = coerceDbInt(r.lamports);
          else if (r.direction === 'sell') sellLamports1m = coerceDbInt(r.lamports);
        }
        const buyVol1mUsd = lamportsToUsd(buyLamports1m);
        const sellVol1mUsd = lamportsToUsd(sellLamports1m);
        const totalVol1mUsd = buyVol1mUsd != null && sellVol1mUsd != null ? buyVol1mUsd + sellVol1mUsd : null;
        // Sell volume 5m and 15m (reuse same query with different sinceMs).
        const buySellVol5mRows = getBuySellVolumeLamports1m.all({ pairAddress: row.pair_address, sinceMs: nowMs - FIVE_MINUTES_MS }) as Array<{ direction: string; lamports: unknown }>;
        const buySellVol15mRows = getBuySellVolumeLamports1m.all({ pairAddress: row.pair_address, sinceMs: nowMs - FIFTEEN_MINUTES_MS }) as Array<{ direction: string; lamports: unknown }>;
        let buyLamports5m = 0;
        let sellLamports5m = 0;
        let buyLamports15m = 0;
        let sellLamports15m = 0;
        for (const r of buySellVol5mRows) {
          if (r.direction === 'buy') buyLamports5m = coerceDbInt(r.lamports);
          else if (r.direction === 'sell') sellLamports5m = coerceDbInt(r.lamports);
        }
        for (const r of buySellVol15mRows) {
          if (r.direction === 'buy') buyLamports15m = coerceDbInt(r.lamports);
          else if (r.direction === 'sell') sellLamports15m = coerceDbInt(r.lamports);
        }
        const sellVol5mUsd = lamportsToUsd(sellLamports5m);
        const sellVol15mUsd = lamportsToUsd(sellLamports15m);
        const buyVol5mUsd = lamportsToUsd(buyLamports5m);
        const buyVol15mUsd = lamportsToUsd(buyLamports15m);
        const buyPressure1m =
          totalVol1mUsd != null && totalVol1mUsd > 0 && buyVol1mUsd != null
            ? buyVol1mUsd / totalVol1mUsd
            : null;
        const sellPressure1m =
          totalVol1mUsd != null && totalVol1mUsd > 0 && sellVol1mUsd != null
            ? sellVol1mUsd / totalVol1mUsd
            : null;
        const transactions1m =
          buys1m != null && sells1m != null
            ? buys1m + sells1m
            : null;
        // Velocity score 1m: activity vs previous minute. Query most recent previous snapshot (index: pair_address, timestamp).
        const prevTxRow = selectPrevSnapshotTransactions1m.get({
          pairAddress: row.pair_address,
          timestamp: now,
        }) as { transactions_1m: unknown } | undefined;
        const prevTransactions1m =
          prevTxRow?.transactions_1m != null ? coerceDbInt(prevTxRow.transactions_1m) : null;
        const velocityScore1m =
          prevTransactions1m != null && prevTransactions1m > 0
            ? (transactions1m ?? 0) / prevTransactions1m
            : ((transactions1m ?? 0) > 0 ? 2 : 1);
        const volumeAcceleration1m = computeVolumeAcceleration1m(volume1m, row.pair_address, now);
        const holderInfo: HolderInfo | null = null;
        const params = buildSnapshotParams(
          row.pair_address,
          row.base_token_address,
          now,
          row.pair_created_at,
          pool,
          priceChange1m,
          priceChange5m,
          liquidityChange1m,
          volume1m,
          volume5m,
          volume15m,
          buyVol1mUsd ?? null,
          buyVol5mUsd ?? null,
          buyVol15mUsd ?? null,
          sellVol1mUsd ?? null,
          sellVol5mUsd ?? null,
          sellVol15mUsd ?? null,
          totalVolumeUsd,
          buys1m,
          sells1m,
          totalBuys,
          totalSells,
          volumeAcceleration1m,
          buyPressure1m,
          sellPressure1m,
          velocityScore1m,
          holderInfo
        );
        const snapshotId = insertSnapshotRow(params);
        applyRollingBaselinesToSnapshot(row.pair_address, now, snapshotId, volume5m);
        applyRollingLiquidityToSnapshot(row.pair_address, now, snapshotId, pool.liquidityUsd);
        updatePairLastSnapshotAt.run({ lastSnapshotAt: now, pairAddress: row.pair_address });

        const pairCreatedAt = row.pair_created_at ?? null;
        const tokenAgeSeconds = pairCreatedAt != null ? now - pairCreatedAt : null;
        const hasOpenTrade = row.has_open_trade != null && row.has_open_trade !== 0;
        const { newTier } = updatePairTierAfterSnapshot(
          row.pair_address,
          row.tracking_tier,
          now,
          tokenAgeSeconds,
          pool.liquidityUsd,
          volume5m,
          hasOpenTrade,
          LOG_PREFIX,
          pool.lpLocked ?? null
        );
        if (newTier === 'dormant') {
          const client = getRedis();
          if (client) {
            try {
              await client.publish(
                REDIS_CHANNEL_PAIRS_DORMANT,
                JSON.stringify({ pairAddress: row.pair_address })
              );
            } catch (err) {
              console.warn(`${LOG_PREFIX} Redis publish (pairs:dormant) failed:`, err instanceof Error ? err.message : err);
            }
          }
        }

        await scorePairNow(row.pair_address, {
          token_mint: row.base_token_address ?? undefined,
          snapshot_timestamp: now,
        });
      });
    } catch (err) {
      console.error(`${LOG_PREFIX} Error snapshotting ${row.pair_address}:`, err);
    }
  }

  for (let i = 0; i < rows.length; i += SNAPSHOT_BATCH_SIZE) {
    const batch = rows.slice(i, i + SNAPSHOT_BATCH_SIZE);
    await Promise.all(batch.map((row) => snapshotOnePair(connection, row, solPriceUsd, now)));
    if (i + SNAPSHOT_BATCH_SIZE < rows.length) {
      await new Promise((r) => setTimeout(r, DELAY_BETWEEN_BATCHES_MS));
    }
  }

  logCycleTiming();
}

export async function startChainSnapshotsWorker(): Promise<void> {
  const rpcUrl = getSolanaRpcUrl();
  if (!rpcUrl) {
    console.error(`${LOG_PREFIX} HELIUS_RPC_URL is required. Exiting.`);
    process.exit(1);
  }

  const enabledDexes = getEnabledDexes();
  if (enabledDexes !== null && !enabledDexes.has(DEX_PUMPSWAP)) {
    console.log(
      `${LOG_PREFIX} ENABLED_DEXES is set and does not include pumpswap. Exiting.`
    );
    process.exit(0);
  }

  const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
  console.log(
    `${LOG_PREFIX} Starting (poll every ${POLL_INTERVAL_MS / 1000}s, PumpSwap only)`
  );

  async function cycle(): Promise<void> {
    try {
      await runCycle(connection);
    } catch (err) {
      console.error(`${LOG_PREFIX} Cycle error:`, err);
    }
  }

  await cycle();
  setInterval(cycle, POLL_INTERVAL_MS);
}

import { fileURLToPath } from 'node:url';

const isMain =
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1]?.endsWith('chain-snapshots-worker.js');

if (isMain) {
  startChainSnapshotsWorker().catch((err) => {
    console.error(`${LOG_PREFIX} Fatal:`, err);
    process.exit(1);
  });
}
