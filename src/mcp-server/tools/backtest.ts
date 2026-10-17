import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../../db.js';
import { z, defaultNum, intPositive } from '../schema.js';
import { normalizeBacktestExitReasonForDisplay, type PolicyConfig } from '../../types/backtest.js';

export function registerBacktestTools(server: McpServer): void {
  server.registerTool(
    'run_policy_backtest',
    {
      description:
        'Queue a deterministic backtest for a policy or hypothetical policy over a time range. Backtest runs in a worker; returns backtest_run_id. Use list_backtest_runs to poll status, get_backtest_run to get results. Does not mutate live trading.',
      inputSchema: z.object({
        start_time: z.number(),
        end_time: z.number(),
        source: z.enum(['human', 'agent']),
        source_id: z.optional(z.string()),
        policy_version: z.optional(z.string()),
        policy_config: z.optional(z.record(z.string(), z.unknown())),
        label: z.optional(z.string()),
      }),
    },
    async (input) => {
      const hasVersion = input.policy_version != null && String(input.policy_version).trim().length > 0;
      const hasConfig = input.policy_config != null && typeof input.policy_config === 'object';
      if (hasVersion === hasConfig) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Exactly one of policy_version or policy_config must be provided' }) }],
        };
      }
      if (input.start_time >= input.end_time) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'start_time must be less than end_time' }) }],
        };
      }
      let policyVersion: string | null = null;
      let policyConfigJson: string | null = null;

      if (hasVersion) {
        const row = db.prepare(`SELECT policy_version FROM policies WHERE policy_version = $policyVersion`).get({
          policyVersion: input.policy_version,
        }) as { policy_version: string } | undefined;
        if (!row) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Policy not found' }) }],
          };
        }
        policyVersion = row.policy_version;
      } else {
        const raw = input.policy_config as Record<string, unknown>;
        const config: PolicyConfig = {
          policy_version: (raw.policy_version as string) ?? 'hypothetical',
          allowed_dexes: raw.allowed_dexes != null && typeof raw.allowed_dexes === 'string' ? raw.allowed_dexes : null,
          max_pair_age_seconds: typeof raw.max_pair_age_seconds === 'number' && Number.isFinite(raw.max_pair_age_seconds) ? raw.max_pair_age_seconds : null,
          min_token_age_seconds: typeof raw.min_token_age_seconds === 'number' && Number.isFinite(raw.min_token_age_seconds) ? raw.min_token_age_seconds : null,
          min_price_change_1m_pct:
            typeof raw.min_price_change_1m_pct === 'number' && Number.isFinite(raw.min_price_change_1m_pct)
              ? raw.min_price_change_1m_pct
              : null,
          liquidity_trend_guard_enabled: raw.liquidity_trend_guard_enabled === true || raw.liquidity_trend_guard_enabled === 1,
          max_liquidity_drop_pct_30m: typeof raw.max_liquidity_drop_pct_30m === 'number' && Number.isFinite(raw.max_liquidity_drop_pct_30m) ? raw.max_liquidity_drop_pct_30m : null,
          max_liquidity_drop_pct_1h: typeof raw.max_liquidity_drop_pct_1h === 'number' && Number.isFinite(raw.max_liquidity_drop_pct_1h) ? raw.max_liquidity_drop_pct_1h : null,
          liquidity_trend_min_samples: typeof raw.liquidity_trend_min_samples === 'number' && Number.isFinite(raw.liquidity_trend_min_samples) ? raw.liquidity_trend_min_samples : null,
          max_trades_per_hour: typeof raw.max_trades_per_hour === 'number' && Number.isFinite(raw.max_trades_per_hour) ? raw.max_trades_per_hour : null,
          max_concurrent_trades: typeof raw.max_concurrent_trades === 'number' && Number.isFinite(raw.max_concurrent_trades) ? raw.max_concurrent_trades : null,
          cooldown_seconds_after_loss: typeof raw.cooldown_seconds_after_loss === 'number' && Number.isFinite(raw.cooldown_seconds_after_loss) ? raw.cooldown_seconds_after_loss : null,
          risk_per_trade_pct: typeof raw.risk_per_trade_pct === 'number' && Number.isFinite(raw.risk_per_trade_pct) ? raw.risk_per_trade_pct : null,
          time_stop_seconds: typeof raw.time_stop_seconds === 'number' && Number.isFinite(raw.time_stop_seconds) ? raw.time_stop_seconds : null,
          stop_loss_pct: typeof raw.stop_loss_pct === 'number' && Number.isFinite(raw.stop_loss_pct) ? raw.stop_loss_pct : null,
          take_profit_pct: typeof raw.take_profit_pct === 'number' && Number.isFinite(raw.take_profit_pct) ? raw.take_profit_pct : null,
          cooldown_on_consecutive_losses: typeof raw.cooldown_on_consecutive_losses === 'number' && Number.isFinite(raw.cooldown_on_consecutive_losses) ? raw.cooldown_on_consecutive_losses : null,
          cooldown_on_consecutive_losses_seconds: typeof raw.cooldown_on_consecutive_losses_seconds === 'number' && Number.isFinite(raw.cooldown_on_consecutive_losses_seconds) ? raw.cooldown_on_consecutive_losses_seconds : null,
          pair_loss_cooldown_seconds: typeof raw.pair_loss_cooldown_seconds === 'number' && Number.isFinite(raw.pair_loss_cooldown_seconds) ? raw.pair_loss_cooldown_seconds : null,
          max_consecutive_losses_per_pair: typeof raw.max_consecutive_losses_per_pair === 'number' && Number.isFinite(raw.max_consecutive_losses_per_pair) ? raw.max_consecutive_losses_per_pair : null,
          token_reentry_cooldown_seconds: typeof raw.token_reentry_cooldown_seconds === 'number' && Number.isFinite(raw.token_reentry_cooldown_seconds) ? raw.token_reentry_cooldown_seconds : null,
          token_reentry_cooldown_seconds_after_win: typeof raw.token_reentry_cooldown_seconds_after_win === 'number' && Number.isFinite(raw.token_reentry_cooldown_seconds_after_win) ? raw.token_reentry_cooldown_seconds_after_win : null,
          max_trades_per_token_per_hour: typeof raw.max_trades_per_token_per_hour === 'number' && Number.isFinite(raw.max_trades_per_token_per_hour) ? raw.max_trades_per_token_per_hour : null,
          priority_trade_score: typeof raw.priority_trade_score === 'number' && Number.isFinite(raw.priority_trade_score) ? raw.priority_trade_score : null,
          min_trade_score: typeof raw.min_trade_score === 'number' && Number.isFinite(raw.min_trade_score) ? raw.min_trade_score : null,
        };
        policyConfigJson = JSON.stringify(config);
        const firstActive = db.prepare("SELECT policy_version FROM policies WHERE status = 'active' LIMIT 1").get() as { policy_version: string } | undefined;
        if (!firstActive) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Hypothetical backtest requires at least one active policy to use as score source; no active policy found' }) }],
          };
        }
      }

      const now = Math.floor(Date.now() / 1000);
      const insert = db.prepare(`
        INSERT INTO backtest_runs (label, source, source_id, policy_version, policy_config, start_time, end_time, status, created_at, completed_at)
        VALUES ($label, $source, $sourceId, $policyVersion, $policyConfig, $startTime, $endTime, 'queued', $createdAt, NULL)
      `);
      const result = insert.run({
        label: input.label ?? null,
        source: input.source,
        sourceId: input.source_id ?? null,
        policyVersion,
        policyConfig: policyConfigJson,
        startTime: input.start_time,
        endTime: input.end_time,
        createdAt: now,
      });
      const backtestRunId = (result as { lastInsertRowid: number }).lastInsertRowid;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, backtest_run_id: backtestRunId }) }],
      };
    }
  );

  server.registerTool(
    'list_backtest_runs',
    {
      description: 'List backtest runs for the UI and agents. Optional limit/offset. Returns id, label, policy_version, source, status, time range, metrics summary, created_at.',
      inputSchema: z.object({
        limit: defaultNum(50, { min: 1, max: 200 }),
        offset: defaultNum(0, { min: 0 }),
      }),
    },
    async (input) => {
      const rows = db.prepare(
        `SELECT br.id, br.label, br.source, br.source_id, br.policy_version, br.policy_config,
          br.start_time, br.end_time, br.status, br.created_at, br.completed_at,
          bm.trades, bm.wins, bm.losses, bm.win_rate, bm.avg_pnl, bm.max_drawdown, bm.avg_hold_time_seconds
         FROM backtest_runs br
         LEFT JOIN backtest_metrics bm ON bm.backtest_run_id = br.id
         ORDER BY br.created_at DESC
         LIMIT $limit OFFSET $offset`
      ).all({ limit: input.limit, offset: input.offset }) as {
        id: number;
        label: string | null;
        source: string;
        source_id: string | null;
        policy_version: string | null;
        policy_config: string | null;
        start_time: number;
        end_time: number;
        status: string;
        created_at: number;
        completed_at: number | null;
        trades: number | null;
        wins: number | null;
        losses: number | null;
        win_rate: number | null;
        avg_pnl: number | null;
        max_drawdown: number | null;
        avg_hold_time_seconds: number | null;
      }[];
      const out = rows.map((r) => ({
        id: r.id,
        label: r.label,
        source: r.source,
        source_id: r.source_id,
        policy_display: r.policy_version ?? (r.policy_config ? 'Hypothetical' : null),
        start_time: r.start_time,
        end_time: r.end_time,
        status: r.status,
        trades: r.trades ?? 0,
        win_rate: r.win_rate ?? null,
        avg_pnl: r.avg_pnl ?? null,
        max_drawdown: r.max_drawdown ?? null,
        avg_hold_time_seconds: r.avg_hold_time_seconds ?? null,
        created_at: r.created_at,
        completed_at: r.completed_at,
      }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(out) }] };
    }
  );

  server.registerTool(
    'get_backtest_run',
    {
      description: 'Get a single backtest run with summary metrics and trades. For UI detail view.',
      inputSchema: z.object({
        backtest_run_id: intPositive(),
      }),
    },
    async (input) => {
      const run = db.prepare(
        `SELECT id, label, source, source_id, policy_version, policy_config, start_time, end_time, status, created_at, completed_at
         FROM backtest_runs WHERE id = $backtestRunId`
      ).get({ backtestRunId: input.backtest_run_id }) as {
        id: number;
        label: string | null;
        source: string;
        source_id: string | null;
        policy_version: string | null;
        policy_config: string | null;
        start_time: number;
        end_time: number;
        status: string;
        created_at: number;
        completed_at: number | null;
      } | undefined;
      if (!run) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Backtest run not found' }) }],
        };
      }
      const metricsRow = db
        .prepare('SELECT * FROM backtest_metrics WHERE backtest_run_id = $backtestRunId')
        .get({ backtestRunId: input.backtest_run_id }) as {
        trades: number;
        wins: number;
        losses: number;
        win_rate: number;
        avg_pnl: number;
        max_drawdown: number;
        avg_hold_time_seconds: number;
        entry_diagnostics_summary: string | null;
      } | undefined;
      const metrics = metricsRow
        ? {
            ...metricsRow,
            entry_diagnostics_summary:
              metricsRow.entry_diagnostics_summary != null
                ? (JSON.parse(metricsRow.entry_diagnostics_summary) as Record<string, unknown>)
                : null,
          }
        : null;
      const trades = db
        .prepare(
          `SELECT bt.pair_address, bt.entry_time, bt.exit_time, bt.entry_price, bt.exit_price,
                  bt.result, bt.exit_reason, bt.pnl, bt.hold_time_seconds,
                  p.base_symbol AS base_symbol, p.quote_symbol AS quote_symbol, p.chain AS chain
           FROM backtest_trades bt
           LEFT JOIN pairs p ON p.pair_address = bt.pair_address
           WHERE bt.backtest_run_id = $backtestRunId
           ORDER BY bt.exit_time ASC`
        )
        .all({ backtestRunId: input.backtest_run_id }) as {
          pair_address: string;
          entry_time: number;
          exit_time: number;
          entry_price: number;
          exit_price: number;
          result: string;
          exit_reason: string;
          pnl: number;
          hold_time_seconds: number;
          base_symbol: string | null;
          quote_symbol: string | null;
          chain: string | null;
        }[];
      const tradesForClient = trades.map((t) => ({
        ...t,
        exit_reason: normalizeBacktestExitReasonForDisplay(t.exit_reason),
      }));
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            id: run.id,
            label: run.label,
            source: run.source,
            source_id: run.source_id,
            policy_display: run.policy_version ?? (run.policy_config ? 'Hypothetical' : null),
            policy_config: run.policy_config ? JSON.parse(run.policy_config) : null,
            start_time: run.start_time,
            end_time: run.end_time,
            status: run.status,
            created_at: run.created_at,
            completed_at: run.completed_at,
            metrics: metrics ?? null,
            trades: tradesForClient,
          }),
        }],
      };
    }
  );
}
