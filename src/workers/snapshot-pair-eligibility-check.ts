/**
 * Single-pair check matching chain snapshot schedule (no vault requirement).
 * Used by scoring-worker to avoid circular import with chain-snapshots-worker.
 */
import { db } from '../db.js';
import { SNAPSHOT_PAIR_ELIGIBILITY_CONDS, MAX_PAIR_AGE_UNBOUNDED_SEC } from './snapshot-pair-eligibility-sql.js';

const DEX_PUMPSWAP = 'pumpswap';

const selectPumpswapPairEligibleForSnapshots = db.prepare(`
  SELECT 1 AS one
  FROM pairs p
  WHERE p.pair_address = $pairAddress
    AND p.dex = $dex
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

/** Same eligibility as `selectPumpswapEligiblePairs` for one address (PumpSwap only). */
export function isPairEligibleForChainSnapshots(pairAddress: string): boolean {
  const row = selectPumpswapPairEligibleForSnapshots.get({
    pairAddress: String(pairAddress).trim(),
    ...eligibleSnapshotParams(),
  }) as { one: number } | undefined;
  return row?.one === 1;
}
