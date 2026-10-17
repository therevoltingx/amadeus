import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db, DEFAULT_PAPER_ACCOUNT_ID } from '../../db.js';
import { getSolPriceUsd } from '../../sol-price.js';
import { z, defaultNum, strMin1, intDefault } from '../schema.js';
import { normalizeSkipReason, TRADE_SKIP_REASONS, type TradeSkipReason } from '../../types/trade-skip-reasons.js';
import {
  ENTRY_FILTER_REJECT_REASONS,
  type EntryFilterRejectReason,
} from '../../types/entry-filter-reject-reasons.js';

function normalizeExitReason(reason: string | null): 'TAKE_PROFIT' | 'STOP_LOSS' | 'TIME_STOP' | 'VOLUME_COLLAPSE' | 'OTHER' {
  if (!reason) return 'OTHER';
  const u = reason.toUpperCase();
  if (u === 'TAKE_PROFIT') return 'TAKE_PROFIT';
  if (u === 'STOP_LOSS') return 'STOP_LOSS';
  if (u === 'TIME_STOP' || u === 'TIME_STOP_NO_SNAPSHOTS') return 'TIME_STOP';
  if (u === 'VOLUME_COLLAPSE') return 'VOLUME_COLLAPSE';
  return 'OTHER';
}

export function registerAnalyticsTools(server: McpServer): void {
  /** When accountId is set, return SQL fragment and named params to filter trades by that account (include legacy NULL for paper-default). */
  function tradesAccountFilter(accountId: string | null | undefined): {
    sql: string;
    params: Record<string, string>;
  } {
    if (accountId == null || accountId === '') return { sql: '', params: {} };
    return {
      sql: `(account_id = $accountId OR (account_id IS NULL AND $accountId = $paperDefault))`,
      params: { accountId, paperDefault: DEFAULT_PAPER_ACCOUNT_ID },
    };
  }

  server.registerTool(
    'analytics_get_global_stats',
    {
      description: 'Global account and trade stats: balance, PnL today/total, drawdown, active trades/policies, exit reason breakdown. Optional account_id to scope to a specific wallet (default: paper when omitted).',
      inputSchema: z.object({
        account_id: z.optional(z.nullable(z.string())),
      }),
    },
    async (input) => {
      const accountId = input.account_id ?? DEFAULT_PAPER_ACCOUNT_ID;
      const account = db
        .prepare(
          `SELECT current_equity, starting_equity, mode, COALESCE(chain, 'paper') AS chain, balance_native FROM accounts WHERE account_id = $accountId`
        )
        .get({ accountId }) as {
          current_equity: number;
          starting_equity: number;
          mode: string;
          chain: string;
          balance_native: number | null;
        } | undefined;
      let balanceUsd: number;
      const isLiveSolana = account?.mode === 'live' && account?.chain === 'solana';
      if (isLiveSolana) {
        if (account?.balance_native != null && Number.isFinite(account.balance_native)) {
          try {
            const solPriceUsd = await getSolPriceUsd();
            balanceUsd = account.balance_native * solPriceUsd;
          } catch {
            balanceUsd = 0;
          }
        } else {
          balanceUsd = 0;
        }
      } else {
        balanceUsd = account?.current_equity ?? 0;
      }
      const startOfDay = Math.floor(new Date(new Date().setHours(0, 0, 0, 0)).getTime() / 1000);
      const tw = tradesAccountFilter(accountId);
      const tradeAnd = tw.sql ? ` AND ${tw.sql}` : '';
      const tradesTodayRows = db
        .prepare(
          `SELECT position_size_usd, pnl_pct FROM trades WHERE exit_time >= $startOfDay AND pnl_pct IS NOT NULL${tradeAnd}`
        )
        .all(tw.sql ? { startOfDay, ...tw.params } : { startOfDay }) as { position_size_usd: number; pnl_pct: number }[];
      let pnl_today = 0;
      for (const r of tradesTodayRows) {
        pnl_today += r.position_size_usd * (r.pnl_pct / 100);
      }
      const pnlTotalRow = (tw.sql
        ? db.prepare(
            `SELECT COALESCE(SUM(position_size_usd * pnl_pct / 100.0), 0) AS total FROM trades WHERE pnl_pct IS NOT NULL AND ${tw.sql}`
          ).get(tw.params)
        : db
            .prepare(
              `SELECT COALESCE(SUM(position_size_usd * pnl_pct / 100.0), 0) AS total FROM trades WHERE pnl_pct IS NOT NULL`
            )
            .get()) as { total: number };
      const pnl_total = pnlTotalRow?.total ?? 0;
      const equityAtStartOfDayUsd = balanceUsd - pnl_today;
      const max_drawdown_today_pct =
        equityAtStartOfDayUsd > 0 ? (pnl_today / equityAtStartOfDayUsd) * 100 : 0;
      const tradesTodayCount = db
        .prepare(`SELECT COUNT(*) AS n FROM trades WHERE exit_time >= $startOfDay${tradeAnd}`)
        .get(tw.sql ? { startOfDay, ...tw.params } : { startOfDay }) as { n: number };
      const activeWhere =
        accountId === DEFAULT_PAPER_ACCOUNT_ID
          ? 'exit_recorded_at IS NULL AND (account_id IS NULL OR account_id = $accountId)'
          : 'exit_recorded_at IS NULL AND account_id = $accountId';
      const activeTradesCount = db
        .prepare(`SELECT COUNT(*) AS n FROM trade_decisions WHERE ${activeWhere}`)
        .get({ accountId }) as { n: number };
      const activePoliciesCount = db
        .prepare(`SELECT COUNT(*) AS n FROM policies WHERE status = 'active'`)
        .get() as { n: number };
      const exitRows = (tw.sql
        ? db
            .prepare(
              `SELECT exit_reason FROM trades WHERE exit_reason IS NOT NULL AND ${tw.sql}`
            )
            .all(tw.params)
        : db
            .prepare(`SELECT exit_reason FROM trades WHERE exit_reason IS NOT NULL`)
            .all()) as { exit_reason: string }[];
      const exit_reason_breakdown = { TAKE_PROFIT: 0, STOP_LOSS: 0, TIME_STOP: 0, VOLUME_COLLAPSE: 0, OTHER: 0 };
      for (const r of exitRows) {
        const key = normalizeExitReason(r.exit_reason);
        exit_reason_breakdown[key]++;
      }
      const out = {
        paper_balance: balanceUsd,
        pnl_today,
        pnl_total,
        max_drawdown_today_pct,
        trades_today: tradesTodayCount?.n ?? 0,
        active_trades: activeTradesCount?.n ?? 0,
        active_policies: activePoliciesCount?.n ?? 0,
        exit_reason_breakdown,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    'analytics_get_policy_stats',
    {
      description:
        'Per-policy performance summary: trades, win rate, avg PnL, total PnL, avg hold, exit reason percentages. Grouped by policy_version. Optional account_id to scope to a wallet. By default archived and retired policies are excluded.',
      inputSchema: z.object({
        include_archived: z.optional(z.boolean()),
        include_retired: z.optional(z.boolean()),
        account_id: z.optional(z.nullable(z.string())),
      }),
    },
    async ({ include_archived = false, include_retired = false, account_id: accountId }) => {
      const policies = db
        .prepare(`SELECT policy_id, policy_version, status, COALESCE(archived, 0) AS archived FROM policies`)
        .all() as {
        policy_id: number;
        policy_version: string;
        status: string;
        archived: number;
      }[];
      const policyStatusByVersion = new Map(policies.map((p) => [p.policy_version, p.status]));
      const policyArchivedByVersion = new Map(policies.map((p) => [p.policy_version, p.archived === 1]));
      const tw = tradesAccountFilter(accountId);
      const whereClause = tw.sql ? ` WHERE ${tw.sql}` : '';
      const rows = (tw.sql
        ? db
            .prepare(
              `SELECT
           policy_version,
           COUNT(*) AS trades,
           SUM(CASE WHEN pnl_pct IS NOT NULL AND pnl_pct > 0 THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN pnl_pct IS NOT NULL THEN 1 ELSE 0 END) AS settled,
           COALESCE(AVG(CASE WHEN pnl_pct IS NOT NULL THEN pnl_pct END), NULL) AS avg_pnl_pct,
           COALESCE(SUM(CASE WHEN pnl_pct IS NOT NULL THEN position_size_usd * pnl_pct / 100.0 ELSE 0 END), 0) AS total_pnl,
           COALESCE(AVG(CASE WHEN exit_time IS NOT NULL AND entry_time IS NOT NULL THEN (exit_time - entry_time) END), NULL) AS avg_hold_seconds,
           SUM(CASE WHEN UPPER(exit_reason) = 'TAKE_PROFIT' THEN 1 ELSE 0 END) AS tp_count,
           SUM(CASE WHEN UPPER(exit_reason) = 'STOP_LOSS' THEN 1 ELSE 0 END) AS sl_count,
           SUM(CASE WHEN UPPER(exit_reason) = 'TIME_STOP' THEN 1 ELSE 0 END) AS ts_count,
           SUM(CASE WHEN UPPER(exit_reason) = 'VOLUME_COLLAPSE' THEN 1 ELSE 0 END) AS vc_count,
           AVG(CASE WHEN UPPER(exit_reason) = 'VOLUME_COLLAPSE' AND last_volume_ratio IS NOT NULL THEN last_volume_ratio END) AS avg_volume_ratio_at_vc_exit,
           SUM(CASE WHEN UPPER(exit_reason) = 'VOLUME_COLLAPSE' AND pnl_pct IS NOT NULL AND pnl_pct > 0 THEN 1 ELSE 0 END) AS vc_exit_wins,
           SUM(CASE WHEN exit_reason IS NOT NULL THEN 1 ELSE 0 END) AS exit_count
         FROM trades WHERE ${tw.sql}
         GROUP BY policy_version
         ORDER BY total_pnl DESC`
            )
            .all(tw.params)
        : db
            .prepare(
              `SELECT
           policy_version,
           COUNT(*) AS trades,
           SUM(CASE WHEN pnl_pct IS NOT NULL AND pnl_pct > 0 THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN pnl_pct IS NOT NULL THEN 1 ELSE 0 END) AS settled,
           COALESCE(AVG(CASE WHEN pnl_pct IS NOT NULL THEN pnl_pct END), NULL) AS avg_pnl_pct,
           COALESCE(SUM(CASE WHEN pnl_pct IS NOT NULL THEN position_size_usd * pnl_pct / 100.0 ELSE 0 END), 0) AS total_pnl,
           COALESCE(AVG(CASE WHEN exit_time IS NOT NULL AND entry_time IS NOT NULL THEN (exit_time - entry_time) END), NULL) AS avg_hold_seconds,
           SUM(CASE WHEN UPPER(exit_reason) = 'TAKE_PROFIT' THEN 1 ELSE 0 END) AS tp_count,
           SUM(CASE WHEN UPPER(exit_reason) = 'STOP_LOSS' THEN 1 ELSE 0 END) AS sl_count,
           SUM(CASE WHEN UPPER(exit_reason) = 'TIME_STOP' THEN 1 ELSE 0 END) AS ts_count,
           SUM(CASE WHEN UPPER(exit_reason) = 'VOLUME_COLLAPSE' THEN 1 ELSE 0 END) AS vc_count,
           AVG(CASE WHEN UPPER(exit_reason) = 'VOLUME_COLLAPSE' AND last_volume_ratio IS NOT NULL THEN last_volume_ratio END) AS avg_volume_ratio_at_vc_exit,
           SUM(CASE WHEN UPPER(exit_reason) = 'VOLUME_COLLAPSE' AND pnl_pct IS NOT NULL AND pnl_pct > 0 THEN 1 ELSE 0 END) AS vc_exit_wins,
           SUM(CASE WHEN exit_reason IS NOT NULL THEN 1 ELSE 0 END) AS exit_count
         FROM trades
         GROUP BY policy_version
         ORDER BY total_pnl DESC`
            )
            .all()) as {
        policy_version: string;
        trades: number;
        wins: number;
        settled: number;
        avg_pnl_pct: number | null;
        total_pnl: number;
        avg_hold_seconds: number | null;
        tp_count: number;
        sl_count: number;
        ts_count: number;
        vc_count: number;
        avg_volume_ratio_at_vc_exit: number | null;
        vc_exit_wins: number;
        exit_count: number;
      }[];
      const mapped = rows.map((r) => {
        const status = policyStatusByVersion.get(r.policy_version) ?? 'active';
        const archived = policyArchivedByVersion.get(r.policy_version) ?? false;
        return {
          policy_version: r.policy_version,
          status,
          archived,
          trades: r.trades,
          win_rate_pct: r.settled > 0 ? (r.wins / r.settled) * 100 : 0,
          avg_pnl_pct: r.avg_pnl_pct ?? 0,
          total_pnl: r.total_pnl,
          avg_hold_seconds: r.avg_hold_seconds ?? 0,
          take_profit_pct: r.exit_count > 0 ? (r.tp_count / r.exit_count) * 100 : 0,
          stop_loss_pct: r.exit_count > 0 ? (r.sl_count / r.exit_count) * 100 : 0,
          time_stop_pct: r.exit_count > 0 ? (r.ts_count / r.exit_count) * 100 : 0,
          volume_collapse_pct: r.exit_count > 0 ? (r.vc_count / r.exit_count) * 100 : 0,
          volume_collapse_count: r.vc_count,
          avg_volume_ratio_at_vc_exit: r.avg_volume_ratio_at_vc_exit ?? null,
          volume_collapse_win_pct: r.vc_count > 0 ? (r.vc_exit_wins / r.vc_count) * 100 : null,
        };
      });
      const filtered = mapped.filter((row) => {
        if (!include_retired && row.status === 'retired') return false;
        if (!include_archived && row.archived) return false;
        return true;
      });
      const out = filtered.map(({ archived: _a, ...row }) => row);
      return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    'analytics_get_policy_detail',
    {
      description: 'Detailed stats for a single policy: trades 24h/total, win rate, avg R:R, avg hold, max consecutive losses, exit breakdown. Optional account_id to scope to a wallet.',
      inputSchema: z.object({
        policy_version: strMin1(),
        account_id: z.optional(z.nullable(z.string())),
      }),
    },
    async (input) => {
      const policy_version = input.policy_version;
      const tw = tradesAccountFilter(input.account_id);
      const andAccount = tw.sql ? ` AND ${tw.sql}` : '';
      const now = Math.floor(Date.now() / 1000);
      const last24h = now - 86400;
      const policyParams = { policy_version, last24h };
      const tradesLast24h = db
        .prepare(
          `SELECT COUNT(*) AS n FROM trades WHERE policy_version = $policy_version AND exit_time >= $last24h${andAccount}`
        )
        .get(tw.sql ? { ...policyParams, ...tw.params } : policyParams) as { n: number };
      const tradesTotal = db
        .prepare(`SELECT COUNT(*) AS n FROM trades WHERE policy_version = $policy_version${andAccount}`)
        .get(tw.sql ? { policy_version, ...tw.params } : { policy_version }) as { n: number };
      const agg = db
        .prepare(
          `SELECT
           SUM(CASE WHEN pnl_pct IS NOT NULL AND pnl_pct > 0 THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN pnl_pct IS NOT NULL THEN 1 ELSE 0 END) AS settled,
           COALESCE(AVG(CASE WHEN pnl_pct IS NOT NULL THEN pnl_pct END), NULL) AS avg_pnl_pct,
           COALESCE(AVG(CASE WHEN exit_time IS NOT NULL AND entry_time IS NOT NULL THEN (exit_time - entry_time) END), NULL) AS avg_hold_seconds,
           COALESCE(AVG(CASE WHEN pnl_pct IS NOT NULL AND pnl_pct > 0 THEN pnl_pct END), NULL) AS avg_win_pct,
           COALESCE(AVG(CASE WHEN pnl_pct IS NOT NULL AND pnl_pct < 0 THEN pnl_pct END), NULL) AS avg_loss_pct
         FROM trades WHERE policy_version = $policy_version${andAccount}`
        )
        .get(tw.sql ? { policy_version, ...tw.params } : { policy_version }) as {
        wins: number;
        settled: number;
        avg_pnl_pct: number | null;
        avg_hold_seconds: number | null;
        avg_win_pct: number | null;
        avg_loss_pct: number | null;
      };
      const win_rate_pct = agg?.settled > 0 ? ((agg.wins ?? 0) / agg.settled) * 100 : 0;
      const avg_rr =
        agg?.avg_loss_pct != null && agg.avg_loss_pct < 0 && agg?.avg_win_pct != null
          ? Math.abs((agg.avg_win_pct ?? 0) / agg.avg_loss_pct)
          : null;
      const tradeRows = db
        .prepare(
          `SELECT pnl_pct FROM trades WHERE policy_version = $policy_version AND pnl_pct IS NOT NULL${andAccount} ORDER BY exit_time ASC`
        )
        .all(tw.sql ? { policy_version, ...tw.params } : { policy_version }) as { pnl_pct: number }[];
      let max_consecutive_losses = 0;
      let run = 0;
      for (const r of tradeRows) {
        if (r.pnl_pct < 0) {
          run++;
          if (run > max_consecutive_losses) max_consecutive_losses = run;
        } else run = 0;
      }
      const exitRows = db
        .prepare(
          `SELECT exit_reason FROM trades WHERE policy_version = $policy_version AND exit_reason IS NOT NULL${andAccount}`
        )
        .all(tw.sql ? { policy_version, ...tw.params } : { policy_version }) as { exit_reason: string }[];
      const exit_breakdown: Record<string, number> = {};
      for (const r of exitRows) {
        const key = normalizeExitReason(r.exit_reason);
        exit_breakdown[key] = (exit_breakdown[key] ?? 0) + 1;
      }
      const out = {
        policy_version,
        trades_last_24h: tradesLast24h?.n ?? 0,
        trades_total: tradesTotal?.n ?? 0,
        win_rate_pct,
        avg_rr: avg_rr ?? null,
        avg_hold_seconds: agg?.avg_hold_seconds ?? null,
        max_consecutive_losses,
        exit_breakdown,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    'analytics_get_policy_token_stats',
    {
      description: 'Per-token exposure for a policy: trades, net PnL, win rate, avg hold, last trade at. Optional account_id to scope to a wallet.',
      inputSchema: z.object({
        policy_version: strMin1(),
        account_id: z.optional(z.nullable(z.string())),
      }),
    },
    async (input) => {
      const tw = tradesAccountFilter(input.account_id);
      const andAccount = tw.sql ? ` AND ${tw.sql}` : '';
      const rows = db
        .prepare(
          `SELECT
           COALESCE(token_mint, '') AS token_mint,
           COUNT(*) AS trades,
           COALESCE(SUM(CASE WHEN pnl_pct IS NOT NULL THEN position_size_usd * pnl_pct / 100.0 ELSE 0 END), 0) AS net_pnl,
           SUM(CASE WHEN pnl_pct IS NOT NULL AND pnl_pct > 0 THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN pnl_pct IS NOT NULL THEN 1 ELSE 0 END) AS settled,
           COALESCE(AVG(CASE WHEN exit_time IS NOT NULL AND entry_time IS NOT NULL THEN (exit_time - entry_time) END), NULL) AS avg_hold_seconds,
           MAX(exit_time) AS last_trade_at
         FROM trades
         WHERE policy_version = $policy_version${andAccount}
         GROUP BY COALESCE(token_mint, '')
         ORDER BY trades DESC, net_pnl DESC`
        )
        .all(tw.sql ? { policy_version: input.policy_version, ...tw.params } : { policy_version: input.policy_version }) as {
        token_mint: string;
        trades: number;
        net_pnl: number;
        wins: number;
        settled: number;
        avg_hold_seconds: number | null;
        last_trade_at: number | null;
      }[];
      const out = rows.map((r) => ({
        token_mint: r.token_mint,
        trades: r.trades,
        net_pnl: r.net_pnl,
        win_rate_pct: r.settled > 0 ? (r.wins / r.settled) * 100 : 0,
        avg_hold_seconds: r.avg_hold_seconds ?? 0,
        last_trade_at: r.last_trade_at ?? 0,
      }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    'analytics_get_top_tokens',
    {
      description: 'Top performing tokens across all policies: aggregated by token_mint from trades, ordered by net PnL descending. Optional account_id to scope to a wallet.',
      inputSchema: z.object({
        limit: defaultNum(20, { min: 1, max: 100 }),
        account_id: z.optional(z.nullable(z.string())),
      }),
    },
    async (input) => {
      const limit = input.limit ?? 20;
      const tw = tradesAccountFilter(input.account_id);
      const andAccount = tw.sql ? ` AND ${tw.sql}` : '';
      const rows = db
        .prepare(
          `SELECT
           COALESCE(token_mint, '') AS token_mint,
           COUNT(*) AS trades,
           COALESCE(SUM(CASE WHEN pnl_pct IS NOT NULL THEN position_size_usd * pnl_pct / 100.0 ELSE 0 END), 0) AS net_pnl,
           SUM(CASE WHEN pnl_pct IS NOT NULL AND pnl_pct > 0 THEN 1 ELSE 0 END) AS wins,
           SUM(CASE WHEN pnl_pct IS NOT NULL THEN 1 ELSE 0 END) AS settled,
           COALESCE(AVG(CASE WHEN exit_time IS NOT NULL AND entry_time IS NOT NULL THEN (exit_time - entry_time) END), NULL) AS avg_hold_seconds,
           MAX(exit_time) AS last_trade_at
         FROM trades
         WHERE token_mint IS NOT NULL AND token_mint != ''${andAccount}
         GROUP BY token_mint
         ORDER BY net_pnl DESC
         LIMIT $limit`
        )
        .all(tw.sql ? { ...tw.params, limit } : { limit }) as {
        token_mint: string;
        trades: number;
        net_pnl: number;
        wins: number;
        settled: number;
        avg_hold_seconds: number | null;
        last_trade_at: number | null;
      }[];
      const out = rows.map((r) => ({
        token_mint: r.token_mint,
        trades: r.trades,
        net_pnl: r.net_pnl,
        win_rate_pct: r.settled > 0 ? (r.wins / r.settled) * 100 : 0,
        avg_hold_seconds: r.avg_hold_seconds ?? 0,
        last_trade_at: r.last_trade_at ?? 0,
      }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    'analytics_get_trades',
    {
      description: 'List trades with optional filters: policy_version, token_mint, exit_reason, account_id, limit. For drilldown and agent consumption.',
      inputSchema: z.object({
        policy_version: z.optional(z.string()),
        token_mint: z.optional(z.string()),
        exit_reason: z.optional(z.string()),
        account_id: z.optional(z.nullable(z.string())),
        limit: defaultNum(100, { min: 1, max: 500 }),
      }),
    },
    async (input) => {
      const conditions: string[] = [];
      const params: Record<string, string | number> = {};
      if (input.policy_version) {
        conditions.push('policy_version = $policy_version');
        params.policy_version = input.policy_version;
      }
      if (input.token_mint !== undefined && input.token_mint !== '') {
        conditions.push('token_mint = $token_mint');
        params.token_mint = input.token_mint;
      }
      if (input.exit_reason) {
        conditions.push('exit_reason = $exit_reason');
        params.exit_reason = input.exit_reason;
      }
      const tw = tradesAccountFilter(input.account_id);
      if (tw.sql) {
        conditions.push(tw.sql);
        Object.assign(params, tw.params);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = input.limit ?? 100;
      const rows = db
        .prepare(
          `SELECT trade_id, entry_time AS timestamp, policy_version, COALESCE(token_mint, '') AS token_mint,
                  entry_price, exit_price, pnl_pct, exit_reason,
                  COALESCE(execution_mode, 'paper') AS execution_mode,
                  CASE WHEN exit_time IS NOT NULL AND entry_time IS NOT NULL THEN (exit_time - entry_time) ELSE NULL END AS hold_seconds
           FROM trades ${where} ORDER BY entry_time DESC LIMIT $limit`
        )
        .all(where ? { ...params, limit } : { limit }) as {
        trade_id: number;
        timestamp: number;
        policy_version: string;
        token_mint: string;
        entry_price: number;
        exit_price: number;
        pnl_pct: number | null;
        exit_reason: string | null;
        execution_mode: string | null;
        hold_seconds: number | null;
      }[];
      const out = rows.map((r) => ({
        trade_id: String(r.trade_id),
        timestamp: r.timestamp,
        policy_version: r.policy_version,
        token_mint: r.token_mint,
        entry_price: r.entry_price,
        exit_price: r.exit_price,
        pnl_pct: r.pnl_pct ?? 0,
        exit_reason: r.exit_reason ?? 'OTHER',
        execution_mode: r.execution_mode === 'live' ? 'live' : 'paper',
        hold_seconds: r.hold_seconds ?? 0,
      }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    'analytics_get_policy_rejection_stats',
    {
      description:
        'Rejection stats per policy: total rejections and breakdown by canonical reason (count, pct of rejections, pct of all decisions). Data from trade_decision_skips.',
      inputSchema: z.object({
        policy_version: z.optional(z.string()),
        since_seconds: intDefault(86400, { min: 1 }),
      }),
    },
    async (input) => {
      const since = Math.floor(Date.now() / 1000) - (input.since_seconds ?? 86400);
      const skipConditions = ['decided_at >= $sinceSkip'];
      const skipParams: Record<string, unknown> = { sinceSkip: since };
      if (input.policy_version) {
        skipConditions.push('policy_version = $policyVersionSkip');
        skipParams.policyVersionSkip = input.policy_version;
      }
      const skipWhere = skipConditions.join(' AND ');
      const skipRows = db
        .prepare(
          `SELECT policy_version, reason, COUNT(*) AS cnt FROM trade_decision_skips WHERE ${skipWhere} GROUP BY policy_version, reason`
        )
        .all(skipParams) as { policy_version: string; reason: string; cnt: number }[];
      const entryConditions = ['executed_at >= $sinceEntry'];
      const entryParams: Record<string, unknown> = { sinceEntry: since };
      if (input.policy_version) {
        entryConditions.push('policy_version = $policyVersionEntry');
        entryParams.policyVersionEntry = input.policy_version;
      }
      const entryWhere = entryConditions.join(' AND ');
      const entryRows = db
        .prepare(
          `SELECT policy_version, COUNT(*) AS cnt FROM trade_decisions WHERE ${entryWhere} GROUP BY policy_version`
        )
        .all(entryParams) as { policy_version: string; cnt: number }[];
      const entriesByPolicy = new Map(entryRows.map((r) => [r.policy_version, r.cnt]));
      const skipByPolicyReason = new Map<string, Map<string, number>>();
      for (const r of skipRows) {
        const canon = normalizeSkipReason(r.reason);
        if (!skipByPolicyReason.has(r.policy_version)) {
          skipByPolicyReason.set(r.policy_version, new Map());
        }
        const reasonMap = skipByPolicyReason.get(r.policy_version)!;
        reasonMap.set(canon, (reasonMap.get(canon) ?? 0) + r.cnt);
      }
      const policyVersions = new Set<string>([...skipByPolicyReason.keys(), ...entriesByPolicy.keys()]);
      const out: Array<{
        policy_version: string;
        total_rejections: number;
        total_entries: number;
        total_decisions: number;
        rejection_breakdown: Record<
          TradeSkipReason,
          { count: number; pct_of_rejections: number; pct_of_all_decisions: number }
        >;
      }> = [];
      for (const pv of policyVersions) {
        const reasonMap = skipByPolicyReason.get(pv) ?? new Map<string, number>();
        const total_rejections = [...reasonMap.values()].reduce((a, b) => a + b, 0);
        const total_entries = entriesByPolicy.get(pv) ?? 0;
        const total_decisions = total_rejections + total_entries;
        const rejection_breakdown = {} as Record<
          TradeSkipReason,
          { count: number; pct_of_rejections: number; pct_of_all_decisions: number }
        >;
        for (const reason of TRADE_SKIP_REASONS) {
          const count = reasonMap.get(reason) ?? 0;
          rejection_breakdown[reason] = {
            count,
            pct_of_rejections: total_rejections > 0 ? (count / total_rejections) * 100 : 0,
            pct_of_all_decisions: total_decisions > 0 ? (count / total_decisions) * 100 : 0,
          };
        }
        out.push({ policy_version: pv, total_rejections, total_entries, total_decisions, rejection_breakdown });
      }
      out.sort((a, b) => b.total_rejections - a.total_rejections);
      return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    'analytics_get_policy_rejection_timeline',
    {
      description:
        'Time-series of rejections by policy and reason (e.g. hourly buckets). For regime shifts and binding constraints.',
      inputSchema: z.object({
        policy_version: z.optional(z.string()),
        since_seconds: intDefault(86400, { min: 1 }),
        bucket_seconds: intDefault(3600, { min: 60 }),
      }),
    },
    async (input) => {
      const since = Math.floor(Date.now() / 1000) - (input.since_seconds ?? 86400);
      const bucket = input.bucket_seconds ?? 3600;
      const conditions = ['decided_at >= $sinceTimeline'];
      const params: Record<string, unknown> = { sinceTimeline: since, bucket };
      if (input.policy_version) {
        conditions.push('policy_version = $policyVersionTimeline');
        params.policyVersionTimeline = input.policy_version;
      }
      const where = conditions.join(' AND ');
      const rows = db
        .prepare(
          `SELECT
           (CAST(decided_at / $bucket AS INTEGER) * $bucket) AS timestamp_bucket,
           policy_version,
           reason,
           COUNT(*) AS count
         FROM trade_decision_skips
         WHERE ${where}
         GROUP BY timestamp_bucket, policy_version, reason
         ORDER BY timestamp_bucket ASC, policy_version, reason`
        )
        .all(params) as {
        timestamp_bucket: number;
        policy_version: string;
        reason: string;
        count: number;
      }[];
      const out = rows.map((r) => ({
        timestamp_bucket: r.timestamp_bucket * bucket,
        policy_version: r.policy_version,
        reason: normalizeSkipReason(r.reason),
        count: r.count,
      }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    'get_policy_stats_timeseries',
    {
      description:
        'Hourly policy stats for UI and agents: opportunity vs action, skip pressure, avg trade score. Same data for Stats page and agent reasoning. Query policy_stats_hourly.',
      inputSchema: z.object({
        policy_version: z.string(),
        from: z.optional(z.int()),
        to: z.optional(z.int()),
      }),
    },
    async (input) => {
      const conditions = ['policy_version = $statsPolicyVersion'];
      const params: Record<string, unknown> = { statsPolicyVersion: input.policy_version };
      if (input.from != null) {
        conditions.push('bucket_start >= $statsFrom');
        params.statsFrom = input.from;
      }
      if (input.to != null) {
        conditions.push('bucket_start <= $statsTo');
        params.statsTo = input.to;
      }
      const where = conditions.join(' AND ');
      const rows = db
        .prepare(
          `SELECT bucket_start, policy_version,
          scores_above_min, scores_above_priority, entry_filters_passed,
          trades_opened, trades_closed, wins, losses,
          skips_token_cooldown, skips_policy_cooldown, skips_max_trades_per_hour, skips_entry_filter, skips_score_below_threshold,
          sum_trade_score, count_trade_score, sum_blocked_trade_score, count_blocked_trade_score
         FROM policy_stats_hourly
         WHERE ${where}
         ORDER BY bucket_start ASC`
        )
        .all(params) as {
        bucket_start: number;
        policy_version: string;
        scores_above_min: number;
        scores_above_priority: number;
        entry_filters_passed: number;
        trades_opened: number;
        trades_closed: number;
        wins: number;
        losses: number;
        skips_token_cooldown: number;
        skips_policy_cooldown: number;
        skips_max_trades_per_hour: number;
        skips_entry_filter: number;
        skips_score_below_threshold: number;
        sum_trade_score: number;
        count_trade_score: number;
        sum_blocked_trade_score: number;
        count_blocked_trade_score: number;
      }[];
      const out = rows.map((r) => ({
        bucket_start: r.bucket_start,
        policy_version: r.policy_version,
        scores_above_priority: r.scores_above_priority,
        trades_opened: r.trades_opened,
        wins: r.wins,
        losses: r.losses,
        skips_max_trades_per_hour: r.skips_max_trades_per_hour,
        skips_token_cooldown: r.skips_token_cooldown,
        skips_policy_cooldown: r.skips_policy_cooldown,
        skips_entry_filter: r.skips_entry_filter,
        skips_score_below_threshold: r.skips_score_below_threshold,
        avg_trade_score:
          r.count_trade_score > 0 ? r.sum_trade_score / r.count_trade_score : null,
        avg_blocked_trade_score:
          r.count_blocked_trade_score > 0
            ? r.sum_blocked_trade_score / r.count_blocked_trade_score
            : null,
        scores_above_min: r.scores_above_min,
        entry_filters_passed: r.entry_filters_passed,
        trades_closed: r.trades_closed,
      }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    'analytics_get_policy_entry_filter_rejections',
    {
      description:
        'Entry filter rejection stats per policy: total rejections and breakdown by canonical reason (count, pct, avg distance from threshold). Data from entry_filter_rejections.',
      inputSchema: z.object({
        policy_version: z.optional(z.string()),
        since_seconds: intDefault(86400, { min: 1 }),
      }),
    },
    async (input) => {
      const since = Math.floor(Date.now() / 1000) - (input.since_seconds ?? 86400);
      const conditions = ['decided_at >= $sinceEfr'];
      const params: Record<string, unknown> = { sinceEfr: since };
      if (input.policy_version) {
        conditions.push('policy_version = $policyVersionEfr');
        params.policyVersionEfr = input.policy_version;
      }
      const where = conditions.join(' AND ');
      const rows = db
        .prepare(
          `SELECT
           policy_version,
           sub_reason,
           COUNT(*) AS cnt,
           SUM(CASE WHEN threshold_value IS NOT NULL AND threshold_value != 0 THEN (observed_value - threshold_value) / threshold_value ELSE 0 END) AS sum_distance,
           SUM(CASE WHEN threshold_value IS NOT NULL AND threshold_value != 0 THEN 1 ELSE 0 END) AS cnt_with_threshold
         FROM entry_filter_rejections
         WHERE ${where}
         GROUP BY policy_version, sub_reason`
        )
        .all(params) as {
        policy_version: string;
        sub_reason: string;
        cnt: number;
        sum_distance: number;
        cnt_with_threshold: number;
      }[];
      const byPolicy = new Map<
        string,
        { total: number; byReason: Map<string, { count: number; sumDist: number; cntDist: number }> }
      >();
      for (const r of rows) {
        const canon = ENTRY_FILTER_REJECT_REASONS.includes(r.sub_reason as EntryFilterRejectReason)
          ? (r.sub_reason as EntryFilterRejectReason)
          : 'OTHER_ENTRY_FILTER';
        if (!byPolicy.has(r.policy_version)) {
          byPolicy.set(r.policy_version, { total: 0, byReason: new Map() });
        }
        const rec = byPolicy.get(r.policy_version)!;
        rec.total += r.cnt;
        const existing = rec.byReason.get(canon);
        if (existing) {
          existing.count += r.cnt;
          existing.sumDist += r.sum_distance;
          existing.cntDist += r.cnt_with_threshold;
        } else {
          rec.byReason.set(canon, {
            count: r.cnt,
            sumDist: r.sum_distance,
            cntDist: r.cnt_with_threshold,
          });
        }
      }
      const out: Array<{
        policy_version: string;
        total_entry_filter_rejections: number;
        breakdown: Record<
          EntryFilterRejectReason,
          { count: number; pct_of_entry_filter_rejections: number; avg_distance_from_threshold: number | null }
        >;
      }> = [];
      for (const [pv, rec] of byPolicy) {
        const breakdown = {} as Record<
          EntryFilterRejectReason,
          { count: number; pct_of_entry_filter_rejections: number; avg_distance_from_threshold: number | null }
        >;
        for (const reason of ENTRY_FILTER_REJECT_REASONS) {
          const r = rec.byReason.get(reason);
          const count = r?.count ?? 0;
          const avg_distance =
            r && r.cntDist > 0 ? r.sumDist / r.cntDist : null;
          breakdown[reason] = {
            count,
            pct_of_entry_filter_rejections: rec.total > 0 ? (count / rec.total) * 100 : 0,
            avg_distance_from_threshold: avg_distance,
          };
        }
        out.push({
          policy_version: pv,
          total_entry_filter_rejections: rec.total,
          breakdown,
        });
      }
      out.sort((a, b) => b.total_entry_filter_rejections - a.total_entry_filter_rejections);
      return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    'analytics_get_policy_entry_filter_margins',
    {
      description:
        'Entry filter margins: how close rejections were to threshold (within 10% = just under, far = rest). For surgical relaxation.',
      inputSchema: z.object({
        policy_version: z.optional(z.string()),
        since_seconds: intDefault(86400, { min: 1 }),
        margin_pct: defaultNum(10, { min: 0, max: 100 }),
      }),
    },
    async (input) => {
      const since = Math.floor(Date.now() / 1000) - (input.since_seconds ?? 86400);
      const margin = (input.margin_pct ?? 10) / 100;
      const conditions = ['decided_at >= $sinceEfm', 'threshold_value IS NOT NULL', 'threshold_value != 0'];
      const params: Record<string, unknown> = { sinceEfm: since, margin };
      if (input.policy_version) {
        conditions.push('policy_version = $policyVersionEfm');
        params.policyVersionEfm = input.policy_version;
      }
      const where = conditions.join(' AND ');
      const rows = db
        .prepare(
          `SELECT policy_version, sub_reason,
           SUM(CASE WHEN (observed_value - threshold_value) / threshold_value >= -$margin AND (observed_value - threshold_value) / threshold_value < 0 THEN 1 ELSE 0 END) AS within_margin,
           SUM(CASE WHEN (observed_value - threshold_value) / threshold_value < -$margin THEN 1 ELSE 0 END) AS far_below
         FROM entry_filter_rejections
         WHERE ${where}
         GROUP BY policy_version, sub_reason`
        )
        .all(params) as {
        policy_version: string;
        sub_reason: string;
        within_margin: number;
        far_below: number;
      }[];
      const out = rows.map((r) => ({
        policy_version: r.policy_version,
        sub_reason: ENTRY_FILTER_REJECT_REASONS.includes(r.sub_reason as EntryFilterRejectReason)
          ? r.sub_reason
          : 'OTHER_ENTRY_FILTER',
        within_margin_count: r.within_margin,
        far_below_count: r.far_below,
      }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
    }
  );
}
