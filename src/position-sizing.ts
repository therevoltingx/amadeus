/**
 * Shared position sizing: risk-based size, score multiplier, clamps.
 * Used by execution worker and backtest engine. Deterministic.
 */

export const MIN_POSITION_SIZE_USD = 1;
export const MAX_POSITION_FRACTION = 1.0; // position_size_usd <= account_equity * this

export const SCORE_SIZE_MULTIPLIER_MIN = 0.7;
export const SCORE_SIZE_MULTIPLIER_MAX = 1.3;

export interface ComputeRiskBasedInput {
  account_equity: number;
  risk_per_trade_pct: number | null;
  stop_loss_pct: number | null;
}

export interface ComputeRiskBasedResult {
  position_size_usd: number;
  stop_distance_pct: number | null;
}

/**
 * Risk-based position size: risk_capital / stop_distance.
 * Policies must have valid stop_loss_pct; if missing or invalid, returns 0.
 */
export function computeRiskBasedPositionSize(input: ComputeRiskBasedInput): ComputeRiskBasedResult {
  const { account_equity, risk_per_trade_pct, stop_loss_pct } = input;

  if (
    stop_loss_pct == null ||
    stop_loss_pct === 0 ||
    !Number.isFinite(stop_loss_pct) ||
    !Number.isFinite(account_equity)
  ) {
    return { position_size_usd: 0, stop_distance_pct: null };
  }

  const pct = risk_per_trade_pct ?? 5;
  if (!Number.isFinite(pct)) {
    return { position_size_usd: 0, stop_distance_pct: null };
  }

  const risk_capital = account_equity * (pct / 100);
  const stop_distance = Math.abs(stop_loss_pct) / 100;
  if (stop_distance <= 0 || !Number.isFinite(stop_distance)) {
    return { position_size_usd: 0, stop_distance_pct: null };
  }

  let position_size_usd = risk_capital / stop_distance;
  if (!Number.isFinite(position_size_usd)) {
    return { position_size_usd: 0, stop_distance_pct: null };
  }

  return {
    position_size_usd,
    stop_distance_pct: stop_distance * 100,
  };
}

export interface ComputeScoreMultiplierInput {
  score: number | null;
  min_trade_score: number | null;
  priority_trade_score: number | null;
}

/**
 * Score-weighted multiplier in [SCORE_SIZE_MULTIPLIER_MIN, SCORE_SIZE_MULTIPLIER_MAX].
 * Linear interpolation between min and priority score.
 */
export function computeScoreMultiplier(input: ComputeScoreMultiplierInput): number {
  const { score, min_trade_score, priority_trade_score } = input;
  const minScore = min_trade_score ?? 70;
  const priorityScore = priority_trade_score ?? 85;
  const s = score != null && Number.isFinite(score) ? score : minScore;

  const span = priorityScore - minScore;
  if (span <= 0) return SCORE_SIZE_MULTIPLIER_MIN;

  let score_ratio = (s - minScore) / span;
  score_ratio = Math.max(0, Math.min(1, score_ratio));

  const multiplier =
    SCORE_SIZE_MULTIPLIER_MIN +
    score_ratio * (SCORE_SIZE_MULTIPLIER_MAX - SCORE_SIZE_MULTIPLIER_MIN);
  return Number.isFinite(multiplier) ? multiplier : SCORE_SIZE_MULTIPLIER_MIN;
}

/**
 * Clamp position size to global min and max fraction of equity.
 */
export function clampPositionSize(position_size_usd: number, account_equity: number): number {
  if (!Number.isFinite(position_size_usd) || !Number.isFinite(account_equity)) return 0;
  const min = MIN_POSITION_SIZE_USD;
  const max = account_equity * MAX_POSITION_FRACTION;
  return Math.max(min, Math.min(position_size_usd, max));
}

/**
 * Full pipeline: risk-based size → score multiplier → clamp.
 * Returns final position_size_usd and diagnostics for logging/trades table.
 */
export function computePositionSizeUsd(params: {
  account_equity: number;
  risk_per_trade_pct: number | null;
  stop_loss_pct: number | null;
  score: number | null;
  min_trade_score: number | null;
  priority_trade_score: number | null;
}): {
  position_size_usd: number;
  score_size_multiplier: number;
  risk_pct_at_entry: number | null;
} {
  const base = computeRiskBasedPositionSize({
    account_equity: params.account_equity,
    risk_per_trade_pct: params.risk_per_trade_pct,
    stop_loss_pct: params.stop_loss_pct,
  });

  let position_size_usd = base.position_size_usd;
  const multiplier = computeScoreMultiplier({
    score: params.score,
    min_trade_score: params.min_trade_score,
    priority_trade_score: params.priority_trade_score,
  });
  position_size_usd *= multiplier;
  position_size_usd = clampPositionSize(position_size_usd, params.account_equity);

  // Risk % at entry = policy risk used for sizing (e.g. 1%), not stop distance (e.g. 20%).
  // Portfolio heat uses this; it must match the dollar risk: position_size * stop_pct = equity * (risk_pct/100).
  const riskPctUsed = params.risk_per_trade_pct ?? 5;
  const risk_pct_at_entry =
    Number.isFinite(riskPctUsed) && base.position_size_usd > 0 ? riskPctUsed : null;

  return {
    position_size_usd,
    score_size_multiplier: multiplier,
    risk_pct_at_entry,
  };
}
