import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../../db.js';
import { z, defaultNum } from '../schema.js';
import {
  SNAPSHOT_PAIR_ELIGIBILITY_CONDS,
  MAX_PAIR_AGE_UNBOUNDED_SEC,
} from '../../workers/snapshot-pair-eligibility-sql.js';

export function registerPairsTools(server: McpServer): void {
  server.registerTool(
    'list_pairs',
    {
      description:
        'List trading pairs from the database. Returns id (pairs.id serial PK), pair_address, chain, dex, base/quote token addresses and symbols, pair_created_at, creator_wallet, first_seen_at, and tracking_tier (ultra_early | active | dormant). Optional pair_address filters by exact or prefix match. Optional dex filters by DEX (e.g. raydium, orca, pumpswap, pumpfun). Optional sort_by: "first_seen" (default) or "age"; order: "asc" or "desc" (for age: desc = newest first, asc = oldest first). Optional eligible_for_snapshots: if true, only pairs that match the same PumpSwap snapshot/vault/scoring eligibility rules (tier, age vs active policies, LP lock vs require_lp_lock, open trades).',
      inputSchema: z.object({
        limit: defaultNum(100, { min: 1, max: 500 }),
        offset: defaultNum(0, { min: 0 }),
        pair_address: z.optional(z.string()),
        dex: z.optional(z.string()),
        tracking_tier: z.optional(z.enum(['ultra_early', 'active', 'dormant'])),
        sort_by: z.optional(z.enum(['first_seen', 'age'])),
        order: z.optional(z.enum(['asc', 'desc'])),
        eligible_for_snapshots: z.optional(z.boolean()),
      }),
    },
    async ({
      limit,
      offset,
      pair_address,
      dex,
      tracking_tier,
      sort_by,
      order,
      eligible_for_snapshots,
    }) => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const params: Record<string, string | number> = {
        limit,
        offset,
      };

      let sql = `SELECT id, pair_address, chain, dex, base_token_address, quote_token_address,
         base_symbol, quote_symbol, pair_created_at, creator_wallet, first_seen_at,
         COALESCE(tracking_tier, 'ultra_early') AS tracking_tier,
         method,
         source
         FROM pairs`;

      const where: string[] = [];

      if (pair_address != null && pair_address.trim().length > 0) {
        const p = pair_address.trim();
        where.push(`pair_address LIKE $pairAddressPattern`);
        params.pairAddressPattern = p.includes('%') ? p : `${p}%`;
      }
      if (dex != null && dex.trim().length > 0) {
        where.push(`COALESCE(TRIM(LOWER(dex)), '') = $dexLower`);
        params.dexLower = dex.trim().toLowerCase();
      }
      if (tracking_tier != null && tracking_tier.length > 0) {
        where.push(`COALESCE(tracking_tier, 'ultra_early') = $trackingTier`);
        params.trackingTier = tracking_tier;
      }
      if (eligible_for_snapshots === true) {
        where.push(`EXISTS (
      SELECT 1 FROM pairs p
      WHERE p.pair_address = pairs.pair_address
        AND p.dex = $pumpswapDex
      ${SNAPSHOT_PAIR_ELIGIBILITY_CONDS}
    )`);
        params.pumpswapDex = 'pumpswap';
        params.nowSeconds = nowSeconds;
        params.maxAgeUnbound = MAX_PAIR_AGE_UNBOUNDED_SEC;
      }

      if (where.length > 0) sql += ` WHERE ` + where.join(' AND ');
      const byAge = sort_by === 'age';
      const dir = order === 'asc' ? 'ASC' : 'DESC';
      const orderClause = byAge
        ? ` ORDER BY COALESCE(pair_created_at, first_seen_at) ${dir}`
        : ` ORDER BY first_seen_at ${dir}`;
      sql += orderClause + ` LIMIT $limit OFFSET $offset`;

      const pairs = db.prepare(sql).all(params);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(pairs, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    'get_token_symbols',
    {
      description:
        'Resolve token mint addresses to symbols (from pairs table). Returns { [mint]: symbol }. Optional mints array; if omitted returns all known mint->symbol.',
      inputSchema: z.object({
        mints: z.optional(z.array(z.string())),
      }),
    },
    async (input) => {
      const rows = input.mints?.length
        ? (() => {
            const mints = input.mints;
            const placeholders = mints.map((_, i) => `$m${i}`).join(', ');
            const params: Record<string, string> = {};
            mints.forEach((m, i) => {
              params[`m${i}`] = m;
            });
            return db
              .prepare(
                `SELECT base_token_address AS mint, base_symbol AS symbol FROM pairs WHERE base_token_address IN (${placeholders}) GROUP BY base_token_address`
              )
              .all(params) as { mint: string; symbol: string }[];
          })()
        : (db
            .prepare(
              `SELECT base_token_address AS mint, base_symbol AS symbol FROM pairs GROUP BY base_token_address`
            )
            .all() as { mint: string; symbol: string }[]);
      const out: Record<string, string> = {};
      for (const r of rows) {
        out[r.mint] = r.symbol ?? r.mint;
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
    }
  );
}
