/** Policies with NULL max_pair_age_seconds use this upper bound in eligibility SQL (seconds). */
export const MAX_PAIR_AGE_UNBOUNDED_SEC = 999999999;

/**
 * Shared SQL conditions for pairs eligible for chain snapshots and PumpSwap vault swap tracking.
 *
 * Rules (tier + open trade unchanged):
 * - If the pair has an open trade → always eligible (need snapshots for exit pricing).
 * - Else pair must be within at least one active policy's max_pair_age (pumpswap allowed).
 * - LP lock: if the latest snapshot shows LP not locked (`lp_locked != 1`), still eligible only when
 *   some **same** covering policy has `require_lp_lock = 0`. If no snapshot exists yet, eligible once
 *   to bootstrap `lp_locked` from chain.
 *
 * Used by: chain-snapshots-worker, getEligibleForSnapshotCount, pumpswap-vault-swap worker, scoring-worker
 * (via `snapshot-pair-eligibility-check` / embedded OR branch for PumpSwap).
 */
export const SNAPSHOT_PAIR_ELIGIBILITY_CONDS = `
    AND (
      COALESCE(p.tracking_tier, 'ultra_early') IN ('ultra_early', 'active')
      OR EXISTS (SELECT 1 FROM trade_decisions td WHERE td.pair_address = p.pair_address AND td.exit_recorded_at IS NULL)
    )
    AND (
      EXISTS (SELECT 1 FROM trade_decisions td WHERE td.pair_address = p.pair_address AND td.exit_recorded_at IS NULL)
      OR (
        p.pair_created_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM policies pol
          WHERE pol.status = 'active'
            AND (pol.allowed_dexes IS NULL OR pol.allowed_dexes LIKE '%pumpswap%')
            AND ($nowSeconds - p.pair_created_at) <= COALESCE(pol.max_pair_age_seconds, $maxAgeUnbound)
        )
        AND (
          EXISTS (
            SELECT 1 FROM policies pol2
            WHERE pol2.status = 'active'
              AND (pol2.allowed_dexes IS NULL OR pol2.allowed_dexes LIKE '%pumpswap%')
              AND ($nowSeconds - p.pair_created_at) <= COALESCE(pol2.max_pair_age_seconds, $maxAgeUnbound)
              AND COALESCE(pol2.require_lp_lock, 0) = 0
          )
          OR NOT EXISTS (SELECT 1 FROM pair_snapshots ps0 WHERE ps0.pair_address = p.pair_address)
          OR COALESCE((
            SELECT ps.lp_locked FROM pair_snapshots ps
            WHERE ps.pair_address = p.pair_address
            ORDER BY ps.timestamp DESC LIMIT 1
          ), 0) = 1
        )
      )
    )
`;
