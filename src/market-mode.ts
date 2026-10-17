/**
 * Market mode: derived at runtime from policy.allowed_dexes.
 * Determines which features are supported; unsupported features are set to null
 * and do not affect scoring or trigger halts.
 */
export type MarketMode = 'amm' | 'bonding_curve' | 'hybrid' | 'orderbook';

/**
 * Resolves market mode from policy. Extensible for future launchpads.
 * - Only pumpfun → bonding_curve (no AMM liquidity)
 * - Else → amm (standard DEX)
 */
export function resolveMarketMode(policy: {
  allowed_dexes: string | null;
}): MarketMode {
  const dexes = (policy.allowed_dexes ?? '')
    .toLowerCase()
    .split(',')
    .map((d) => d.trim())
    .filter(Boolean);
  if (dexes.length === 1 && dexes[0] === 'pumpfun') return 'bonding_curve';
  return 'amm';
}

/**
 * Feature support matrix: which features are supported by which market modes.
 * Features not listed are assumed supported everywhere.
 * Used by scoring worker to null unsupported features and skip eligibility/halts.
 */
export const FEATURE_SUPPORT: Record<string, MarketMode[]> = {
  liquidity_usd: ['amm'],
  liquidity_velocity: ['amm'],
  liquidity_absolute: ['amm'],
  volume_1m: ['amm'],
  volume_5m: ['amm', 'bonding_curve'],
  volume_acceleration_1m: ['amm', 'bonding_curve'],
  buy_sell_slope: ['amm', 'bonding_curve'],
  velocity_score_1m: ['amm', 'bonding_curve'],
  buy_pressure_1m: ['amm', 'bonding_curve'],
  sell_pressure_1m: ['amm', 'bonding_curve'],
  buy_volume_1m: ['amm', 'bonding_curve'],
  sell_volume_1m: ['amm', 'bonding_curve'],
  price_momentum: ['amm', 'bonding_curve'],
  /** 1m price change % from snapshot (pair_snapshots.price_change_1m). */
  price_change_1m: ['amm', 'bonding_curve'],
  price_volatility: ['amm', 'bonding_curve'],
  holder_concentration_penalty: ['amm', 'bonding_curve'],
  market_cap: ['amm', 'bonding_curve'],
  lp_lock: ['amm'],
  pair_age_seconds: ['amm', 'bonding_curve'],
};

export function isFeatureSupported(
  feature: string,
  mode: MarketMode
): boolean {
  const modes = FEATURE_SUPPORT[feature];
  if (!modes) return true;
  return modes.includes(mode);
}

export function getUnsupportedFeatures(mode: MarketMode): string[] {
  return Object.keys(FEATURE_SUPPORT).filter(
    (f) => !isFeatureSupported(f, mode)
  );
}

/**
 * Single source of truth: liquidity-based halts apply only in AMM mode.
 * Any code evaluating halt_on_liquidity_drop_pct or liquidity-derived halt conditions
 * MUST gate with this first. When false: skip liquidity halts entirely (bonding_curve,
 * hybrid, orderbook, and future non-AMM modes). Missing/null/0 liquidity must never
 * trigger halts; liquidity halt logic must run only when this returns true and
 * liquidity values are present and valid.
 */
export function isLiquidityHaltApplicable(mode: MarketMode): boolean {
  return mode === 'amm';
}
