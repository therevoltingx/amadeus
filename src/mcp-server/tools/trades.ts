import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../../db.js';
import { getSolanaPublicKeyString } from '../../solana-signer.js';
import { z, defaultNum } from '../schema.js';

export function registerTradesTools(server: McpServer): void {
  server.registerTool(
    'list_trades',
    {
      description:
        'List trades from the database. Optional filters: pair_address, policy_version, dex (entry_dex), execution_mode (paper | live).',
      inputSchema: z.object({
        limit: defaultNum(100, { min: 1, max: 500 }),
        offset: defaultNum(0, { min: 0 }),
        pair_address: z.optional(z.string()),
        policy_version: z.optional(z.string()),
        dex: z.optional(z.string()),
        execution_mode: z.optional(z.enum(['paper', 'live'])),
      }),
    },
    async ({ limit, offset, pair_address, policy_version, dex, execution_mode }) => {
      let sql = `SELECT t.trade_id, t.pair_address, t.policy_version, t.entry_dex, t.execution_mode, t.account_id,
         t.entry_snapshot_id, t.entry_score_id, t.exit_snapshot_id,
         t.entry_time, t.exit_time, t.entry_price, t.exit_price, t.position_size_usd,
         t.actual_usd_bought, t.actual_usd_sold, t.sol_received, t.sol_price_used, t.sol_price_at_entry,
         t.actual_exit_price,
         t.slippage_assumed_pct, t.exit_reason, t.pnl_pct, t.max_drawdown_pct, t.ai_score_at_entry,
         t.tx_signature, t.execution_status, t.actual_entry_price, t.slippage_bps_realized, t.execution_latency_ms,
         t.entry_slippage_bps_used, t.exit_slippage_bps_used,
         t.tokens_received, t.tokens_sold,
         t.fee_lamports,
         t.exit_tx_signature,
         p.base_symbol, p.quote_symbol,
         a.address AS account_address,
         ps_entry.market_cap AS entry_market_cap,
         ps_exit.market_cap AS exit_market_cap
         FROM trades t
         LEFT JOIN pairs p ON p.pair_address = t.pair_address
         LEFT JOIN accounts a ON a.account_id = t.account_id
         LEFT JOIN pair_snapshots ps_entry ON ps_entry.snapshot_id = t.entry_snapshot_id
         LEFT JOIN pair_snapshots ps_exit ON ps_exit.snapshot_id = t.exit_snapshot_id`;
      const where: string[] = [];
      const params: Record<string, string | number> = { limit, offset };
      if (pair_address != null && pair_address.trim().length > 0) {
        where.push('t.pair_address = $pairAddress');
        params.pairAddress = pair_address.trim();
      }
      if (policy_version != null && policy_version.trim().length > 0) {
        where.push('t.policy_version = $policyVersion');
        params.policyVersion = policy_version.trim();
      }
      if (dex != null && dex.trim().length > 0) {
        where.push("COALESCE(TRIM(LOWER(t.entry_dex)), '') = $dex");
        params.dex = dex.trim().toLowerCase();
      }
      if (execution_mode != null && (execution_mode === 'paper' || execution_mode === 'live')) {
        where.push("COALESCE(TRIM(LOWER(t.execution_mode)), '') = $executionMode");
        params.executionMode = execution_mode.toLowerCase();
      }
      if (where.length > 0) sql += ' WHERE ' + where.join(' AND ');
      sql += ' ORDER BY t.entry_time DESC LIMIT $limit OFFSET $offset';
      const rows = db.prepare(sql).all(params) as Record<string, unknown>[];
      const solanaPublicKey = getSolanaPublicKeyString() ?? null;
      const trades = rows.map((row) => {
        if (row.account_id === 'solana-wallet' && solanaPublicKey) {
          return { ...row, account_address: solanaPublicKey };
        }
        return row;
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(trades, null, 2),
          },
        ],
      };
    }
  );
}
