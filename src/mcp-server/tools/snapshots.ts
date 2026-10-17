import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../../db.js';
import { getEligibleForSnapshotCount } from '../../workers/chain-snapshots-worker.js';
import { z, defaultNum, arrayNum } from '../schema.js';

export function registerSnapshotsTools(server: McpServer): void {
  server.registerTool(
    'list_snapshots',
    {
      description: 'List recent pair snapshots from the database',
      inputSchema: z.object({
        limit: defaultNum(100, { min: 1, max: 500 }),
        offset: defaultNum(0, { min: 0 }),
        dex: z.optional(z.string()),
        pair_address: z.optional(z.string()),
      }),
    },
    async ({ limit, offset, dex, pair_address }) => {
      let sql = `SELECT s.*,
      COALESCE(p.chain, 'solana') AS chain, COALESCE(p.dex, '') AS dex,
      p.base_symbol, p.quote_symbol, COALESCE(p.tracking_tier, 'ultra_early') AS tracking_tier
      FROM pair_snapshots s
      LEFT JOIN pairs p ON s.pair_address = p.pair_address`;

      const params: Record<string, string | number> = { limit, offset };
      const where: string[] = [];

      if (dex != null && dex.trim().length > 0) {
        where.push(`COALESCE(p.dex, '') = $dex`);
        params.dex = dex.trim();
      }

      if (pair_address != null && pair_address.trim().length > 0) {
        const p = pair_address.trim();
        params.pairAddressPattern = p.includes('%') ? p : p + '%';
        where.push('s.pair_address LIKE $pairAddressPattern');
      }

      if (where.length > 0) sql += ' WHERE ' + where.join(' AND ');
      sql += ' ORDER BY s.timestamp DESC LIMIT $limit OFFSET $offset';

      const snapshots = db.prepare(sql).all(params);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(snapshots, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    'get_snapshots_by_ids',
    {
      description: 'Get snapshots by snapshot IDs from the database',
      inputSchema: z.object({
        snapshot_ids: arrayNum(1, 50),
      }),
    },
    async ({ snapshot_ids }) => {
      const inClause = snapshot_ids.map((_, i) => `$id${i}`).join(',');
      const params = Object.fromEntries(snapshot_ids.map((id, i) => [`id${i}`, id]));
      const snapshots = db
        .prepare(
          `SELECT s.*,
         COALESCE(p.chain, 'solana') AS chain, COALESCE(p.dex, '') AS dex,
         p.base_symbol, p.quote_symbol, COALESCE(p.tracking_tier, 'ultra_early') AS tracking_tier
         FROM pair_snapshots s
         LEFT JOIN pairs p ON s.pair_address = p.pair_address
         WHERE s.snapshot_id IN (${inClause})
         ORDER BY s.timestamp DESC`
        )
        .all(params);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(snapshots, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    'get_eligible_for_snapshot_count',
    {
      description:
        'Count of pairs eligible for snapshots (pumpswap only; same rules as chain-snapshots and vault-swap workers: tier/open trade, age vs active policies, and unless there is an open trade — LP must be locked in the latest snapshot unless some covering active policy has require_lp_lock off; no snapshot yet counts as eligible once to bootstrap lp_locked).',
      inputSchema: z.object({}),
    },
    async () => {
      const count = getEligibleForSnapshotCount();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ count }),
          },
        ],
      };
    }
  );
}
