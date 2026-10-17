import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db, DEFAULT_PAPER_ACCOUNT_ID } from '../../db.js';
import { z, numOptionalNullable, intOptionalNullable } from '../schema.js';

async function getAccountTradingStatusHandler() {
  const account = db
    .prepare(
      `SELECT account_id, trading_enabled, current_equity, max_daily_drawdown_pct, max_total_open_trades
       FROM accounts WHERE account_id = $accountId AND mode = 'paper'`
    )
    .get({ accountId: DEFAULT_PAPER_ACCOUNT_ID });
  const acc = account as
    | {
        account_id: string;
        trading_enabled: number;
        current_equity: number;
        max_daily_drawdown_pct: number | null;
        max_total_open_trades: number | null;
      }
    | undefined;
  if (!acc) {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ can_trade: false, reason: 'No paper account.' }) }],
    };
  }
  if (acc.trading_enabled !== 1) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            can_trade: false,
            reason: 'Trading is disabled (global kill switch).',
          }),
        },
      ],
    };
  }

  const todayRealizedPnl = db
    .prepare(
      `SELECT COALESCE(SUM(position_size_usd * pnl_pct / 100.0), 0) AS realized_pnl_usd FROM trades
       WHERE to_timestamp(exit_time)::date = CURRENT_DATE AND pnl_pct IS NOT NULL`
    )
    .get() as { realized_pnl_usd: number };
  const realizedPnlUsd = todayRealizedPnl.realized_pnl_usd;
  const equityAtStartOfDay = acc!.current_equity - realizedPnlUsd;
  const dailyDrawdownPct =
    equityAtStartOfDay > 0 ? (realizedPnlUsd / equityAtStartOfDay) * 100 : 0;
  const maxDrawdown = acc!.max_daily_drawdown_pct ?? null;
  if (maxDrawdown !== null && (maxDrawdown as number) > 0) {
    const limitPct = maxDrawdown as number;
    if (dailyDrawdownPct <= -limitPct) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              can_trade: false,
              reason: 'Daily drawdown limit reached.',
              daily_drawdown_pct: Math.round(dailyDrawdownPct * 100) / 100,
              max_daily_drawdown_pct: limitPct,
            }),
          },
        ],
      };
    }
  }
  const openCount = db.prepare(`SELECT COUNT(*) AS n FROM trade_decisions WHERE exit_recorded_at IS NULL`).get() as {
    n: number;
  };
  const maxOpen = acc!.max_total_open_trades ?? null;
  if (maxOpen != null && (maxOpen as number) > 0) {
    const limit = maxOpen as number;
    if (openCount.n >= limit) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              can_trade: false,
              reason: 'Max open trades reached.',
            }),
          },
        ],
      };
    }
  }
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ can_trade: true }) }],
  };
}

export function registerAccountTools(server: McpServer): void {
  server.registerTool(
    'get_paper_account',
    {
      description:
        'Get the paper trading account (balance, mode, global risk settings). Read-only.',
      inputSchema: z.object({}),
    },
    async () => {
      const row = db
        .prepare(
          `SELECT account_id, mode, COALESCE(chain, 'paper') AS chain, name,
                  starting_equity, current_equity, available_balance,
                  balance_native, balance_last_updated,
                  max_daily_drawdown_pct, max_total_open_trades, COALESCE(max_total_risk_pct, 15) AS max_total_risk_pct, trading_enabled, COALESCE(is_active, 1) AS is_active, created_at, updated_at
           FROM accounts WHERE account_id = $accountId AND mode = 'paper'`
        )
        .get({ accountId: DEFAULT_PAPER_ACCOUNT_ID });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(row ?? null),
          },
        ],
      };
    }
  );

  server.registerTool(
    'get_account',
    {
      description: 'Get a single account by account_id. Returns balance_native, balance_last_updated, chain, mode for UI.',
      inputSchema: z.object({ account_id: z.string() }),
    },
    async (input) => {
      const row = db
        .prepare(
          `SELECT account_id, mode, COALESCE(chain, 'paper') AS chain, name,
                  starting_equity, current_equity, available_balance,
                  balance_native, balance_last_updated,
                  max_daily_drawdown_pct, max_total_open_trades, COALESCE(max_total_risk_pct, 15) AS max_total_risk_pct, trading_enabled, COALESCE(is_active, 1) AS is_active, created_at, updated_at
           FROM accounts WHERE account_id = $accountId`
        )
        .get({ accountId: input.account_id });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(row ?? null) }],
      };
    }
  );

  server.registerTool(
    'get_account_trading_status',
    {
      description:
        'Returns whether the account can trade (same checks as execution worker: trading_enabled, daily drawdown, max open trades). Used by UI to show global risk limit notices.',
      inputSchema: z.object({}),
    },
    async () => {
      const result = await getAccountTradingStatusHandler();
      return result ?? { content: [{ type: 'text' as const, text: JSON.stringify({ can_trade: false, reason: 'Unknown' }) }] };
    }
  );

  server.registerTool(
    'update_account_settings',
    {
      description:
        'Update global account risk settings. These affect ALL strategies. Does not change starting_equity (read-only after creation). Not agent-tunable.',
      inputSchema: z.object({
        account_id: z.optional(z.string()),
        max_daily_drawdown_pct: numOptionalNullable({ min: 0, max: 100 }),
        max_total_open_trades: intOptionalNullable({ min: 0 }),
        max_total_risk_pct: numOptionalNullable({ min: 0, max: 100 }),
        trading_enabled: z.optional(z.boolean()),
        is_active: z.optional(z.boolean()),
      }),
    },
    async (input) => {
      try {
        const accountId = input.account_id ?? DEFAULT_PAPER_ACCOUNT_ID;
        const updates: string[] = [];
        const params: Record<string, unknown> = { accountId };

        if (input.max_daily_drawdown_pct !== undefined) {
          updates.push('max_daily_drawdown_pct = $maxDailyDrawdownPct');
          params.maxDailyDrawdownPct = input.max_daily_drawdown_pct ?? null;
        }
        if (input.max_total_open_trades !== undefined) {
          updates.push('max_total_open_trades = $maxTotalOpenTrades');
          params.maxTotalOpenTrades = input.max_total_open_trades ?? null;
        }
        if (input.max_total_risk_pct !== undefined) {
          updates.push('max_total_risk_pct = $maxTotalRiskPct');
          params.maxTotalRiskPct = input.max_total_risk_pct ?? null;
        }
        if (input.trading_enabled !== undefined) {
          updates.push('trading_enabled = $tradingEnabled');
          params.tradingEnabled = input.trading_enabled ? 1 : 0;
        }
        if (input.is_active !== undefined) {
          updates.push('is_active = $isActive');
          params.isActive = input.is_active ? 1 : 0;
        }
        if (updates.length === 0) {
          const row = db.prepare('SELECT * FROM accounts WHERE account_id = $accountId').get({ accountId });
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  success: true,
                  message: 'No fields to update',
                  account: row,
                }),
              },
            ],
          };
        }
        updates.push('updated_at = $updatedAt');
        params.updatedAt = Math.floor(Date.now() / 1000);
        db.prepare(`UPDATE accounts SET ${updates.join(', ')} WHERE account_id = $accountId`).run(params);
        const row = db.prepare('SELECT * FROM accounts WHERE account_id = $accountId').get({ accountId });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, account: row }),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[mcp-server] update_account_settings error:', msg);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: false, error: msg }),
            },
          ],
        };
      }
    }
  );

  server.registerTool(
    'reset_paper_account',
    {
      description:
        'Reset paper account: close all open paper trades, set current_equity and available_balance to starting_equity. Logs reset.',
      inputSchema: z.object({}),
    },
    async () => {
      const now = Math.floor(Date.now() / 1000);
      const openDecisions = db
        .prepare(
          `SELECT trade_id, pair_address, token_mint, entry_dex, policy_version, entry_price, position_size_usd, executed_at, entry_snapshot_id, entry_score_id, account_id, deployment_id, chain
           FROM trade_decisions WHERE exit_recorded_at IS NULL AND (execution_mode = 'paper' OR execution_mode IS NULL) AND (account_id = $accountId OR account_id IS NULL)`
        )
        .all({ accountId: DEFAULT_PAPER_ACCOUNT_ID }) as {
        trade_id: number;
        pair_address: string;
        token_mint: string | null;
        entry_dex: string | null;
        policy_version: string;
        entry_price: number;
        position_size_usd: number;
        executed_at: number;
        entry_snapshot_id: number | null;
        entry_score_id: number | null;
        account_id: string | null;
        deployment_id: string | null;
        chain: string | null;
      }[];
      const closeAllOpenPaperDecisions = db.prepare(
        `UPDATE trade_decisions SET exit_recorded_at = $exitRecordedAt WHERE exit_recorded_at IS NULL AND (execution_mode = 'paper' OR execution_mode IS NULL) AND (account_id = $accountId OR account_id IS NULL)`
      );
      const insertTrade = db.prepare(
        `INSERT INTO trades (pair_address, token_mint, entry_pair_address, entry_dex, policy_version, entry_snapshot_id, entry_score_id, exit_snapshot_id, entry_time, exit_time, entry_price, exit_price, position_size_usd, exit_reason, pnl_pct, last_volume_ratio, risk_pct_at_entry, score_size_multiplier, is_forced_exit, exit_metadata, exit_liquidity_usd, snapshot_age_at_exit, account_id, deployment_id, execution_mode, chain, actual_usd_bought, actual_usd_sold, sol_received, sol_price_used, sol_price_at_entry, actual_exit_price, entry_slippage_bps_used, exit_slippage_bps_used, tokens_received, tokens_sold, fee_lamports)
         VALUES ($pairAddress, $tokenMint, $entryPairAddress, $entryDex, $policyVersion, $entrySnapshotId, $entryScoreId, NULL, $entryTime, $exitTime, $entryPrice, $exitPrice, $positionSizeUsd, 'reset', 0, NULL, NULL, NULL, 0, NULL, NULL, NULL, $accountId, $deploymentId, 'paper', $chain, $actualUsdBought, $actualUsdSold, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`
      );
      const resetAccount = db.prepare(
        `UPDATE accounts SET current_equity = starting_equity, available_balance = starting_equity, updated_at = $updatedAt
         WHERE account_id = $accountId`
      );
      let accountUpdated = false;
      db.transaction(() => {
        closeAllOpenPaperDecisions.run({ exitRecordedAt: now, accountId: DEFAULT_PAPER_ACCOUNT_ID });
        for (const dec of openDecisions) {
          const entryPairAddress = dec.pair_address;
          const accountId = dec.account_id ?? DEFAULT_PAPER_ACCOUNT_ID;
          insertTrade.run({
            pairAddress: entryPairAddress,
            tokenMint: dec.token_mint ?? null,
            entryPairAddress,
            entryDex: dec.entry_dex ?? null,
            policyVersion: dec.policy_version,
            entrySnapshotId: dec.entry_snapshot_id,
            entryScoreId: dec.entry_score_id ?? null,
            entryTime: dec.executed_at,
            exitTime: now,
            entryPrice: dec.entry_price,
            exitPrice: dec.entry_price,
            positionSizeUsd: dec.position_size_usd,
            accountId,
            deploymentId: dec.deployment_id ?? null,
            chain: dec.chain ?? 'paper',
            actualUsdBought: dec.position_size_usd,
            actualUsdSold: dec.position_size_usd,
          });
        }
        const resetResult = resetAccount.run({ updatedAt: now, accountId: DEFAULT_PAPER_ACCOUNT_ID }) as { changes: number };
        accountUpdated = resetResult.changes > 0;
      })();
      if (!accountUpdated) {
        console.warn('[reset_paper_account] No account row updated; account_id may not match:', DEFAULT_PAPER_ACCOUNT_ID);
      }
      const account = db
        .prepare(
          `SELECT account_id, mode, starting_equity, current_equity, available_balance, max_daily_drawdown_pct, max_total_open_trades, max_total_risk_pct, trading_enabled, updated_at FROM accounts WHERE account_id = $accountId`
        )
        .get({ accountId: DEFAULT_PAPER_ACCOUNT_ID });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              closed_trades: openDecisions.length,
              account: account,
            }),
          },
        ],
      };
    }
  );
}
