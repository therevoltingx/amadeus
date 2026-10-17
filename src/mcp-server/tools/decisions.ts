import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../../db.js';
import { getSolanaPublicKeyString } from '../../solana-signer.js';
import { z, defaultNum, intPositive } from '../schema.js';
import { forceExitDecision } from '../../workers/exit-worker.js';

export function registerDecisionsTools(server: McpServer): void {
  server.registerTool(
    'list_trade_decisions',
    {
      description: 'List trade decisions (paper entries and their exit status). Optional pair_address filters to that pair.',
      inputSchema: z.object({
        limit: defaultNum(100, { min: 1, max: 500 }),
        offset: defaultNum(0, { min: 0 }),
        open_only: z.optional(z.boolean()),
        pair_address: z.optional(z.string()),
      }),
    },
    async ({ limit, offset, open_only, pair_address }) => {
      const baseSelect = `SELECT td.trade_id, td.pair_address, td.token_mint, td.entry_dex, td.policy_version, td.market_mode, td.signal, td.entry_price, td.position_size_usd, td.executed_at, td.reason, td.execution_mode, td.entry_snapshot_id, td.exit_recorded_at,
      td.consecutive_volume_collapse_count, td.last_volume_ratio, td.risk_pct_at_entry, td.score_size_multiplier,
      td.sol_price_at_entry,
      td.tx_signature, td.execution_status, td.execution_error, td.actual_entry_price, td.actual_position_size_usd, td.slippage_bps_realized, td.execution_latency_ms,
      td.account_id,
      p.base_symbol, p.quote_symbol,
      a.address AS account_address,
      ps_entry.market_cap AS entry_market_cap
      FROM trade_decisions td
      LEFT JOIN pairs p ON p.pair_address = td.pair_address
      LEFT JOIN accounts a ON a.account_id = td.account_id
      LEFT JOIN pair_snapshots ps_entry ON ps_entry.snapshot_id = td.entry_snapshot_id`;
      const where: string[] = [];
      const params: Record<string, string | number> = { limit, offset };
      if (open_only === true) where.push('td.exit_recorded_at IS NULL');
      if (pair_address != null && pair_address.trim().length > 0) {
        where.push('td.pair_address = $pairAddress');
        params.pairAddress = pair_address.trim();
      }
      const whereClause = where.length > 0 ? ' WHERE ' + where.join(' AND ') : '';
      const sql = `${baseSelect}${whereClause} ORDER BY td.executed_at DESC LIMIT $limit OFFSET $offset`;
      const rows = db.prepare(sql).all(params) as Record<string, unknown>[];
      const solanaPublicKey = getSolanaPublicKeyString() ?? null;
      const decisions = rows.map((row) => {
        if (row.account_id === 'solana-wallet' && solanaPublicKey) {
          return { ...row, account_address: solanaPublicKey };
        }
        return row;
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(decisions, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    'force_exit_trade',
    {
      description:
        'Immediately exit an open trade: sells tokens on-chain (for live trades) and records the trade. Use for manual exits from the decisions page.',
      inputSchema: z.object({
        trade_id: intPositive(),
      }),
    },
    async ({ trade_id }) => {
      try {
        const result = await forceExitDecision(trade_id);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }],
        };
      }
    }
  );
}
