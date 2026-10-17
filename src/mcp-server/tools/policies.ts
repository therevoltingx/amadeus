import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../../db.js';
import {
  z,
  defaultNum,
  strMin1,
  intPositive,
  intOptionalNullable,
  numMinOptional,
  numOptionalNullable,
} from '../schema.js';
import { POLICY_STATUSES, POLICY_CREATED_BY_VALUES, isAllowedDexesValue } from '../../types/policy.js';

const updatePolicyInputSchema = z.object({
  policy_id: intPositive(),
  policy_version: z.optional(strMin1()),
  status: z.optional(z.enum(POLICY_STATUSES)),
  created_by: z.optional(z.enum(POLICY_CREATED_BY_VALUES)),
  linked_policy_id: z.optional(z.nullable(intPositive())),
  notes: z.optional(z.string()),
  max_pair_age_seconds: z.optional(z.number()),
  min_token_age_seconds: intOptionalNullable({ min: 0 }),
  min_liquidity_usd: z.optional(z.number()),
  min_volume_1m_usd: z.optional(z.number()),
  min_price_change_1m_pct: z.optional(z.nullable(z.number())),
  min_volume_5m_usd: z.optional(z.nullable(z.number())),
  min_buy_sell_ratio: z.optional(z.number()),
  min_transactions_1m: z.optional(z.nullable(z.number())),
  min_velocity_score_1m: z.optional(z.nullable(z.number())),
  min_buy_pressure_1m: z.optional(z.nullable(z.number())),
  min_buy_volume_1m_usd: z.optional(z.nullable(z.number())),
  min_sell_volume_1m_usd: z.optional(z.nullable(z.number())),
  require_no_mint_authority: z.optional(z.boolean()),
  require_no_freeze_authority: z.optional(z.boolean()),
  require_lp_lock: z.optional(z.boolean()),
  max_top_holder_pct: z.optional(z.nullable(z.number())),
  min_holder_count: z.optional(z.nullable(z.number())),
  allowed_dexes: z.optional(z.nullable(z.string().check(z.refine((v: string | null) => v == null || v === '' || isAllowedDexesValue(v), 'allowed_dexes must be a comma-separated subset of: raydium, orca, pumpswap, pumpfun')))),
  weight_liquidity_velocity: z.optional(z.number()),
  weight_liquidity_absolute: z.optional(z.number()),
  weight_volume_1m: z.optional(z.number()),
  weight_volume_5m: z.optional(z.number()),
  weight_buy_volume_1m: z.optional(z.number()),
  weight_sell_volume_1m: z.optional(z.number()),
  weight_volume_acceleration_1m: z.optional(z.number()),
  weight_price_volatility_5m: z.optional(z.number()),
  weight_market_cap: z.optional(z.number()),
  weight_buy_sell_slope_1m: z.optional(z.number()),
  weight_velocity_score_1m: z.optional(z.number()),
  weight_buy_pressure_1m: z.optional(z.number()),
  weight_sell_pressure_1m: z.optional(z.number()),
  weight_price_momentum_5m: z.optional(z.number()),
  weight_holder_growth: z.optional(z.number()),
  weight_holder_concentration_penalty: z.optional(z.number()),
  weight_time_since_launch: z.optional(z.number()),
  weight_pair_age_seconds: z.optional(z.number()),
  min_trade_score: z.optional(z.number()),
  priority_trade_score: z.optional(z.number()),
  risk_per_trade_pct: z.optional(z.number()),
  stop_loss_pct: z.optional(z.number()),
  take_profit_pct: z.optional(z.number()),
  max_trades_per_hour: z.optional(z.number()),
  max_concurrent_trades: z.optional(z.number()),
  cooldown_seconds_after_loss: z.optional(z.number()),
  time_stop_seconds: z.optional(z.number()),
  halt_on_liquidity_drop_pct: z.optional(z.number()),
  cooldown_on_consecutive_losses: intOptionalNullable({ min: 0 }),
  cooldown_on_consecutive_losses_seconds: intOptionalNullable({ min: 0 }),
  halt_on_rug_detected: z.optional(z.boolean()),
  allow_low_confidence_trades: z.optional(z.boolean()),
  auto_optimize: z.optional(z.boolean()),
  token_reentry_cooldown_seconds: numMinOptional(0),
  token_reentry_cooldown_seconds_after_win: intOptionalNullable({ min: 0 }),
  max_trades_per_token_per_hour: intOptionalNullable({ min: 1 }),
  pair_loss_cooldown_seconds: intOptionalNullable({ min: 0 }),
  max_consecutive_losses_per_pair: intOptionalNullable({ min: 1 }),
  volume_collapse_exit_enabled: z.optional(z.boolean()),
  volume_collapse_ratio_threshold: z.optional(z.number()),
  volume_collapse_consecutive_checks: intOptionalNullable({ min: 1 }),
  volume_collapse_min_samples: intOptionalNullable({ min: 1 }),
  liquidity_trend_guard_enabled: z.optional(z.boolean()),
  max_liquidity_drop_pct_30m: numOptionalNullable({ min: -1, max: 0 }),
  max_liquidity_drop_pct_1h: numOptionalNullable({ min: -1, max: 0 }),
  liquidity_trend_min_samples: intOptionalNullable({ min: 1 }),
  rug_exit_enabled: z.optional(z.boolean()),
  rug_liquidity_floor_usd: numOptionalNullable({ min: 0 }),
  rug_snapshot_stale_seconds: intOptionalNullable({ min: 0 }),
  rug_pair_missing_threshold: intOptionalNullable({ min: 1 }),
});

export function registerPoliciesTools(server: McpServer): void {
  server.registerTool(
    'export_policy',
    {
      description:
        'Export a policy as JSON for sharing or backup. Returns the full policy row (all fields). Use policy_version to identify the policy.',
      inputSchema: z.object({ policy_version: strMin1() }),
    },
    async (input) => {
      const row = db.prepare('SELECT * FROM policies WHERE policy_version = $policyVersion').get({
        policyVersion: input.policy_version,
      });
      if (!row) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Policy not found' }) }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(row, null, 2) }],
      };
    }
  );

  server.registerTool(
    'list_policies',
    {
      description:
        'List policies from the database. By default archived policies are excluded; set include_archived to true to show them.',
      inputSchema: z.object({
        limit: defaultNum(100, { min: 1, max: 500 }),
        offset: defaultNum(0, { min: 0 }),
        status: z.optional(z.enum(POLICY_STATUSES)),
        include_archived: z.optional(z.boolean()),
      }),
    },
    async ({ limit, offset, status, include_archived }) => {
      const where: string[] = [];
      const params: Record<string, unknown> = { limit, offset };
      if (!include_archived) {
        where.push('(p.archived = 0 OR p.archived IS NULL)');
      }
      if (status) {
        where.push('p.status = $policyStatus');
        params.policyStatus = status;
      }
      const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
      const sql = `SELECT p.*, e.policy_cooldown_until, e.consecutive_loss_count
           FROM policies p
           LEFT JOIN policy_execution_state e ON e.policy_version = p.policy_version
           ${whereClause} ORDER BY p.created_at DESC LIMIT $limit OFFSET $offset`;
      const policies = db.prepare(sql).all(params);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(policies, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    'archive_policy',
    {
      description:
        'Archive a draft or retired policy so it is hidden from the default list. Active policies cannot be archived (retire them first). Archived policies can be shown again by listing with include_archived: true.',
      inputSchema: z.object({
        policy_id: intPositive(),
      }),
    },
    async ({ policy_id }) => {
      const row = db
        .prepare('SELECT policy_id, status FROM policies WHERE policy_id = $policyId')
        .get({ policyId: policy_id }) as { policy_id: number; status: string } | undefined;
      if (!row) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Policy not found' }) }],
        };
      }
      if (row.status !== 'retired' && row.status !== 'draft') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                error: 'Only draft or retired policies can be archived (retire active policies first)',
              }),
            },
          ],
        };
      }
      const now = Math.floor(Date.now() / 1000);
      db
        .prepare('UPDATE policies SET archived = 1, archived_at = $archivedAt WHERE policy_id = $policyId')
        .run({ archivedAt: now, policyId: policy_id });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, policy_id, archived_at: now }) }],
      };
    }
  );

  server.registerTool(
    'create_policy',
    {
      description: 'Create a new policy in the database',
      inputSchema: z.object({
        policy_version: strMin1(),
        status: z._default(z.enum(POLICY_STATUSES), 'draft'),
        created_by: z.enum(POLICY_CREATED_BY_VALUES),
  linked_policy_id: z.optional(z.nullable(intPositive())),
  parent_policy_version: z.optional(z.nullable(z.string())),
  notes: z.optional(z.string()),
  changelog: z.optional(z.string()),
  max_pair_age_seconds: z.optional(z.number()),
        min_token_age_seconds: intOptionalNullable({ min: 0 }),
        min_liquidity_usd: z.optional(z.number()),
        min_volume_1m_usd: z.optional(z.number()),
        min_price_change_1m_pct: z.optional(z.nullable(z.number())),
        min_volume_5m_usd: z.optional(z.nullable(z.number())),
        min_buy_sell_ratio: z.optional(z.number()),
        min_transactions_1m: z.optional(z.nullable(z.number())),
        min_velocity_score_1m: z.optional(z.nullable(z.number())),
        min_buy_pressure_1m: z.optional(z.nullable(z.number())),
        min_buy_volume_1m_usd: z.optional(z.nullable(z.number())),
        min_sell_volume_1m_usd: z.optional(z.nullable(z.number())),
        require_no_mint_authority: z.optional(z.boolean()),
        require_no_freeze_authority: z.optional(z.boolean()),
        require_lp_lock: z.optional(z.boolean()),
        max_top_holder_pct: z.optional(z.nullable(z.number())),
        min_holder_count: z.optional(z.nullable(z.number())),
        allowed_dexes: z.optional(z.nullable(z.string().check(z.refine((v: string | null) => v == null || v === '' || isAllowedDexesValue(v), 'allowed_dexes must be a comma-separated subset of: raydium, orca, pumpswap, pumpfun')))),
        weight_liquidity_velocity: z.optional(z.number()),
        weight_liquidity_absolute: z.optional(z.number()),
        weight_volume_1m: z.optional(z.number()),
        weight_volume_5m: z.optional(z.number()),
        weight_buy_volume_1m: z.optional(z.number()),
        weight_sell_volume_1m: z.optional(z.number()),
        weight_volume_acceleration_1m: z.optional(z.number()),
        weight_price_volatility_5m: z.optional(z.number()),
        weight_market_cap: z.optional(z.number()),
        weight_buy_sell_slope_1m: z.optional(z.number()),
        weight_velocity_score_1m: z.optional(z.number()),
        weight_buy_pressure_1m: z.optional(z.number()),
        weight_sell_pressure_1m: z.optional(z.number()),
        weight_price_momentum_5m: z.optional(z.number()),
        weight_holder_growth: z.optional(z.number()),
        weight_holder_concentration_penalty: z.optional(z.number()),
        weight_time_since_launch: z.optional(z.number()),
        weight_pair_age_seconds: z.optional(z.number()),
        min_trade_score: z.optional(z.number()),
        priority_trade_score: z.optional(z.number()),
        risk_per_trade_pct: z.optional(z.number()),
        stop_loss_pct: z.optional(z.number()),
        take_profit_pct: z.optional(z.number()),
        max_trades_per_hour: z.optional(z.number()),
        max_concurrent_trades: z.optional(z.number()),
        cooldown_seconds_after_loss: z.optional(z.number()),
        time_stop_seconds: z.optional(z.number()),
        halt_on_liquidity_drop_pct: z.optional(z.number()),
        cooldown_on_consecutive_losses: intOptionalNullable({ min: 0 }),
        cooldown_on_consecutive_losses_seconds: intOptionalNullable({ min: 0 }),
        halt_on_rug_detected: z.optional(z.boolean()),
        allow_low_confidence_trades: z.optional(z.boolean()),
        auto_optimize: z.optional(z.boolean()),
        token_reentry_cooldown_seconds: numMinOptional(0),
        token_reentry_cooldown_seconds_after_win: intOptionalNullable({ min: 0 }),
        max_trades_per_token_per_hour: intOptionalNullable({ min: 1 }),
        pair_loss_cooldown_seconds: intOptionalNullable({ min: 0 }),
        max_consecutive_losses_per_pair: intOptionalNullable({ min: 1 }),
        volume_collapse_exit_enabled: z.optional(z.boolean()),
        volume_collapse_ratio_threshold: z.optional(z.nullable(z.number())),
        volume_collapse_consecutive_checks: z.optional(z.nullable(z.number())),
        volume_collapse_min_samples: z.optional(z.nullable(z.number())),
        liquidity_trend_guard_enabled: z.optional(z.boolean()),
        max_liquidity_drop_pct_30m: numOptionalNullable({ min: -1, max: 0 }),
        max_liquidity_drop_pct_1h: numOptionalNullable({ min: -1, max: 0 }),
        liquidity_trend_min_samples: intOptionalNullable({ min: 1 }),
        rug_exit_enabled: z.optional(z.boolean()),
        rug_liquidity_floor_usd: z.optional(z.nullable(z.number())),
        rug_snapshot_stale_seconds: z.optional(z.nullable(z.number())),
        rug_pair_missing_threshold: z.optional(z.nullable(z.number())),
      }),
    },
    async (input) => {
      try {
        const minAge = input.min_token_age_seconds ?? null;
        const maxAge = input.max_pair_age_seconds ?? null;
        if (minAge != null && maxAge != null && minAge > maxAge) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'min_token_age_seconds must be <= max_pair_age_seconds when both are set' }) }],
          };
        }
        const now = Math.floor(Date.now() / 1000);
        const insert = db.prepare(`
      INSERT INTO policies (
        policy_version, status, created_at, created_by, linked_policy_id, parent_policy_version, notes, changelog,
        max_pair_age_seconds, min_token_age_seconds, min_liquidity_usd, min_volume_1m_usd, min_price_change_1m_pct, min_volume_5m_usd, min_buy_sell_ratio,
        min_transactions_1m, min_velocity_score_1m, min_buy_pressure_1m,
        min_buy_volume_1m_usd, min_sell_volume_1m_usd,
        require_no_mint_authority, require_no_freeze_authority, require_lp_lock, max_top_holder_pct,
        min_holder_count,
        allowed_dexes,
        weight_liquidity_velocity, weight_liquidity_absolute, weight_volume_1m, weight_volume_5m, weight_volume_acceleration_1m, weight_price_volatility_5m, weight_market_cap, weight_buy_sell_slope_1m,
        weight_velocity_score_1m, weight_buy_pressure_1m, weight_sell_pressure_1m,
        weight_buy_volume_1m, weight_sell_volume_1m,
        weight_price_momentum_5m, weight_holder_growth, weight_holder_concentration_penalty,
        weight_time_since_launch, weight_pair_age_seconds, min_trade_score, priority_trade_score,
        risk_per_trade_pct, stop_loss_pct,
        take_profit_pct,
        max_trades_per_hour, max_concurrent_trades, cooldown_seconds_after_loss,
        time_stop_seconds, halt_on_liquidity_drop_pct, cooldown_on_consecutive_losses, cooldown_on_consecutive_losses_seconds,
        halt_on_rug_detected, allow_low_confidence_trades, auto_optimize,
        token_reentry_cooldown_seconds, token_reentry_cooldown_seconds_after_win, max_trades_per_token_per_hour,
        pair_loss_cooldown_seconds, max_consecutive_losses_per_pair,
        volume_collapse_exit_enabled, volume_collapse_ratio_threshold, volume_collapse_consecutive_checks, volume_collapse_min_samples,
        liquidity_trend_guard_enabled, max_liquidity_drop_pct_30m, max_liquidity_drop_pct_1h, liquidity_trend_min_samples,
        rug_exit_enabled, rug_liquidity_floor_usd, rug_snapshot_stale_seconds, rug_pair_missing_threshold
      ) VALUES (
        $policy_version, $status, $created_at, $created_by, $linked_policy_id, $parent_policy_version, $notes, $changelog,
        $max_pair_age_seconds, $min_token_age_seconds, $min_liquidity_usd, $min_volume_1m_usd, $min_price_change_1m_pct, $min_volume_5m_usd, $min_buy_sell_ratio,
        $min_transactions_1m, $min_velocity_score_1m, $min_buy_pressure_1m,
        $min_buy_volume_1m_usd, $min_sell_volume_1m_usd,
        $require_no_mint_authority, $require_no_freeze_authority, $require_lp_lock, $max_top_holder_pct,
        $min_holder_count,
        $allowed_dexes,
        $weight_liquidity_velocity, $weight_liquidity_absolute, $weight_volume_1m, $weight_volume_5m, $weight_volume_acceleration_1m, $weight_price_volatility_5m, $weight_market_cap, $weight_buy_sell_slope_1m,
        $weight_velocity_score_1m, $weight_buy_pressure_1m, $weight_sell_pressure_1m,
        $weight_buy_volume_1m, $weight_sell_volume_1m,
        $weight_price_momentum_5m, $weight_holder_growth, $weight_holder_concentration_penalty,
        $weight_time_since_launch, $weight_pair_age_seconds, $min_trade_score, $priority_trade_score,
        $risk_per_trade_pct, $stop_loss_pct,
        $take_profit_pct,
        $max_trades_per_hour, $max_concurrent_trades, $cooldown_seconds_after_loss,
        $time_stop_seconds, $halt_on_liquidity_drop_pct, $cooldown_on_consecutive_losses, $cooldown_on_consecutive_losses_seconds,
        $halt_on_rug_detected, $allow_low_confidence_trades, $auto_optimize,
        $token_reentry_cooldown_seconds, $token_reentry_cooldown_seconds_after_win, $max_trades_per_token_per_hour,
        $pair_loss_cooldown_seconds, $max_consecutive_losses_per_pair,
        $volume_collapse_exit_enabled, $volume_collapse_ratio_threshold, $volume_collapse_consecutive_checks, $volume_collapse_min_samples,
        $liquidity_trend_guard_enabled, $max_liquidity_drop_pct_30m, $max_liquidity_drop_pct_1h, $liquidity_trend_min_samples,
        $rug_exit_enabled, $rug_liquidity_floor_usd, $rug_snapshot_stale_seconds, $rug_pair_missing_threshold
      )
    `);
        insert.run({
          policy_version: input.policy_version,
          status: input.status ?? 'draft',
          created_at: now,
          created_by: input.created_by,
          linked_policy_id: input.linked_policy_id ?? null,
          parent_policy_version: input.parent_policy_version ?? null,
          notes: input.notes ?? null,
          changelog: input.changelog ?? null,
          max_pair_age_seconds: input.max_pair_age_seconds ?? null,
          min_token_age_seconds: input.min_token_age_seconds ?? null,
          min_liquidity_usd: input.min_liquidity_usd ?? null,
          min_volume_1m_usd: input.min_volume_1m_usd ?? null,
          min_price_change_1m_pct: input.min_price_change_1m_pct ?? null,
          min_volume_5m_usd: input.min_volume_5m_usd ?? null,
          min_buy_sell_ratio: input.min_buy_sell_ratio ?? null,
          min_transactions_1m: input.min_transactions_1m ?? null,
          min_velocity_score_1m: input.min_velocity_score_1m ?? null,
          min_buy_pressure_1m: input.min_buy_pressure_1m ?? null,
          min_buy_volume_1m_usd: input.min_buy_volume_1m_usd ?? null,
          min_sell_volume_1m_usd: input.min_sell_volume_1m_usd ?? null,
          require_no_mint_authority: input.require_no_mint_authority !== undefined ? (input.require_no_mint_authority ? 1 : 0) : null,
          require_no_freeze_authority: input.require_no_freeze_authority !== undefined ? (input.require_no_freeze_authority ? 1 : 0) : null,
          require_lp_lock: input.require_lp_lock !== undefined ? (input.require_lp_lock ? 1 : 0) : 0,
          max_top_holder_pct: input.max_top_holder_pct ?? null,
          min_holder_count: input.min_holder_count ?? null,
          allowed_dexes: input.allowed_dexes ?? null,
          weight_liquidity_velocity: input.weight_liquidity_velocity ?? null,
          weight_liquidity_absolute: input.weight_liquidity_absolute ?? null,
          weight_volume_1m: input.weight_volume_1m ?? null,
          weight_volume_5m: input.weight_volume_5m ?? null,
          weight_volume_acceleration_1m: input.weight_volume_acceleration_1m ?? null,
          weight_price_volatility_5m: input.weight_price_volatility_5m ?? null,
          weight_market_cap: input.weight_market_cap ?? null,
          weight_buy_sell_slope_1m: input.weight_buy_sell_slope_1m ?? null,
          weight_velocity_score_1m: input.weight_velocity_score_1m ?? null,
          weight_buy_pressure_1m: input.weight_buy_pressure_1m ?? null,
          weight_sell_pressure_1m: input.weight_sell_pressure_1m ?? null,
          weight_buy_volume_1m: input.weight_buy_volume_1m ?? null,
          weight_sell_volume_1m: input.weight_sell_volume_1m ?? null,
          weight_price_momentum_5m: input.weight_price_momentum_5m ?? null,
          weight_holder_growth: input.weight_holder_growth ?? null,
          weight_holder_concentration_penalty: input.weight_holder_concentration_penalty ?? null,
          weight_time_since_launch: input.weight_time_since_launch ?? null,
          weight_pair_age_seconds: input.weight_pair_age_seconds ?? null,
          min_trade_score: input.min_trade_score ?? null,
          priority_trade_score: input.priority_trade_score ?? null,
          risk_per_trade_pct: input.risk_per_trade_pct ?? null,
          stop_loss_pct: input.stop_loss_pct ?? null,
          take_profit_pct: input.take_profit_pct ?? null,
          max_trades_per_hour: input.max_trades_per_hour ?? null,
          max_concurrent_trades: input.max_concurrent_trades ?? null,
          cooldown_seconds_after_loss: input.cooldown_seconds_after_loss ?? null,
          time_stop_seconds: input.time_stop_seconds ?? null,
          halt_on_liquidity_drop_pct: input.halt_on_liquidity_drop_pct ?? null,
          cooldown_on_consecutive_losses: input.cooldown_on_consecutive_losses ?? null,
          cooldown_on_consecutive_losses_seconds: input.cooldown_on_consecutive_losses_seconds ?? null,
          halt_on_rug_detected: input.halt_on_rug_detected !== undefined ? (input.halt_on_rug_detected ? 1 : 0) : null,
          allow_low_confidence_trades: input.allow_low_confidence_trades !== undefined ? (input.allow_low_confidence_trades ? 1 : 0) : null,
          auto_optimize: input.auto_optimize !== undefined ? (input.auto_optimize ? 1 : 0) : 0,
          token_reentry_cooldown_seconds: input.token_reentry_cooldown_seconds ?? null,
          token_reentry_cooldown_seconds_after_win: input.token_reentry_cooldown_seconds_after_win ?? null,
          max_trades_per_token_per_hour: input.max_trades_per_token_per_hour ?? null,
          pair_loss_cooldown_seconds: input.pair_loss_cooldown_seconds ?? null,
          max_consecutive_losses_per_pair: input.max_consecutive_losses_per_pair ?? null,
          volume_collapse_exit_enabled: input.volume_collapse_exit_enabled !== undefined ? (input.volume_collapse_exit_enabled ? 1 : 0) : null,
          volume_collapse_ratio_threshold: input.volume_collapse_ratio_threshold ?? null,
          volume_collapse_consecutive_checks: input.volume_collapse_consecutive_checks ?? null,
          volume_collapse_min_samples: input.volume_collapse_min_samples ?? null,
          liquidity_trend_guard_enabled: input.liquidity_trend_guard_enabled !== undefined ? (input.liquidity_trend_guard_enabled ? 1 : 0) : null,
          max_liquidity_drop_pct_30m: input.max_liquidity_drop_pct_30m ?? null,
          max_liquidity_drop_pct_1h: input.max_liquidity_drop_pct_1h ?? null,
          liquidity_trend_min_samples: input.liquidity_trend_min_samples ?? null,
          rug_exit_enabled: input.rug_exit_enabled !== undefined ? (input.rug_exit_enabled ? 1 : 0) : 1,
          rug_liquidity_floor_usd: input.rug_liquidity_floor_usd ?? null,
          rug_snapshot_stale_seconds: input.rug_snapshot_stale_seconds ?? null,
          rug_pair_missing_threshold: input.rug_pair_missing_threshold ?? 3,
        });
        const row = db.prepare('SELECT * FROM policies ORDER BY policy_id DESC LIMIT 1').get();
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, policy: row }),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[mcp-server] create_policy error:', msg);
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
    'update_policy',
    {
      description: 'Update an existing policy in the database',
      inputSchema: updatePolicyInputSchema,
    },
    async (input) => {
      try {
        const existing = db
          .prepare('SELECT policy_id, status FROM policies WHERE policy_id = $policyId')
          .get({ policyId: input.policy_id }) as { policy_id: number; status: string } | undefined;
        if (!existing) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Policy not found' }) }],
          };
        }
        if (existing.status !== 'draft') {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error:
                    'Cannot update policy with status active or retired. Editing will create a new draft version; use clone/create from this policy instead.',
                }),
              },
            ],
          };
        }
        const minAge = input.min_token_age_seconds !== undefined ? input.min_token_age_seconds ?? null : undefined;
        const maxAge = input.max_pair_age_seconds !== undefined ? input.max_pair_age_seconds ?? null : undefined;
        if (minAge != null && maxAge != null && minAge > maxAge) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'min_token_age_seconds must be <= max_pair_age_seconds when both are set' }) }],
          };
        }
        if (input.rug_exit_enabled === true && input.rug_snapshot_stale_seconds != null && input.rug_snapshot_stale_seconds < 30) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'When rug exit is enabled, rug_snapshot_stale_seconds must be >= 30' }) }],
          };
        }
        const now = Math.floor(Date.now() / 1000);
        const update = db.prepare(`
      UPDATE policies SET
        policy_version = $policy_version,
        status = $status,
        created_by = $created_by,
        linked_policy_id = $linked_policy_id,
        notes = $notes,
        changelog = $changelog,
        updated_at = $updated_at,
        max_pair_age_seconds = $max_pair_age_seconds,
        min_token_age_seconds = $min_token_age_seconds,
        min_liquidity_usd = $min_liquidity_usd,
        min_volume_1m_usd = $min_volume_1m_usd,
        min_price_change_1m_pct = $min_price_change_1m_pct,
        min_volume_5m_usd = $min_volume_5m_usd,
        min_buy_sell_ratio = $min_buy_sell_ratio,
        min_transactions_1m = $min_transactions_1m,
        min_velocity_score_1m = $min_velocity_score_1m,
        min_buy_pressure_1m = $min_buy_pressure_1m,
        min_buy_volume_1m_usd = $min_buy_volume_1m_usd,
        min_sell_volume_1m_usd = $min_sell_volume_1m_usd,
        require_no_mint_authority = $require_no_mint_authority,
        require_no_freeze_authority = $require_no_freeze_authority,
        require_lp_lock = $require_lp_lock,
        max_top_holder_pct = $max_top_holder_pct,
        min_holder_count = $min_holder_count,
        allowed_dexes = $allowed_dexes,
        weight_liquidity_velocity = $weight_liquidity_velocity,
        weight_liquidity_absolute = $weight_liquidity_absolute,
        weight_volume_1m = $weight_volume_1m,
        weight_volume_5m = $weight_volume_5m,
        weight_volume_acceleration_1m = $weight_volume_acceleration_1m,
        weight_price_volatility_5m = $weight_price_volatility_5m,
        weight_market_cap = $weight_market_cap,
        weight_buy_sell_slope_1m = $weight_buy_sell_slope_1m,
        weight_price_momentum_5m = $weight_price_momentum_5m,
        weight_holder_growth = $weight_holder_growth,
        weight_holder_concentration_penalty = $weight_holder_concentration_penalty,
        weight_time_since_launch = $weight_time_since_launch,
        weight_pair_age_seconds = $weight_pair_age_seconds,
        weight_velocity_score_1m = $weight_velocity_score_1m,
        weight_buy_pressure_1m = $weight_buy_pressure_1m,
        weight_sell_pressure_1m = $weight_sell_pressure_1m,
        weight_buy_volume_1m = $weight_buy_volume_1m,
        weight_sell_volume_1m = $weight_sell_volume_1m,
        min_trade_score = $min_trade_score,
        priority_trade_score = $priority_trade_score,
        risk_per_trade_pct = $risk_per_trade_pct,
        stop_loss_pct = $stop_loss_pct,
        take_profit_pct = $take_profit_pct,
        max_trades_per_hour = $max_trades_per_hour,
        max_concurrent_trades = $max_concurrent_trades,
        cooldown_seconds_after_loss = $cooldown_seconds_after_loss,
        time_stop_seconds = $time_stop_seconds,
        halt_on_liquidity_drop_pct = $halt_on_liquidity_drop_pct,
        cooldown_on_consecutive_losses = $cooldown_on_consecutive_losses,
        cooldown_on_consecutive_losses_seconds = $cooldown_on_consecutive_losses_seconds,
        halt_on_rug_detected = $halt_on_rug_detected,
        allow_low_confidence_trades = $allow_low_confidence_trades,
        auto_optimize = $auto_optimize,
        token_reentry_cooldown_seconds = $token_reentry_cooldown_seconds,
        token_reentry_cooldown_seconds_after_win = $token_reentry_cooldown_seconds_after_win,
        max_trades_per_token_per_hour = $max_trades_per_token_per_hour,
        pair_loss_cooldown_seconds = $pair_loss_cooldown_seconds,
        max_consecutive_losses_per_pair = $max_consecutive_losses_per_pair,
        volume_collapse_exit_enabled = $volume_collapse_exit_enabled,
        volume_collapse_ratio_threshold = $volume_collapse_ratio_threshold,
        volume_collapse_consecutive_checks = $volume_collapse_consecutive_checks,
        volume_collapse_min_samples = $volume_collapse_min_samples,
        liquidity_trend_guard_enabled = $liquidity_trend_guard_enabled,
        max_liquidity_drop_pct_30m = $max_liquidity_drop_pct_30m,
        max_liquidity_drop_pct_1h = $max_liquidity_drop_pct_1h,
        liquidity_trend_min_samples = $liquidity_trend_min_samples,
        rug_exit_enabled = $rug_exit_enabled,
        rug_liquidity_floor_usd = $rug_liquidity_floor_usd,
        rug_snapshot_stale_seconds = $rug_snapshot_stale_seconds,
        rug_pair_missing_threshold = $rug_pair_missing_threshold
      WHERE policy_id = $policy_id
      `);
        const r = input.require_no_mint_authority;
        const f = input.require_no_freeze_authority;
        const lp = input.require_lp_lock;
        const rug = input.halt_on_rug_detected;
        const low = input.allow_low_confidence_trades;
        update.run({
          policy_version: input.policy_version ?? '',
          status: input.status ?? 'draft',
          created_by: input.created_by ?? 'human',
          linked_policy_id: input.linked_policy_id !== undefined ? input.linked_policy_id : null,
          notes: input.notes ?? null,
          changelog: input.changelog ?? null,
          updated_at: now,
          max_pair_age_seconds: input.max_pair_age_seconds ?? null,
          min_token_age_seconds: input.min_token_age_seconds ?? null,
          min_liquidity_usd: input.min_liquidity_usd ?? null,
          min_volume_1m_usd: input.min_volume_1m_usd ?? null,
          min_price_change_1m_pct: input.min_price_change_1m_pct ?? null,
          min_volume_5m_usd: input.min_volume_5m_usd ?? null,
          min_buy_sell_ratio: input.min_buy_sell_ratio ?? null,
          min_transactions_1m: input.min_transactions_1m ?? null,
          min_velocity_score_1m: input.min_velocity_score_1m ?? null,
          min_buy_pressure_1m: input.min_buy_pressure_1m ?? null,
          min_buy_volume_1m_usd: input.min_buy_volume_1m_usd ?? null,
          min_sell_volume_1m_usd: input.min_sell_volume_1m_usd ?? null,
          require_no_mint_authority: r !== undefined ? (r ? 1 : 0) : 0,
          require_no_freeze_authority: f !== undefined ? (f ? 1 : 0) : 0,
          require_lp_lock: lp !== undefined ? (lp ? 1 : 0) : 0,
          max_top_holder_pct: input.max_top_holder_pct ?? null,
          min_holder_count: input.min_holder_count ?? null,
          allowed_dexes: input.allowed_dexes ?? null,
          weight_liquidity_velocity: input.weight_liquidity_velocity ?? null,
          weight_liquidity_absolute: input.weight_liquidity_absolute ?? null,
          weight_volume_1m: input.weight_volume_1m ?? null,
          weight_volume_5m: input.weight_volume_5m ?? null,
          weight_volume_acceleration_1m: input.weight_volume_acceleration_1m ?? null,
          weight_price_volatility_5m: input.weight_price_volatility_5m ?? null,
          weight_market_cap: input.weight_market_cap ?? null,
          weight_buy_sell_slope_1m: input.weight_buy_sell_slope_1m ?? null,
          weight_price_momentum_5m: input.weight_price_momentum_5m ?? null,
          weight_holder_growth: input.weight_holder_growth ?? null,
          weight_holder_concentration_penalty: input.weight_holder_concentration_penalty ?? null,
          weight_time_since_launch: input.weight_time_since_launch ?? null,
          weight_pair_age_seconds: input.weight_pair_age_seconds ?? null,
          weight_velocity_score_1m: input.weight_velocity_score_1m ?? null,
          weight_buy_pressure_1m: input.weight_buy_pressure_1m ?? null,
          weight_sell_pressure_1m: input.weight_sell_pressure_1m ?? null,
          weight_buy_volume_1m: input.weight_buy_volume_1m ?? null,
          weight_sell_volume_1m: input.weight_sell_volume_1m ?? null,
          min_trade_score: input.min_trade_score ?? null,
          priority_trade_score: input.priority_trade_score ?? null,
          risk_per_trade_pct: input.risk_per_trade_pct ?? null,
          stop_loss_pct: input.stop_loss_pct ?? null,
          take_profit_pct: input.take_profit_pct ?? null,
          max_trades_per_hour: input.max_trades_per_hour ?? null,
          max_concurrent_trades: input.max_concurrent_trades ?? null,
          cooldown_seconds_after_loss: input.cooldown_seconds_after_loss ?? null,
          time_stop_seconds: input.time_stop_seconds ?? null,
          halt_on_liquidity_drop_pct: input.halt_on_liquidity_drop_pct ?? null,
          cooldown_on_consecutive_losses: input.cooldown_on_consecutive_losses ?? null,
          cooldown_on_consecutive_losses_seconds: input.cooldown_on_consecutive_losses_seconds ?? null,
          halt_on_rug_detected: rug !== undefined ? (rug ? 1 : 0) : 0,
          allow_low_confidence_trades: low !== undefined ? (low ? 1 : 0) : 0,
          auto_optimize: input.auto_optimize !== undefined ? (input.auto_optimize ? 1 : 0) : 0,
          token_reentry_cooldown_seconds: input.token_reentry_cooldown_seconds ?? null,
          token_reentry_cooldown_seconds_after_win: input.token_reentry_cooldown_seconds_after_win ?? null,
          max_trades_per_token_per_hour: input.max_trades_per_token_per_hour ?? null,
          pair_loss_cooldown_seconds: input.pair_loss_cooldown_seconds ?? null,
          max_consecutive_losses_per_pair: input.max_consecutive_losses_per_pair ?? null,
          volume_collapse_exit_enabled: input.volume_collapse_exit_enabled !== undefined ? (input.volume_collapse_exit_enabled ? 1 : 0) : null,
          volume_collapse_ratio_threshold: input.volume_collapse_ratio_threshold ?? null,
          volume_collapse_consecutive_checks: input.volume_collapse_consecutive_checks ?? null,
          volume_collapse_min_samples: input.volume_collapse_min_samples ?? null,
          liquidity_trend_guard_enabled: input.liquidity_trend_guard_enabled !== undefined ? (input.liquidity_trend_guard_enabled ? 1 : 0) : null,
          max_liquidity_drop_pct_30m: input.max_liquidity_drop_pct_30m ?? null,
          max_liquidity_drop_pct_1h: input.max_liquidity_drop_pct_1h ?? null,
          liquidity_trend_min_samples: input.liquidity_trend_min_samples ?? null,
          rug_exit_enabled: input.rug_exit_enabled !== undefined ? (input.rug_exit_enabled ? 1 : 0) : null,
          rug_liquidity_floor_usd: input.rug_liquidity_floor_usd ?? null,
          rug_snapshot_stale_seconds: input.rug_snapshot_stale_seconds ?? null,
          rug_pair_missing_threshold: input.rug_pair_missing_threshold ?? null,
          policy_id: input.policy_id,
        });
        const row = db.prepare('SELECT * FROM policies WHERE policy_id = $policyId').get({ policyId: input.policy_id });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, policy: row }),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[mcp-server] update_policy error:', msg);
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
    'activate_policy',
    {
      description:
        'Activate a draft policy. Allowed only when status is draft. Sets status to active and activated_at to now.',
      inputSchema: z.object({ policy_id: intPositive() }),
    },
    async (input) => {
      try {
        const row = db
          .prepare('SELECT policy_id, policy_version, status FROM policies WHERE policy_id = $policy_id')
          .get({ policy_id: input.policy_id }) as { policy_id: number; policy_version: string; status: string } | undefined;
        if (!row) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Policy not found' }) }],
          };
        }
        if (row.status !== 'draft') {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: `Policy can only be activated when status is draft (current: ${row.status})`,
                }),
              },
            ],
          };
        }
        const fullRow = db.prepare('SELECT linked_policy_id FROM policies WHERE policy_id = $policy_id').get({
          policy_id: input.policy_id,
        }) as { linked_policy_id: number | null } | undefined;
        if (fullRow?.linked_policy_id != null) {
          const linked = db
            .prepare('SELECT policy_id, policy_version, status FROM policies WHERE policy_id = $policy_id')
            .get({ policy_id: fullRow.linked_policy_id }) as { policy_id: number; policy_version: string; status: string } | undefined;
          if (linked?.status === 'active') {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: JSON.stringify({
                    success: false,
                    error: `Cannot activate: linked policy "${linked.policy_version}" (ID: ${linked.policy_id}) is still active. Retire it first.`,
                  }),
                },
              ],
            };
          }
        }
        const now = Math.floor(Date.now() / 1000);
        db.prepare('UPDATE policies SET status = $status, activated_at = $activatedAt WHERE policy_id = $policyId').run({
          status: 'active',
          activatedAt: now,
          policyId: input.policy_id,
        });
        const updated = db
          .prepare('SELECT * FROM policies WHERE policy_id = $policyId')
          .get({ policyId: input.policy_id });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, policy: updated }) }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[mcp-server] activate_policy error:', msg);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }],
        };
      }
    }
  );

  server.registerTool(
    'retire_policy',
    {
      description:
        'Retire an active policy. Sets status to retired and retired_at to now, then deactivates all deployments of that policy (sets is_active = 0). Execution stops using the policy and its deployments immediately; historical data remains intact.',
      inputSchema: z.object({ policy_id: intPositive() }),
    },
    async (input) => {
      try {
        const row = db
          .prepare('SELECT policy_id, policy_version, status FROM policies WHERE policy_id = $policy_id')
          .get({ policy_id: input.policy_id }) as { policy_id: number; policy_version: string; status: string } | undefined;
        if (!row) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Policy not found' }) }],
          };
        }
        const now = Math.floor(Date.now() / 1000);
        const policyIdStr = String(input.policy_id);
        let deploymentsDeactivated = 0;
        db.transaction(() => {
          db.prepare('UPDATE policies SET status = $status, retired_at = $retired_at WHERE policy_id = $policy_id').run({
            status: 'retired',
            retired_at: now,
            policy_id: input.policy_id,
          });
          const result = db.prepare('UPDATE policy_deployments SET is_active = 0 WHERE policy_id = $policyId').run({
            policyId: policyIdStr,
          });
          deploymentsDeactivated = result.changes;
        })();
        const updated = db.prepare('SELECT * FROM policies WHERE policy_id = $policy_id').get({ policy_id: input.policy_id });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ success: true, policy: updated, deployments_deactivated: deploymentsDeactivated }),
            },
          ],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[mcp-server] retire_policy error:', msg);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }],
        };
      }
    }
  );

  server.registerTool(
    'rollback_policy',
    {
      description:
        'Retire the current active policy and re-activate a previously retired policy. Makes experimentation reversible.',
      inputSchema: z.object({
        policy_version: z.string(),
      }),
    },
    async ({ policy_version }) => {
      try {
        const target = db.prepare('SELECT policy_id, policy_version, status FROM policies WHERE policy_version = $policy_version').get({ policy_version }) as { policy_id: number; policy_version: string; status: string } | undefined;
        if (!target) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Policy not found' }) }],
          };
        }
        if (target.status !== 'retired') {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Policy must be retired to rollback to it' }) }],
          };
        }
        const now = Math.floor(Date.now() / 1000);
        const activeRow = db.prepare("SELECT policy_id, policy_version FROM policies WHERE status = 'active' LIMIT 1").get() as { policy_id: number; policy_version: string } | undefined;
        if (!activeRow) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'No active policy to retire' }) }],
          };
        }
        db.transaction(() => {
          db.prepare(`UPDATE policies SET status = 'retired', retired_at = $retired_at, retired_reason = 'rollback' WHERE status = 'active'`).run({ retired_at: now });
          db.prepare('UPDATE policy_deployments SET is_active = 0 WHERE policy_id = $policyId').run({ policyId: String(activeRow.policy_id) });
          db.prepare(`UPDATE policies SET status = 'active', activated_at = $activated_at WHERE policy_version = $policy_version`).run({ activated_at: now, policy_version });
        })();
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ success: true, activated_policy_version: policy_version, retired_policy_version: activeRow.policy_version }),
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[mcp-server] rollback_policy error:', msg);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }],
        };
      }
    }
  );

  server.registerTool(
    'list_pair_scores',
    {
      description: 'List pair scores from the database',
      inputSchema: z.object({
        limit: defaultNum(100, { min: 1, max: 500 }),
        offset: defaultNum(0, { min: 0 }),
        signal: z.optional(z.enum(['NO_TRADE', 'WATCH', 'TRADE_CANDIDATE', 'PRIORITY_TRADE'])),
        eligible: z.optional(z.boolean()),
        dex: z.optional(z.string()),
        policy_version: z.optional(z.string()),
        pair_address: z.optional(z.string()),
      }),
    },
    async ({ limit, offset, signal, eligible, dex, policy_version, pair_address }) => {
      let sql = `SELECT ps.id, ps.pair_address, p.dex, ps.chain, ps.scored_at, ps.policy_version,
      ps.eligible, ps.reject_reason, ps.reject_stage,
      ps.total_score, ps.score_normalized, ps.signal, ps.confidence_level,
      ps.feature_values, ps.feature_weights, ps.feature_contributions, ps.penalty_contributions,
      ps.snapshot_ids, ps.snapshot_window_seconds,
      ps.missing_feature_count, ps.missing_features, ps.used_fallback_values, ps.data_quality_score,
      ps.worker_version, ps.run_id, ps.notes,
      p.base_symbol, p.quote_symbol
      FROM pair_scores ps
      LEFT JOIN pairs p ON p.pair_address = ps.pair_address`;
      const params: Record<string, unknown> = { limit, offset };
      const where: string[] = [];

      if (policy_version != null && policy_version.trim().length > 0) {
        where.push('ps.policy_version = $listPolicyVersion');
        params.listPolicyVersion = policy_version.trim();
      }

      if (dex != null && dex.trim().length > 0) {
        where.push("COALESCE(p.dex, '') = $listDex");
        params.listDex = dex.trim();
      }

      if (pair_address != null && pair_address.trim().length > 0) {
        const p = pair_address.trim();
        where.push('ps.pair_address LIKE $listPairAddressPattern');
        params.listPairAddressPattern = p.includes('%') ? p : p + '%';
      }

      if (signal != null) {
        where.push('ps.signal = $listSignal');
        params.listSignal = signal;
      }
      if (eligible !== undefined) {
        where.push('ps.eligible = $listEligible');
        params.listEligible = eligible ? 1 : 0;
      }
      if (where.length) {
        sql += ' WHERE ' + where.join(' AND ');
      }
      sql += ' ORDER BY ps.scored_at DESC LIMIT $limit OFFSET $offset';

      const scores = db.prepare(sql).all(params);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(scores, null, 2),
          },
        ],
      };
    }
  );
}
