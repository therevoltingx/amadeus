/**
 * Liquidity-based halt gate. Use this wherever halt_on_liquidity_drop_pct
 * or any liquidity-derived halt condition is evaluated (execution worker,
 * risk manager, etc.). Liquidity halts are AMM-only; bonding_curve and
 * other non-AMM modes must skip liquidity halts entirely. Missing/null/0
 * liquidity must never trigger halts.
 */
import {
  resolveMarketMode,
  isLiquidityHaltApplicable,
  type MarketMode,
} from './market-mode.js';

export type { MarketMode };
export { isLiquidityHaltApplicable, resolveMarketMode };

/**
 * Returns true only when liquidity-based halts apply (AMM). Call before
 * evaluating halt_on_liquidity_drop_pct or any liquidity-derived halt.
 * When false, skip liquidity halt logic entirely.
 */
export function shouldApplyLiquidityHalt(policy: {
  allowed_dexes: string | null;
}): boolean {
  const mode = resolveMarketMode(policy);
  return isLiquidityHaltApplicable(mode);
}
