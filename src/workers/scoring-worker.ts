import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { db } from '../db.js';
import {
  type MarketMode,
  resolveMarketMode,
  isFeatureSupported,
  getUnsupportedFeatures,
} from '../market-mode.js';
import type { EntryFilterRejectReason } from '../types/entry-filter-reject-reasons.js';
import { SNAPSHOT_PAIR_ELIGIBILITY_CONDS, MAX_PAIR_AGE_UNBOUNDED_SEC } from './snapshot-pair-eligibility-sql.js';
import { isPairEligibleForChainSnapshots } from './snapshot-pair-eligibility-check.js';

const WORKER_VERSION = '1.0.0';
const CHAIN = 'solana';
const POLL_INTERVAL_MS = 30_000; // 30 seconds
const SNAPSHOT_WINDOW_SECONDS = 600; // 10 minutes lookback for features
const MAX_SNAPSHOTS_FOR_FEATURES = 5;
const NORMALIZE_CLAMP = 100; // clamp features to 0–100 scale
const NORMALIZE_SCORE_MAX = 100; // normalized score 0–100

interface PolicyRow {
  policy_id: number;
  policy_version: string;
  max_pair_age_seconds: number | null;
  min_token_age_seconds: number | null;
  min_liquidity_usd: number | null;
  min_volume_1m_usd: number | null;
  min_price_change_1m_pct: number | null;
  min_volume_5m_usd: number | null;
  min_buy_sell_ratio: number | null;
  min_transactions_1m: number | null;
  min_velocity_score_1m: number | null;
  min_buy_pressure_1m: number | null;
  min_buy_volume_1m_usd: number | null;
  min_sell_volume_1m_usd: number | null;
  require_no_mint_authority: number | null;
  require_no_freeze_authority: number | null;
  require_lp_lock: number | null;
  max_top_holder_pct: number | null;
  min_holder_count: number | null;
  allowed_dexes: string | null;
  weight_liquidity_velocity: number | null;
  weight_liquidity_absolute: number | null;
  weight_volume_1m: number | null;
  weight_volume_5m: number | null;
  weight_volume_acceleration_1m: number | null;
  weight_price_volatility_5m: number | null;
  weight_market_cap: number | null;
  weight_buy_sell_slope_1m: number | null;
  weight_velocity_score_1m: number | null;
  weight_buy_pressure_1m: number | null;
  weight_sell_pressure_1m: number | null;
  weight_buy_volume_1m: number | null;
  weight_sell_volume_1m: number | null;
  weight_price_momentum_5m: number | null;
  weight_holder_concentration_penalty: number | null;
  min_trade_score: number | null;
  priority_trade_score: number | null;
  liquidity_trend_guard_enabled: number | null;
  max_liquidity_drop_pct_30m: number | null;
  max_liquidity_drop_pct_1h: number | null;
  liquidity_trend_min_samples: number | null;
  weight_pair_age_seconds: number | null;
}

interface PairRow {
  pair_address: string;
  base_token_address: string;
  dex: string;
  pair_created_at: number | null;
  first_seen_at: number;
  creator_wallet: string | null;
}

interface SnapshotRow {
  snapshot_id: number;
  pair_address: string;
  timestamp: number;
  seconds_since_creation: number | null;
  price_usd: number | null;
  price_change_1m: number | null;
  price_change_5m: number | null;
  liquidity_usd: number | null;
  market_cap: number | null;
  volume_1m: number | null;
  volume_5m: number | null;
  volume_acceleration_1m: number | null;
  buys_1m: number | null;
  sells_1m: number | null;
  buy_sell_ratio_1m: number | null;
  transactions_1m: number | null;
  velocity_score_1m: number | null;
  buy_pressure_1m: number | null;
  sell_pressure_1m: number | null;
  buy_volume_1m: number | null;
  sell_volume_1m: number | null;
  has_mint_authority: number | null;
  has_freeze_authority: number | null;
  lp_locked: number | null;
  top_holder_pct: number | null;
  holder_count: number | null;
  liquidity_change_pct_30m: number | null;
  liquidity_change_pct_1h: number | null;
  liquidity_sample_count: number | null;
}

interface RawFeatures {
  liquidity_velocity: number | null;
  liquidity_absolute: number | null;
  volume_1m: number | null;
  volume_5m: number | null;
  volume_acceleration_1m: number | null;
  price_volatility: number | null;
  market_cap: number | null;
  buy_sell_slope: number | null;
  velocity_score_1m: number | null;
  buy_pressure_1m: number | null;
  sell_pressure_1m: number | null;
  buy_volume_1m: number | null;
  sell_volume_1m: number | null;
  price_momentum: number | null;
  holder_concentration_penalty: number | null;
  pair_age_seconds: number | null;
}

interface NormalizedFeatures {
  liquidity_velocity: number;
  liquidity_absolute: number;
  volume_1m: number;
  volume_5m: number;
  volume_acceleration_1m: number;
  price_volatility: number;
  market_cap: number;
  buy_sell_slope: number;
  velocity_score_1m: number;
  buy_pressure_1m: number;
  sell_pressure_1m: number;
  buy_volume_1m: number;
  sell_volume_1m: number;
  price_momentum: number;
  holder_concentration_penalty: number;
  pair_age_seconds: number;
}

type Signal = 'NO_TRADE' | 'WATCH' | 'TRADE_CANDIDATE' | 'PRIORITY_TRADE';
type ConfidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH';

const getAllActivePolicies = db.prepare(`
  SELECT policy_id, policy_version, max_pair_age_seconds, min_token_age_seconds, min_liquidity_usd,
    min_volume_1m_usd, min_price_change_1m_pct, min_volume_5m_usd, min_buy_sell_ratio, min_transactions_1m, min_velocity_score_1m, min_buy_pressure_1m,
    min_buy_volume_1m_usd, min_sell_volume_1m_usd,
    require_no_mint_authority, require_no_freeze_authority, require_lp_lock, max_top_holder_pct, min_holder_count, allowed_dexes,
    weight_liquidity_velocity, weight_liquidity_absolute, weight_volume_1m, weight_volume_5m, weight_volume_acceleration_1m, weight_price_volatility_5m, weight_market_cap, weight_buy_sell_slope_1m,
    weight_velocity_score_1m, weight_buy_pressure_1m, weight_sell_pressure_1m,
    weight_buy_volume_1m, weight_sell_volume_1m,
    weight_price_momentum_5m, weight_holder_concentration_penalty, weight_pair_age_seconds,
    min_trade_score, priority_trade_score,
    liquidity_trend_guard_enabled, max_liquidity_drop_pct_30m, max_liquidity_drop_pct_1h, liquidity_trend_min_samples
  FROM policies
  WHERE status = 'active'
  ORDER BY activated_at DESC, created_at DESC
`);

/** PumpSwap pairs must match chain snapshot eligibility; other DEXes only need a recent snapshot. */
const getPairsWithRecentSnapshots = db.prepare(`
  SELECT DISTINCT p.pair_address, p.base_token_address, p.dex, p.pair_created_at,
    p.first_seen_at, p.creator_wallet
  FROM pairs p
  INNER JOIN pair_snapshots s ON s.pair_address = p.pair_address
  WHERE s.timestamp >= $cutoff
    AND (
      LOWER(TRIM(COALESCE(p.dex, ''))) != 'pumpswap'
      OR (
        p.dex = $dex
        ${SNAPSHOT_PAIR_ELIGIBILITY_CONDS}
      )
    )
  ORDER BY p.first_seen_at DESC
  LIMIT 100
`);

const getPairByAddress = db.prepare(`
  SELECT pair_address, base_token_address, dex, pair_created_at, first_seen_at, creator_wallet
  FROM pairs WHERE pair_address = $pairAddress
`);

const getSnapshotsForPair = db.prepare(`
  SELECT snapshot_id, pair_address, timestamp, seconds_since_creation,
    price_usd, price_change_1m, price_change_5m, liquidity_usd, market_cap, volume_1m, volume_5m, volume_acceleration_1m,
    buys_1m, sells_1m, buy_sell_ratio_1m, transactions_1m, velocity_score_1m, buy_pressure_1m, sell_pressure_1m,
    buy_volume_1m, sell_volume_1m,
    has_mint_authority, has_freeze_authority,
    lp_locked, top_holder_pct, holder_count,
    liquidity_change_pct_30m, liquidity_change_pct_1h, liquidity_sample_count
  FROM pair_snapshots
  WHERE pair_address = $pairAddress AND timestamp <= $timestamp
  ORDER BY timestamp DESC
  LIMIT $limit
`);

const FEATURE_KEYS: (keyof RawFeatures)[] = [
  'liquidity_velocity',
  'liquidity_absolute',
  'volume_1m',
  'volume_5m',
  'volume_acceleration_1m',
  'price_volatility',
  'market_cap',
  'buy_sell_slope',
  'velocity_score_1m',
  'buy_pressure_1m',
  'sell_pressure_1m',
  'buy_volume_1m',
  'sell_volume_1m',
  'price_momentum',
  'holder_concentration_penalty',
  'pair_age_seconds',
];

const FEATURE_LABELS: Record<keyof RawFeatures, string> = {
  liquidity_velocity: 'Liquidity velocity',
  liquidity_absolute: 'Liquidity absolute',
  volume_1m: 'Volume 1m',
  volume_5m: 'Volume 5m',
  volume_acceleration_1m: 'Volume acceleration 1m',
  price_volatility: 'Price volatility',
  market_cap: 'Market cap',
  buy_sell_slope: 'Buy/sell slope',
  velocity_score_1m: 'Velocity score 1m',
  buy_pressure_1m: 'Buy pressure 1m',
  sell_pressure_1m: 'Sell pressure 1m',
  buy_volume_1m: 'Buy volume 1m',
  sell_volume_1m: 'Sell volume 1m',
  price_momentum: 'Price momentum',
  holder_concentration_penalty: 'Holder concentration penalty',
  pair_age_seconds: 'Pair age',
};

function getMissingFeatureNames(
  raw: RawFeatures,
  unsupportedFeatures: string[]
): string[] {
  return FEATURE_KEYS.filter((k) => {
    if (unsupportedFeatures.includes(FEATURE_TO_SUPPORT_KEY[k])) return false;
    return raw[k] == null || !Number.isFinite(raw[k] as number);
  }).map((k) => FEATURE_LABELS[k]);
}

const insertPairScore = db.prepare(`
  INSERT INTO pair_scores (
    pair_address, chain, scored_at, policy_version, market_mode,
    eligible, reject_reason, reject_stage,
    total_score, score_normalized, signal, confidence_level,
    feature_values, feature_weights, feature_contributions, penalty_contributions,
    snapshot_ids, snapshot_window_seconds,
    missing_feature_count, missing_features, used_fallback_values, data_quality_score,
    worker_version, run_id, notes
  ) VALUES ($pairAddress, $chain, $scoredAt, $policyVersion, $marketMode,
    $eligible, $rejectReason, $rejectStage,
    $totalScore, $scoreNormalized, $signal, $confidenceLevel,
    $featureValues, $featureWeights, $featureContributions, $penaltyContributions,
    $snapshotIds, $snapshotWindowSeconds,
    $missingFeatureCount, $missingFeatures, $usedFallbackValues, $dataQualityScore,
    $workerVersion, $runId, $notes)
`);

const insertEntryFilterRejection = db.prepare(`
  INSERT INTO entry_filter_rejections (policy_version, pair_address, token_mint, sub_reason, observed_value, threshold_value, decided_at)
  VALUES ($policyVersion, $pairAddress, $tokenMint, $subReason, $observedValue, $thresholdValue, $decidedAt)
`);

// Stage 1: Eligibility filter (hard rules)
// Skips checks for unsupported features. On reject, returns canonical entry filter reason + observed/threshold for logging.
type EligibilityResult =
  | { eligible: true; rejectReason: null; rejectStage: null; entryFilterSubReason?: undefined; observedValue?: undefined; thresholdValue?: undefined }
  | {
      eligible: false;
      rejectReason: string;
      rejectStage: 'hard_filter';
      entryFilterSubReason: EntryFilterRejectReason;
      observedValue: number | null;
      thresholdValue: number | null;
    };

function eligibilityFilter(
  pair: PairRow,
  latestSnapshot: SnapshotRow | null,
  policy: PolicyRow,
  marketMode: MarketMode
): EligibilityResult {
  const maxAge = policy.max_pair_age_seconds ?? 999999;
  const allowedDexes = (policy.allowed_dexes ?? 'raydium,orca')
    .toLowerCase()
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);

  const pairAgeSeconds =
    latestSnapshot?.seconds_since_creation ??
    (pair.pair_created_at ? Math.floor(Date.now() / 1000) - pair.pair_created_at : null);
  if (pairAgeSeconds != null && pairAgeSeconds > maxAge) {
    return {
      eligible: false,
      rejectReason: `pair_age_${pairAgeSeconds}s > ${maxAge}s`,
      rejectStage: 'hard_filter',
      entryFilterSubReason: 'PAIR_TOO_OLD',
      observedValue: pairAgeSeconds,
      thresholdValue: maxAge,
    };
  }

  const minAge = policy.min_token_age_seconds;
  if (minAge != null && pairAgeSeconds != null && pairAgeSeconds < minAge) {
    return {
      eligible: false,
      rejectReason: `pair_age_${pairAgeSeconds}s < min_token_age_${minAge}s`,
      rejectStage: 'hard_filter',
      entryFilterSubReason: 'MIN_TOKEN_AGE',
      observedValue: pairAgeSeconds,
      thresholdValue: minAge,
    };
  }

  const pairDex = (pair.dex ?? '').toString().toLowerCase().trim();
  if (!pairDex || !allowedDexes.includes(pairDex)) {
    return {
      eligible: false,
      rejectReason: `dex_${pair.dex}_not_allowed`,
      rejectStage: 'hard_filter',
      entryFilterSubReason: 'DEX_NOT_ALLOWED',
      observedValue: null,
      thresholdValue: null,
    };
  }

  if (isFeatureSupported('lp_lock', marketMode) && policy.require_lp_lock === 1 && latestSnapshot?.lp_locked !== 1) {
    return {
      eligible: false,
      rejectReason: 'lp_not_locked',
      rejectStage: 'hard_filter',
      entryFilterSubReason: 'LP_NOT_LOCKED',
      observedValue: latestSnapshot?.lp_locked ?? 0,
      thresholdValue: 1,
    };
  }

  if (isFeatureSupported('liquidity_usd', marketMode)) {
    const minLiq = policy.min_liquidity_usd;
    if (minLiq != null && minLiq > 0) {
      const liq = latestSnapshot?.liquidity_usd ?? 0;
      if (liq < minLiq) {
        return {
          eligible: false,
          rejectReason: `liquidity_${liq} < ${minLiq}`,
          rejectStage: 'hard_filter',
          entryFilterSubReason: 'MIN_LIQUIDITY',
          observedValue: liq,
          thresholdValue: minLiq,
        };
      }
    }
  }

  if (isFeatureSupported('volume_1m', marketMode)) {
    const minVol = policy.min_volume_1m_usd;
    if (minVol != null && minVol > 0) {
      const vol = latestSnapshot?.volume_1m ?? 0;
      if (vol < minVol) {
        return {
          eligible: false,
          rejectReason: `volume_1m_${vol} < ${minVol}`,
          rejectStage: 'hard_filter',
          entryFilterSubReason: 'MIN_VOLUME_1M',
          observedValue: vol,
          thresholdValue: minVol,
        };
      }
    }
  } else if (isFeatureSupported('volume_5m', marketMode)) {
    const minVol5m = policy.min_volume_5m_usd;
    if (minVol5m != null && minVol5m > 0) {
      const vol = latestSnapshot?.volume_5m ?? 0;
      if (vol < minVol5m) {
        return {
          eligible: false,
          rejectReason: `volume_5m_${vol} < ${minVol5m}`,
          rejectStage: 'hard_filter',
          entryFilterSubReason: 'MIN_VOLUME_5M',
          observedValue: vol,
          thresholdValue: minVol5m,
        };
      }
    }
  }

  if (isFeatureSupported('price_change_1m', marketMode)) {
    const minPc = policy.min_price_change_1m_pct;
    if (minPc != null && Number.isFinite(minPc)) {
      const chg = latestSnapshot?.price_change_1m;
      if (chg == null || !Number.isFinite(chg) || chg < minPc) {
        return {
          eligible: false,
          rejectReason:
            chg == null || !Number.isFinite(chg)
              ? 'price_change_1m_missing'
              : `price_change_1m_${chg} < ${minPc}`,
          rejectStage: 'hard_filter',
          entryFilterSubReason: 'MIN_PRICE_CHANGE_1M_PCT',
          observedValue: chg != null && Number.isFinite(chg) ? chg : null,
          thresholdValue: minPc,
        };
      }
    }
  }

  if (isFeatureSupported('buy_sell_slope', marketMode)) {
    const minBuySell = policy.min_buy_sell_ratio ?? 0;
    if (minBuySell > 0) {
      const buySell = latestSnapshot?.buy_sell_ratio_1m ?? 0;
      if (buySell < minBuySell) {
        return {
          eligible: false,
          rejectReason: `buy_sell_ratio_${buySell.toFixed(2)} < ${minBuySell}`,
          rejectStage: 'hard_filter',
          entryFilterSubReason: 'BUY_SELL_RATIO',
          observedValue: buySell,
          thresholdValue: minBuySell,
        };
      }
    }
  }

  if (isFeatureSupported('velocity_score_1m', marketMode)) {
    const minTx = policy.min_transactions_1m;
    if (minTx != null && minTx > 0) {
      const tx = latestSnapshot?.transactions_1m ?? 0;
      if (tx < minTx) {
        return {
          eligible: false,
          rejectReason: `transactions_1m_${tx} < ${minTx}`,
          rejectStage: 'hard_filter',
          entryFilterSubReason: 'MIN_TRANSACTIONS_1M',
          observedValue: tx,
          thresholdValue: minTx,
        };
      }
    }
  }

  if (isFeatureSupported('velocity_score_1m', marketMode)) {
    const minVel = policy.min_velocity_score_1m;
    if (minVel != null && minVel > 0) {
      const vel = latestSnapshot?.velocity_score_1m ?? null;
      if (vel != null && vel < minVel) {
        return {
          eligible: false,
          rejectReason: `velocity_score_1m_${vel.toFixed(2)} < ${minVel}`,
          rejectStage: 'hard_filter',
          entryFilterSubReason: 'MIN_VELOCITY_SCORE_1M',
          observedValue: vel,
          thresholdValue: minVel,
        };
      }
    }
  }

  if (isFeatureSupported('buy_pressure_1m', marketMode)) {
    const minBuyPressure = policy.min_buy_pressure_1m;
    if (minBuyPressure != null && minBuyPressure > 0) {
      const pressure = latestSnapshot?.buy_pressure_1m ?? null;
      if (pressure != null && pressure < minBuyPressure) {
        return {
          eligible: false,
          rejectReason: `buy_pressure_1m_${pressure.toFixed(2)} < ${minBuyPressure}`,
          rejectStage: 'hard_filter',
          entryFilterSubReason: 'MIN_BUY_PRESSURE_1M',
          observedValue: pressure,
          thresholdValue: minBuyPressure,
        };
      }
    }
  }

  if (isFeatureSupported('buy_volume_1m', marketMode)) {
    const minBuyVol = policy.min_buy_volume_1m_usd;
    if (minBuyVol != null && minBuyVol > 0) {
      const vol = latestSnapshot?.buy_volume_1m ?? 0;
      if (vol < minBuyVol) {
        return {
          eligible: false,
          rejectReason: `buy_volume_1m_${vol} < ${minBuyVol}`,
          rejectStage: 'hard_filter',
          entryFilterSubReason: 'MIN_BUY_VOLUME_1M',
          observedValue: vol,
          thresholdValue: minBuyVol,
        };
      }
    }
  }

  if (isFeatureSupported('sell_volume_1m', marketMode)) {
    const minSellVol = policy.min_sell_volume_1m_usd;
    if (minSellVol != null && minSellVol > 0) {
      const vol = latestSnapshot?.sell_volume_1m ?? 0;
      if (vol < minSellVol) {
        return {
          eligible: false,
          rejectReason: `sell_volume_1m_${vol} < ${minSellVol}`,
          rejectStage: 'hard_filter',
          entryFilterSubReason: 'MIN_SELL_VOLUME_1M',
          observedValue: vol,
          thresholdValue: minSellVol,
        };
      }
    }
  }

  if (policy.require_no_mint_authority === 1 && latestSnapshot?.has_mint_authority === 1) {
    return {
      eligible: false,
      rejectReason: 'has_mint_authority',
      rejectStage: 'hard_filter',
      entryFilterSubReason: 'HAS_MINT_AUTHORITY',
      observedValue: 1,
      thresholdValue: 0,
    };
  }
  if (policy.require_no_freeze_authority === 1 && latestSnapshot?.has_freeze_authority === 1) {
    return {
      eligible: false,
      rejectReason: 'has_freeze_authority',
      rejectStage: 'hard_filter',
      entryFilterSubReason: 'HAS_FREEZE_AUTHORITY',
      observedValue: 1,
      thresholdValue: 0,
    };
  }

  if (isFeatureSupported('holder_concentration_penalty', marketMode)) {
    const maxTopHolder = policy.max_top_holder_pct ?? 100;
    const topHolder = latestSnapshot?.top_holder_pct ?? 0;
    if (topHolder > maxTopHolder) {
      return {
        eligible: false,
        rejectReason: `top_holder_${topHolder.toFixed(1)}% > ${maxTopHolder}%`,
        rejectStage: 'hard_filter',
        entryFilterSubReason: 'MAX_TOP_HOLDER_PCT',
        observedValue: topHolder,
        thresholdValue: maxTopHolder,
      };
    }
  }

  const minHolderCount = policy.min_holder_count;
  if (minHolderCount != null && minHolderCount > 0) {
    const holderCount = latestSnapshot?.holder_count ?? 0;
    if (holderCount < minHolderCount) {
      return {
        eligible: false,
        rejectReason: `holder_count_${holderCount} < ${minHolderCount}`,
        rejectStage: 'hard_filter',
        entryFilterSubReason: 'MIN_HOLDER_COUNT',
        observedValue: holderCount,
        thresholdValue: minHolderCount,
      };
    }
  }

  // Liquidity trend guard: reject when liquidity is draining beyond allowed thresholds
  if (policy.liquidity_trend_guard_enabled === 1) {
    const minSamples = policy.liquidity_trend_min_samples ?? 6;
    const sampleCount = latestSnapshot?.liquidity_sample_count ?? 0;
    if (sampleCount >= minSamples) {
      const maxDrop30m = policy.max_liquidity_drop_pct_30m ?? -0.25;
      const maxDrop1h = policy.max_liquidity_drop_pct_1h ?? -0.35;
      const change30m = latestSnapshot?.liquidity_change_pct_30m ?? null;
      const change1h = latestSnapshot?.liquidity_change_pct_1h ?? null;
      const drain30m = change30m != null && maxDrop30m != null && change30m <= maxDrop30m;
      const drain1h = change1h != null && maxDrop1h != null && change1h <= maxDrop1h;
      if (drain30m || drain1h) {
        const worst = [change30m, change1h].filter((c): c is number => c != null && c <= 0)[0] ?? change30m ?? change1h ?? null;
        const extreme = (change30m != null && change30m <= -0.5) || (change1h != null && change1h <= -0.5);
        console.info(
          `[scoring] liquidity_drain guard blocked entry pair=${pair.pair_address.slice(0, 12)}… policy=${policy.policy_version} change_30m=${change30m?.toFixed(3)} change_1h=${change1h?.toFixed(3)}${extreme ? ' (extreme drain)' : ''}`
        );
        return {
          eligible: false,
          rejectReason: `liquidity_drain_${worst != null ? (worst * 100).toFixed(1) : '?'}%`,
          rejectStage: 'hard_filter',
          entryFilterSubReason: 'LIQUIDITY_DRAIN',
          observedValue: worst,
          thresholdValue: drain30m ? maxDrop30m : maxDrop1h,
        };
      }
    }
  }

  return { eligible: true, rejectReason: null, rejectStage: null };
}

// Map RawFeatures keys to FEATURE_SUPPORT keys
const FEATURE_TO_SUPPORT_KEY: Record<keyof RawFeatures, string> = {
  liquidity_velocity: 'liquidity_velocity',
  liquidity_absolute: 'liquidity_absolute',
  volume_1m: 'volume_1m',
  volume_5m: 'volume_5m',
  volume_acceleration_1m: 'volume_acceleration_1m',
  buy_sell_slope: 'buy_sell_slope',
  velocity_score_1m: 'velocity_score_1m',
  buy_pressure_1m: 'buy_pressure_1m',
  sell_pressure_1m: 'sell_pressure_1m',
  buy_volume_1m: 'buy_volume_1m',
  sell_volume_1m: 'sell_volume_1m',
  price_momentum: 'price_momentum',
  price_volatility: 'price_volatility',
  holder_concentration_penalty: 'holder_concentration_penalty',
  market_cap: 'market_cap',
  pair_age_seconds: 'pair_age_seconds',
};

// Stage 2: Feature extraction
// Unsupported features are set to null; they do not penalize score or trigger halts
function extractFeatures(
  snapshots: SnapshotRow[],
  marketMode: MarketMode
): RawFeatures & { usedFallback: boolean; unsupportedFeatures: string[] } {
  let usedFallback = false;
  const unsupportedFeatures: string[] = [];
  const latest = snapshots[0] ?? null;
  const prev = snapshots[1] ?? null;

  const support = (k: keyof RawFeatures) => {
    const key = FEATURE_TO_SUPPORT_KEY[k];
    if (!isFeatureSupported(key, marketMode)) {
      unsupportedFeatures.push(key);
      return null;
    }
    return true;
  };

  let liquidityVelocity: number | null = null;
  if (support('liquidity_velocity')) {
    liquidityVelocity =
      latest?.liquidity_usd != null && prev?.liquidity_usd != null && prev?.timestamp != null && latest?.timestamp != null
        ? ((latest.liquidity_usd - prev.liquidity_usd) / Math.max(1, latest.timestamp - prev.timestamp)) * 60
        : null;
  }

  let volumeAcceleration1m: number | null = null;
  if (support('volume_acceleration_1m')) {
    volumeAcceleration1m =
      latest?.volume_1m != null && prev?.volume_1m != null && prev?.timestamp != null && latest?.timestamp != null
        ? (latest.volume_1m - prev.volume_1m) / Math.max(1, (latest.timestamp - prev.timestamp) / 60)
        : null;
    if (volumeAcceleration1m == null && latest?.volume_acceleration_1m != null) {
      volumeAcceleration1m = latest.volume_acceleration_1m;
      usedFallback = true;
    }
  }

  let buySellSlope: number | null = null;
  if (support('buy_sell_slope')) buySellSlope = latest?.buy_sell_ratio_1m ?? null; // 1m

  let velocityScore1m: number | null = null;
  if (support('velocity_score_1m')) velocityScore1m = latest?.velocity_score_1m ?? null;

  let buyPressure1m: number | null = null;
  if (support('buy_pressure_1m')) buyPressure1m = latest?.buy_pressure_1m ?? null;

  let sellPressure1m: number | null = null;
  if (support('sell_pressure_1m')) sellPressure1m = latest?.sell_pressure_1m ?? null;

  let buyVolume1m: number | null = null;
  if (support('buy_volume_1m')) buyVolume1m = latest?.buy_volume_1m ?? null;

  let sellVolume1m: number | null = null;
  if (support('sell_volume_1m')) sellVolume1m = latest?.sell_volume_1m ?? null;

  let priceMomentum: number | null = null;
  if (support('price_momentum')) priceMomentum = latest?.price_change_5m ?? null; // 5m

  let holderConcentrationPenalty: number | null = null;
  if (support('holder_concentration_penalty')) {
    const topHolder = latest?.top_holder_pct ?? null;
    holderConcentrationPenalty = topHolder != null ? Math.min(100, Math.max(0, topHolder)) : null;
  }

  let liquidityAbsolute: number | null = null;
  if (support('liquidity_absolute')) liquidityAbsolute = latest?.liquidity_usd ?? null;

  let volume1m: number | null = null;
  if (support('volume_1m')) volume1m = latest?.volume_1m ?? null;

  let volume5m: number | null = null;
  if (support('volume_5m')) volume5m = latest?.volume_5m ?? null;

  let priceVolatility: number | null = null;
  if (support('price_volatility')) {
    priceVolatility = latest?.price_change_5m != null ? Math.abs(latest.price_change_5m) : null; // 5m
  }

  let marketCap: number | null = null;
  if (support('market_cap')) marketCap = latest?.market_cap ?? null;

  let pairAgeSeconds: number | null = null;
  if (support('pair_age_seconds')) pairAgeSeconds = latest?.seconds_since_creation ?? null;

  return {
    liquidity_velocity: liquidityVelocity,
    liquidity_absolute: liquidityAbsolute,
    volume_1m: volume1m,
    volume_5m: volume5m,
    volume_acceleration_1m: volumeAcceleration1m,
    price_volatility: priceVolatility,
    market_cap: marketCap,
    buy_sell_slope: buySellSlope,
    velocity_score_1m: velocityScore1m,
    buy_pressure_1m: buyPressure1m,
    sell_pressure_1m: sellPressure1m,
    buy_volume_1m: buyVolume1m,
    sell_volume_1m: sellVolume1m,
    price_momentum: priceMomentum,
    holder_concentration_penalty: holderConcentrationPenalty,
    pair_age_seconds: pairAgeSeconds,
    usedFallback,
    unsupportedFeatures,
  };
}

// Stage 3: Feature normalization (0–NORMALIZE_CLAMP, clamp outliers)
function normalizeFeature(value: number | null): number {
  if (value == null || !Number.isFinite(value)) return 0;
  const clamped = Math.max(-NORMALIZE_CLAMP, Math.min(NORMALIZE_CLAMP, value));
  return (clamped + NORMALIZE_CLAMP) / (2 * NORMALIZE_CLAMP) * NORMALIZE_CLAMP;
}

/** Normalize liquidity_absolute (USD): log scale so 0->0, ~10k->100 */
function normalizeLiquidityAbsolute(value: number | null): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(NORMALIZE_CLAMP, Math.log10(1 + value) * 25);
}

/** Normalize volume (USD): log scale so 0->0, ~10k->100 */
function normalizeVolume(value: number | null): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(NORMALIZE_CLAMP, Math.log10(1 + value) * 25);
}

/** Normalize pair_age_seconds to 0–1: clamp(seconds/600, 0, 1); 0 = brand new, 1 = 10+ min */
function normalizePairAgeSeconds(value: number | null): number {
  if (value == null || !Number.isFinite(value) || value < 0) return 0;
  return Math.max(0, Math.min(1, value / 600));
}

/** Normalize market cap (USD): log scale so 0->0, ~10k->100 */
function normalizeMarketCap(value: number | null): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(NORMALIZE_CLAMP, Math.log10(1 + value) * 25);
}

// Unsupported features are excluded from missingCount and get 0 normalized value
function normalizeFeatures(
  raw: RawFeatures,
  unsupportedFeatures: string[]
): NormalizedFeatures & { missingCount: number } {
  let missingCount = 0;
  const isUnsupported = (key: string) => unsupportedFeatures.includes(key);

  for (const k of FEATURE_KEYS) {
    const supportKey = FEATURE_TO_SUPPORT_KEY[k];
    if (!isUnsupported(supportKey) && (raw[k] == null || !Number.isFinite(raw[k] as number))) {
      missingCount++;
    }
  }

  return {
    liquidity_velocity: isUnsupported('liquidity_velocity') ? 0 : normalizeFeature(raw.liquidity_velocity),
    liquidity_absolute: isUnsupported('liquidity_absolute') ? 0 : normalizeLiquidityAbsolute(raw.liquidity_absolute),
    volume_1m: isUnsupported('volume_1m') ? 0 : normalizeVolume(raw.volume_1m),
    volume_5m: isUnsupported('volume_5m') ? 0 : normalizeVolume(raw.volume_5m),
    volume_acceleration_1m: isUnsupported('volume_acceleration_1m') ? 0 : normalizeFeature(raw.volume_acceleration_1m),
    price_volatility: isUnsupported('price_volatility') ? 0 : normalizeFeature(raw.price_volatility),
    market_cap: isUnsupported('market_cap') ? 0 : normalizeMarketCap(raw.market_cap),
    buy_sell_slope: isUnsupported('buy_sell_slope') ? 0 : normalizeFeature(raw.buy_sell_slope),
    velocity_score_1m: isUnsupported('velocity_score_1m') ? 0 : normalizeFeature(raw.velocity_score_1m),
    buy_pressure_1m: isUnsupported('buy_pressure_1m') ? 0 : normalizeFeature(raw.buy_pressure_1m),
    sell_pressure_1m: isUnsupported('sell_pressure_1m') ? 0 : normalizeFeature(raw.sell_pressure_1m),
    buy_volume_1m: isUnsupported('buy_volume_1m') ? 0 : normalizeVolume(raw.buy_volume_1m),
    sell_volume_1m: isUnsupported('sell_volume_1m') ? 0 : normalizeVolume(raw.sell_volume_1m),
    price_momentum: isUnsupported('price_momentum') ? 0 : normalizeFeature(raw.price_momentum),
    holder_concentration_penalty: isUnsupported('holder_concentration_penalty')
      ? 0
      : normalizeFeature(raw.holder_concentration_penalty),
    pair_age_seconds: isUnsupported('pair_age_seconds') ? 0 : normalizePairAgeSeconds(raw.pair_age_seconds),
    missingCount,
  };
}

// Map NormalizedFeatures keys to FEATURE_SUPPORT keys for weightedScore
const NORM_TO_SUPPORT_KEY: Record<keyof NormalizedFeatures, string> = {
  liquidity_velocity: 'liquidity_velocity',
  liquidity_absolute: 'liquidity_absolute',
  volume_1m: 'volume_1m',
  volume_5m: 'volume_5m',
  volume_acceleration_1m: 'volume_acceleration_1m',
  buy_sell_slope: 'buy_sell_slope',
  velocity_score_1m: 'velocity_score_1m',
  buy_pressure_1m: 'buy_pressure_1m',
  sell_pressure_1m: 'sell_pressure_1m',
  buy_volume_1m: 'buy_volume_1m',
  sell_volume_1m: 'sell_volume_1m',
  price_momentum: 'price_momentum',
  price_volatility: 'price_volatility',
  holder_concentration_penalty: 'holder_concentration_penalty',
  market_cap: 'market_cap',
  pair_age_seconds: 'pair_age_seconds',
};

// Stage 4: Weighted scoring
// Unsupported features contribute 0 and are logged for diagnostics
function weightedScore(
  norm: NormalizedFeatures,
  policy: PolicyRow,
  marketMode: MarketMode
): {
  totalScore: number;
  scoreNormalized: number;
  contributions: Record<string, number>;
  penalties: Record<string, number>;
} {
  const weights = {
    liquidity_velocity: policy.weight_liquidity_velocity ?? 0,
    liquidity_absolute: policy.weight_liquidity_absolute ?? 0,
    volume_1m: policy.weight_volume_1m ?? 0,
    volume_5m: policy.weight_volume_5m ?? 0,
    volume_acceleration_1m: policy.weight_volume_acceleration_1m ?? 0,
    price_volatility: policy.weight_price_volatility_5m ?? 0,
    market_cap: policy.weight_market_cap ?? 0,
    buy_sell_slope: policy.weight_buy_sell_slope_1m ?? 0,
    velocity_score_1m: policy.weight_velocity_score_1m ?? 0,
    buy_pressure_1m: policy.weight_buy_pressure_1m ?? 0,
    sell_pressure_1m: policy.weight_sell_pressure_1m ?? 0,
    buy_volume_1m: policy.weight_buy_volume_1m ?? 0,
    sell_volume_1m: policy.weight_sell_volume_1m ?? 0,
    price_momentum: policy.weight_price_momentum_5m ?? 0,
    holder_concentration_penalty: policy.weight_holder_concentration_penalty ?? 0,
    pair_age_seconds: policy.weight_pair_age_seconds ?? 0,
  };

  const contributions: Record<string, number> = {};
  const penalties: Record<string, number> = {};

  let total = 0;
  const features: (keyof NormalizedFeatures)[] = [
    'liquidity_velocity',
    'liquidity_absolute',
    'volume_1m',
    'volume_5m',
    'volume_acceleration_1m',
    'price_volatility',
    'market_cap',
    'buy_sell_slope',
    'velocity_score_1m',
    'buy_pressure_1m',
    'sell_pressure_1m',
    'buy_volume_1m',
    'sell_volume_1m',
    'price_momentum',
    'holder_concentration_penalty',
    'pair_age_seconds',
  ];

  for (const k of features) {
    const supportKey = NORM_TO_SUPPORT_KEY[k];
    const supported = isFeatureSupported(supportKey, marketMode);
    const w = supported ? (weights[k as keyof typeof weights] ?? 0) : 0;
    const v = norm[k];
    const contrib = supported ? v * w : 0;
    contributions[k] = contrib;
    if (w < 0) penalties[k] = contrib;
    else total += contrib;
  }
  for (const k of Object.keys(penalties)) {
    total += penalties[k];
  }

  const scoreNormalized = Math.max(0, Math.min(NORMALIZE_SCORE_MAX, (total + NORMALIZE_CLAMP) / (2 * NORMALIZE_CLAMP) * NORMALIZE_SCORE_MAX));

  return {
    totalScore: total,
    scoreNormalized,
    contributions,
    penalties,
  };
}

function classifySignal(scoreNormalized: number, policy: PolicyRow): Signal {
  const minScore = policy.min_trade_score ?? 70;
  const priorityScore = policy.priority_trade_score ?? 85;

  if (scoreNormalized >= priorityScore) return 'PRIORITY_TRADE';
  if (scoreNormalized >= minScore) return 'TRADE_CANDIDATE';
  if (scoreNormalized >= minScore * 0.7) return 'WATCH';
  return 'NO_TRADE';
}

function confidenceLevel(missingCount: number, usedFallback: boolean): ConfidenceLevel {
  if (missingCount >= 3 || usedFallback) return 'LOW';
  if (missingCount >= 1) return 'MEDIUM';
  return 'HIGH';
}

function dataQualityScore(missingCount: number, usedFallback: boolean): number {
  let q = 1;
  q -= missingCount * 0.15;
  if (usedFallback) q -= 0.2;
  return Math.max(0, Math.min(1, q));
}

function scorePairsForPolicy(
  policy: PolicyRow,
  pairs: PairRow[],
  now: number,
  runId: string
): { scored: number; rejected: number } {
  const marketMode = resolveMarketMode(policy);
  const unsupportedForMode = getUnsupportedFeatures(marketMode);
  const allowedDexes = (policy.allowed_dexes ?? 'raydium,orca')
    .toLowerCase()
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  const pairsForPolicy = allowedDexes.length
    ? pairs.filter((p) => {
        const dex = (p.dex ?? '').toString().toLowerCase().trim();
        return dex && allowedDexes.includes(dex);
      })
    : pairs;
  let scored = 0;
  let rejected = 0;

  for (const pair of pairsForPolicy) {
    const snapshots = getSnapshotsForPair.all({
      pairAddress: pair.pair_address,
      timestamp: now,
      limit: MAX_SNAPSHOTS_FOR_FEATURES,
    }) as SnapshotRow[];

    const latestSnapshot = snapshots[0] ?? null;

    const result = eligibilityFilter(
      pair,
      latestSnapshot,
      policy,
      marketMode
    );
    const { eligible, rejectReason, rejectStage } = result;

    if (!eligible) {
      if (result.entryFilterSubReason != null) {
        insertEntryFilterRejection.run({
          policyVersion: policy.policy_version,
          pairAddress: pair.pair_address,
          tokenMint: pair.base_token_address ?? null,
          subReason: result.entryFilterSubReason,
          observedValue: result.observedValue ?? null,
          thresholdValue: result.thresholdValue ?? null,
          decidedAt: now,
        });
      }
      insertPairScore.run({
        pairAddress: pair.pair_address,
        chain: CHAIN,
        scoredAt: now,
        policyVersion: policy.policy_version,
        marketMode,
        eligible: 0,
        rejectReason,
        rejectStage,
        totalScore: null,
        scoreNormalized: null,
        signal: 'NO_TRADE',
        confidenceLevel: 'LOW',
        featureValues: null,
        featureWeights: null,
        featureContributions: null,
        penaltyContributions: null,
        snapshotIds: JSON.stringify(snapshots.map((s) => s.snapshot_id)),
        snapshotWindowSeconds: SNAPSHOT_WINDOW_SECONDS,
        missingFeatureCount: 5,
        missingFeatures: null,
        usedFallbackValues: 1,
        dataQualityScore: 0,
        workerVersion: WORKER_VERSION,
        runId,
        notes: `rejected: ${rejectReason}`,
      });
      rejected++;
      continue;
    }

    const { usedFallback, unsupportedFeatures, ...rawFeatures } = extractFeatures(
      snapshots,
      marketMode
    );
    const { missingCount, ...normFeatures } = normalizeFeatures(
      rawFeatures,
      unsupportedFeatures
    );
    const { totalScore, scoreNormalized, contributions, penalties } = weightedScore(
      normFeatures,
      policy,
      marketMode
    );

    const signal = classifySignal(scoreNormalized, policy);
    const conf = confidenceLevel(missingCount, usedFallback);
    const dq = dataQualityScore(missingCount, usedFallback);

    const missingNames = getMissingFeatureNames(rawFeatures, unsupportedFeatures);

    const scoreNotes =
      unsupportedFeatures.length > 0
        ? JSON.stringify({ market_mode: marketMode, unsupported_features: unsupportedFeatures })
        : null;

    insertPairScore.run({
      pairAddress: pair.pair_address,
      chain: CHAIN,
      scoredAt: now,
      policyVersion: policy.policy_version,
      marketMode,
      eligible: 1,
      rejectReason: null,
      rejectStage: null,
      totalScore,
      scoreNormalized,
      signal,
      confidenceLevel: conf,
      featureValues: JSON.stringify(rawFeatures),
      featureWeights: JSON.stringify({
        liquidity_velocity: policy.weight_liquidity_velocity ?? 0,
        liquidity_absolute: policy.weight_liquidity_absolute ?? 0,
        volume_1m: policy.weight_volume_1m ?? 0,
        volume_5m: policy.weight_volume_5m ?? 0,
        volume_acceleration_1m: policy.weight_volume_acceleration_1m ?? 0,
        price_volatility: policy.weight_price_volatility_5m ?? 0,
        market_cap: policy.weight_market_cap ?? 0,
        buy_sell_slope: policy.weight_buy_sell_slope_1m ?? 0,
        velocity_score_1m: policy.weight_velocity_score_1m ?? 0,
        buy_pressure_1m: policy.weight_buy_pressure_1m ?? 0,
        sell_pressure_1m: policy.weight_sell_pressure_1m ?? 0,
        buy_volume_1m: policy.weight_buy_volume_1m ?? 0,
        sell_volume_1m: policy.weight_sell_volume_1m ?? 0,
        price_momentum: policy.weight_price_momentum_5m ?? 0,
        holder_concentration_penalty: policy.weight_holder_concentration_penalty ?? 0,
        pair_age_seconds: policy.weight_pair_age_seconds ?? 0,
      }),
      featureContributions: JSON.stringify(contributions),
      penaltyContributions: JSON.stringify(penalties),
      snapshotIds: JSON.stringify(snapshots.map((s) => s.snapshot_id)),
      snapshotWindowSeconds: SNAPSHOT_WINDOW_SECONDS,
      missingFeatureCount: missingCount,
      missingFeatures: missingNames.length > 0 ? JSON.stringify(missingNames) : null,
      usedFallbackValues: usedFallback ? 1 : 0,
      dataQualityScore: dq,
      workerVersion: WORKER_VERSION,
      runId,
      notes: scoreNotes,
    });
    scored++;
  }
  return { scored, rejected };
}

/**
 * Score a single pair immediately (e.g. after ingest snapshot). Uses the same pipeline as
 * the normal scoring loop: FULL scores, policy config, entry filters. Does NOT create
 * trade decisions; the Decision Worker does that.
 */
export async function scorePairNow(
  pairAddress: string,
  options?: { token_mint?: string; snapshot_timestamp?: number }
): Promise<void> {
  const pairRow = getPairByAddress.get({ pairAddress }) as PairRow | undefined;
  if (!pairRow) return;

  const pairDex = (pairRow.dex ?? '').toString().toLowerCase().trim();
  if (pairDex === 'pumpswap' && !isPairEligibleForChainSnapshots(pairAddress)) {
    return;
  }

  const activePolicies = getAllActivePolicies.all() as PolicyRow[];
  if (activePolicies.length === 0) return;

  const now = Math.floor(Date.now() / 1000);
  const runId = randomUUID();

  const allowedDexesByPolicy = new Map(
    activePolicies.map((p) => {
      const dexes = (p.allowed_dexes ?? 'raydium,orca')
        .toLowerCase()
        .split(',')
        .map((d) => d.trim())
        .filter(Boolean);
      return [p.policy_version, dexes];
    })
  );

  for (const policy of activePolicies) {
    const allowedDexes = allowedDexesByPolicy.get(policy.policy_version) ?? [];
    if (allowedDexes.length > 0) {
      const dex = (pairRow.dex ?? '').toString().toLowerCase().trim();
      if (!dex || !allowedDexes.includes(dex)) continue;
    }
    scorePairsForPolicy(policy, [pairRow], now, runId);
  }

  if (options?.snapshot_timestamp != null) {
    console.log(
      JSON.stringify({
        event: 'INGEST_SNAPSHOT_SCORED',
        pair_address: pairAddress,
        token_mint: options.token_mint ?? pairRow.base_token_address ?? null,
        snapshot_timestamp: options.snapshot_timestamp,
      })
    );
  }
}

async function runCycle(runId: string): Promise<void> {
  const activePolicies = getAllActivePolicies.all() as PolicyRow[];
  if (activePolicies.length === 0) {
    console.log('[scoring-worker] No active policies, skipping');
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - 900; // pairs with snapshots in last 15 min
  const pairs = getPairsWithRecentSnapshots.all({
    cutoff,
    dex: 'pumpswap',
    nowSeconds: now,
    maxAgeUnbound: MAX_PAIR_AGE_UNBOUNDED_SEC,
  }) as PairRow[];

  if (pairs.length > 0) {
    const pairList =
      pairs.length <= 10
        ? pairs.map((p) => p.pair_address.slice(0, 8) + '…').join(', ')
        : pairs
            .slice(0, 10)
            .map((p) => p.pair_address.slice(0, 8) + '…')
            .join(', ') + ` (+${pairs.length - 10} more)`;
    console.log(
      `[scoring-worker] Processing ${pairs.length} pair(s): ${pairList}`
    );
  }

  for (const policy of activePolicies) {
    const marketMode = resolveMarketMode(policy);
    const unsupportedForMode = getUnsupportedFeatures(marketMode);
    console.log(
      `[scoring-worker] Using policy ${policy.policy_version} (id: ${policy.policy_id}) market_mode=${marketMode} unsupported_features=[${unsupportedForMode.join(', ')}]`
    );
    const { scored, rejected } = scorePairsForPolicy(policy, pairs, now, runId);
    if (scored > 0 || rejected > 0) {
      console.log(
        `[scoring-worker] policy=${policy.policy_version} scored=${scored} rejected=${rejected} run=${runId.slice(0, 8)}`
      );
    }
  }
}

export async function startScoringWorker(): Promise<void> {
  console.log('[scoring-worker] Starting, polling every 30s');
  await runCycle(randomUUID());
  setInterval(async () => {
    await runCycle(randomUUID());
  }, POLL_INTERVAL_MS);
}

const isMain =
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1]?.endsWith('scoring-worker.js');

if (isMain) {
  startScoringWorker().catch((err) => {
    console.error('[scoring-worker] Fatal:', err);
    process.exit(1);
  });
}
