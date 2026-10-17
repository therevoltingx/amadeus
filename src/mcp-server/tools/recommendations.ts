import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../../db.js';
import { z, strMin1, intPositive, numOptionalNullable, defaultNum } from '../schema.js';
import { createRecommendation } from '../../recommendations.js';
import {
  RECOMMENDATION_SCOPES,
  RECOMMENDATION_SOURCES,
  RECOMMENDATION_TYPES,
  RECOMMENDATION_STATUSES,
  NEW_POLICY_RECOMMENDATION_BASE,
} from '../../types/recommendation.js';

const POLICY_PAYLOAD_KEYS = new Set([
  'max_pair_age_seconds', 'min_token_age_seconds', 'min_liquidity_usd', 'min_volume_1m_usd', 'min_price_change_1m_pct', 'min_volume_5m_usd', 'min_buy_sell_ratio',
  'min_transactions_1m', 'min_velocity_score_1m', 'min_buy_pressure_1m',
  'min_buy_volume_1m_usd', 'min_sell_volume_1m_usd',
  'require_no_mint_authority', 'require_no_freeze_authority', 'require_lp_lock', 'max_top_holder_pct', 'min_holder_count',
  'allowed_dexes', 'weight_liquidity_velocity', 'weight_liquidity_absolute', 'weight_volume_1m', 'weight_volume_5m', 'weight_volume_acceleration_1m', 'weight_price_volatility_5m', 'weight_market_cap', 'weight_buy_sell_slope_1m',
  'weight_velocity_score_1m', 'weight_buy_pressure_1m', 'weight_sell_pressure_1m',
  'weight_buy_volume_1m', 'weight_sell_volume_1m',
  'weight_price_momentum_5m', 'weight_holder_growth', 'weight_holder_concentration_penalty', 'weight_time_since_launch', 'weight_pair_age_seconds',
  'min_trade_score', 'priority_trade_score', 'risk_per_trade_pct', 'stop_loss_pct',
  'take_profit_pct',
  'max_trades_per_hour', 'max_concurrent_trades', 'cooldown_seconds_after_loss', 'time_stop_seconds',
  'halt_on_liquidity_drop_pct', 'cooldown_on_consecutive_losses', 'cooldown_on_consecutive_losses_seconds',
  'halt_on_rug_detected', 'allow_low_confidence_trades', 'token_reentry_cooldown_seconds',
  'token_reentry_cooldown_seconds_after_win', 'max_trades_per_token_per_hour', 'pair_loss_cooldown_seconds',
  'max_consecutive_losses_per_pair',   'liquidity_trend_guard_enabled', 'max_liquidity_drop_pct_30m', 'max_liquidity_drop_pct_1h', 'liquidity_trend_min_samples', 'notes',
]);

/**
 * Clone deployments from the old (replaced) policy to the new policy and deactivate the old deployments.
 * Call inside an existing db.transaction. Uses named parameters for all SQL.
 */
function cloneDeploymentsFromReplacedPolicy(oldPolicyId: number, newPolicyId: number, now: number): void {
  const oldIdStr = String(oldPolicyId);
  const newIdStr = String(newPolicyId);
  const rows = db.prepare(
    `SELECT account_id FROM policy_deployments WHERE policy_id = $policyId`
  ).all({ policyId: oldIdStr }) as { account_id: string }[];
  const insertDeployment = db.prepare(`
    INSERT OR IGNORE INTO policy_deployments (id, policy_id, account_id, is_active, created_at)
    VALUES ($id, $policyId, $accountId, 1, $now)
  `);
  for (const row of rows) {
    const id = `applied-${newPolicyId}-${row.account_id}`;
    insertDeployment.run({ id, policyId: newIdStr, accountId: row.account_id, now });
  }
  db.prepare(`UPDATE policy_deployments SET is_active = 0 WHERE policy_id = $policyId`).run({ policyId: oldIdStr });
}

export function registerRecommendationsTools(server: McpServer): void {
  server.registerTool(
    'create_recommendation',
    {
      description:
        'Create an advisory recommendation (policy improvement suggestion). Does not change any policy; recommendations are advisory only. For **policy_variant** and **new_policy**, optional **name** is the proposed **new policy_version** (same string as in the new changelog `## [version] - date` block). Use recommendation_type "new_policy" with a payload containing policy_version and any policy fields to recommend a brand-new policy; policy_version can be omitted for new_policy (stored as __new__).',
      inputSchema: z.object({
        policy_version: z.optional(z.string()),
        scope: z.enum(RECOMMENDATION_SCOPES as unknown as [string, ...string[]]),
        source: z.enum(RECOMMENDATION_SOURCES as unknown as [string, ...string[]]),
        source_id: z.optional(z.nullable(z.string())),
        recommendation_type: z.enum(RECOMMENDATION_TYPES as unknown as [string, ...string[]]),
        payload: z.record(z.string(), z.unknown()),
        confidence: numOptionalNullable({ min: 0, max: 1 }),
        rationale: z.optional(z.nullable(z.string())),
        changelog: z.optional(z.nullable(z.string())),
        name: z.optional(z.nullable(z.string())),
      }),
    },
    async (input) => {
      const recType = input.recommendation_type as 'policy_variant' | 'new_policy' | 'warning' | 'suggestion';
      if (recType !== 'new_policy' && (input.policy_version == null || input.policy_version.trim() === '')) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'policy_version is required when recommendation_type is not new_policy' }) }],
        };
      }
      const id = createRecommendation({
        policyVersion: input.policy_version?.trim() || undefined,
        scope: input.scope as 'policy' | 'account' | 'global',
        source: input.source as 'agent' | 'human' | 'system',
        sourceId: input.source_id ?? null,
        recommendationType: recType,
        payload: input.payload,
        confidence: input.confidence ?? null,
        rationale: input.rationale ?? null,
        changelog: input.changelog ?? null,
        name: input.name ?? null,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, id }) }],
      };
    }
  );

  server.registerTool(
    'list_recommendations',
    {
      description: 'List recommendations (advisory policy-improvement suggestions). Filter by policy_version, status. By default archived recommendations are excluded; set include_archived to true to show them.',
      inputSchema: z.object({
        limit: defaultNum(100, { min: 1, max: 500 }),
        offset: defaultNum(0, { min: 0 }),
        policy_version: z.optional(z.string()),
        status: z.optional(z.enum(RECOMMENDATION_STATUSES as unknown as [string, ...string[]])),
        include_archived: z.optional(z.boolean()),
      }),
    },
    async ({ limit, offset, policy_version, status, include_archived }) => {
      const where: string[] = [];
      const params: Record<string, string | number> = { limit, offset };
      if (policy_version != null && policy_version.trim().length > 0) {
        where.push('policy_version = $policy_version');
        params.policy_version = policy_version.trim();
      }
      if (status != null) {
        where.push('status = $status');
        params.status = status;
      }
      if (!include_archived) {
        where.push('(archived = 0 OR archived IS NULL)');
      }
      const whereClause = where.length > 0 ? ' WHERE ' + where.join(' AND ') : '';
      const rows = db
        .prepare(
          `SELECT id, policy_version, scope, source, source_id, recommendation_type, payload, confidence, status, rationale, changelog, name, created_at, applied_policy_version, archived, archived_at
           FROM recommendations${whereClause} ORDER BY created_at DESC LIMIT $limit OFFSET $offset`
        )
        .all(params) as {
        id: number;
        policy_version: string;
        scope: string;
        source: string;
        source_id: string | null;
        recommendation_type: string;
        payload: string;
        confidence: number | null;
        status: string;
        rationale: string | null;
        changelog: string | null;
        name: string | null;
        created_at: number;
        applied_policy_version: string | null;
        archived: number | null;
        archived_at: number | null;
      }[];
      const out = rows.map((r) => ({
        ...r,
        payload: JSON.parse(r.payload) as Record<string, unknown>,
        archived: r.archived === 1,
        archived_at: r.archived_at ?? null,
      }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }],
      };
    }
  );

  server.registerTool(
    'archive_recommendation',
    {
      description: 'Archive an accepted or rejected recommendation so it is hidden from the default list. Only recommendations with status "accepted" or "rejected" can be archived. Archived recommendations can be shown again by listing with include_archived: true.',
      inputSchema: z.object({
        id: intPositive(),
      }),
    },
    async ({ id }) => {
      const row = db.prepare('SELECT id, status FROM recommendations WHERE id = $id').get({ id }) as { id: number; status: string } | undefined;
      if (!row) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Recommendation not found' }) }],
        };
      }
      if (row.status !== 'accepted' && row.status !== 'rejected') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Only accepted or rejected recommendations can be archived' }) }],
        };
      }
      const now = Math.floor(Date.now() / 1000);
      db.prepare('UPDATE recommendations SET archived = 1, archived_at = $archived_at WHERE id = $id').run({ archived_at: now, id });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, id, archived_at: now }) }],
      };
    }
  );

  server.registerTool(
    'update_recommendation_status',
    {
      description:
        'Set recommendation status to accepted or rejected. Does not modify policies; acceptance only marks as approved for future action.',
      inputSchema: z.object({
        id: intPositive(),
        status: z.enum(['accepted', 'rejected']),
      }),
    },
    async ({ id, status }) => {
      const result = db.prepare('UPDATE recommendations SET status = $status WHERE id = $id').run({ status, id }) as { changes: number };
      if (result.changes === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Recommendation not found' }) }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, id, status }) }],
      };
    }
  );

  server.registerTool(
    'update_recommendation_name',
    {
      description:
        'Set or clear the **name** of a pending recommendation: for policy_variant/new_policy this is the proposed **new policy_version** (must match changelog heading). Humans edit this in the UI before applying.',
      inputSchema: z.object({
        id: intPositive(),
        name: z.optional(z.nullable(z.string())),
      }),
    },
    async ({ id, name }) => {
      const row = db.prepare('SELECT id, status FROM recommendations WHERE id = $id').get({ id }) as
        | { id: number; status: string }
        | undefined;
      if (!row) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Recommendation not found' }) }],
        };
      }
      if (row.status !== 'pending') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Only pending recommendations can be renamed' }) }],
        };
      }
      const trimmed = name != null && String(name).trim() !== '' ? String(name).trim() : null;
      db.prepare('UPDATE recommendations SET name = $name WHERE id = $id').run({ name: trimmed, id });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: true, id, name: trimmed }) }],
      };
    }
  );

  server.registerTool(
    'accept_policy_recommendation',
    {
      description:
        'Accept a pending policy_variant or new_policy recommendation. For policy_variant: clone the active policy, apply the recommended changes, activate the new policy, and retire the old one. For new_policy: create a brand-new policy from the recommendation payload (payload must include policy_version and any policy fields), then activate it and retire the current active policy if any. Optional new_policy_version overrides the policy name (for both types).',
      inputSchema: z.object({
        recommendation_id: intPositive(),
        new_policy_version: z.optional(strMin1()),
      }),
    },
    async ({ recommendation_id, new_policy_version: userVersion }) => {
      try {
        const rec = db.prepare(
          `SELECT id, policy_version, recommendation_type, status, payload, rationale, changelog, source FROM recommendations WHERE id = $id`
        ).get({ id: recommendation_id }) as {
          id: number;
          policy_version: string;
          recommendation_type: string;
          status: string;
          payload: string;
          rationale: string | null;
          changelog: string | null;
          source: string;
        } | undefined;
        if (!rec) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Recommendation not found' }) }],
          };
        }
        if (rec.status !== 'pending') {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Recommendation status must be pending' }) }],
          };
        }
        if (rec.recommendation_type !== 'policy_variant' && rec.recommendation_type !== 'new_policy') {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Only policy_variant or new_policy recommendations can be accepted with this tool' }) }],
          };
        }
        let payload: Record<string, unknown>;
        try {
          payload = typeof rec.payload === 'string' ? JSON.parse(rec.payload) : (rec.payload as Record<string, unknown>);
        } catch {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Invalid recommendation payload JSON' }) }],
          };
        }

        const now = Math.floor(Date.now() / 1000);
        const createdBy = (rec.source === 'agent' || rec.source === 'human' || rec.source === 'system' ? rec.source : 'human') as 'agent' | 'human' | 'system';
        const b = (v: unknown) => (v === true || v === 1 ? 1 : 0);

        if (rec.recommendation_type === 'new_policy') {
          const pvFromPayload = payload.policy_version;
          const newPolicyVersion =
            (userVersion != null && userVersion.trim().length > 0)
              ? userVersion.trim()
              : (typeof pvFromPayload === 'string' && pvFromPayload.trim() !== ''
                ? pvFromPayload.trim()
                : `recommendation-${rec.id}`);
          const existing = db.prepare(`SELECT 1 FROM policies WHERE policy_version = $policy_version`).get({ policy_version: newPolicyVersion });
          if (existing) {
            return {
              isError: true,
              content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `Policy version "${newPolicyVersion}" already exists` }) }],
            };
          }
          const changeReason = (rec.rationale ?? 'accepted_new_policy_recommendation').slice(0, 500);
          const base: Record<string, unknown> = {};
          for (const k of POLICY_PAYLOAD_KEYS) {
            if (payload[k] !== undefined) base[k] = payload[k];
          }
          base.policy_version = newPolicyVersion;
          base.notes = base.notes ?? null;
          base.parent_policy_version = null;
          base.created_from_policy_version = null;

          const previousActiveForLink = db.prepare("SELECT policy_id FROM policies WHERE status = 'active' LIMIT 1").get() as { policy_id: number } | undefined;
          const linkedPolicyIdNew = previousActiveForLink?.policy_id ?? null;
          const recommendationChangelog = rec.changelog ?? null;
          const insertStmt = db.prepare(`
          INSERT INTO policies (
            policy_version, status, created_at, created_by, linked_policy_id, parent_policy_version, notes, changelog,
            max_pair_age_seconds, min_token_age_seconds, min_liquidity_usd, min_volume_1m_usd, min_price_change_1m_pct, min_volume_5m_usd, min_buy_sell_ratio,
            require_no_mint_authority, require_no_freeze_authority, require_lp_lock, max_top_holder_pct, min_holder_count,
            allowed_dexes,
            weight_liquidity_velocity, weight_liquidity_absolute, weight_volume_1m, weight_volume_5m, weight_volume_acceleration_1m, weight_price_volatility_5m, weight_market_cap, weight_buy_sell_slope_1m,
            weight_price_momentum_5m, weight_holder_growth, weight_holder_concentration_penalty, weight_time_since_launch, min_trade_score, priority_trade_score,
            risk_per_trade_pct, stop_loss_pct, take_profit_pct,
            max_trades_per_hour, max_concurrent_trades, cooldown_seconds_after_loss, time_stop_seconds, halt_on_liquidity_drop_pct, cooldown_on_consecutive_losses, cooldown_on_consecutive_losses_seconds,
            halt_on_rug_detected, allow_low_confidence_trades, token_reentry_cooldown_seconds, token_reentry_cooldown_seconds_after_win, max_trades_per_token_per_hour,
            pair_loss_cooldown_seconds, max_consecutive_losses_per_pair,
            liquidity_trend_guard_enabled, max_liquidity_drop_pct_30m, max_liquidity_drop_pct_1h, liquidity_trend_min_samples,
            created_from_policy_version, source_recommendation_id, change_reason
          ) VALUES (
            $policy_version, $status, $created_at, $created_by, $linked_policy_id, $parent_policy_version, $notes, $changelog,
            $max_pair_age_seconds, $min_token_age_seconds, $min_liquidity_usd, $min_volume_1m_usd, $min_price_change_1m_pct, $min_volume_5m_usd, $min_buy_sell_ratio,
            $require_no_mint_authority, $require_no_freeze_authority, $require_lp_lock, $max_top_holder_pct, $min_holder_count,
            $allowed_dexes,
            $weight_liquidity_velocity, $weight_liquidity_absolute, $weight_volume_1m, $weight_volume_5m, $weight_volume_acceleration_1m, $weight_price_volatility_5m, $weight_market_cap, $weight_buy_sell_slope_1m,
            $weight_price_momentum_5m, $weight_holder_growth, $weight_holder_concentration_penalty, $weight_time_since_launch, $min_trade_score, $priority_trade_score,
            $risk_per_trade_pct, $stop_loss_pct, $take_profit_pct,
            $max_trades_per_hour, $max_concurrent_trades, $cooldown_seconds_after_loss, $time_stop_seconds, $halt_on_liquidity_drop_pct, $cooldown_on_consecutive_losses, $cooldown_on_consecutive_losses_seconds,
            $halt_on_rug_detected, $allow_low_confidence_trades, $token_reentry_cooldown_seconds, $token_reentry_cooldown_seconds_after_win, $max_trades_per_token_per_hour,
            $pair_loss_cooldown_seconds, $max_consecutive_losses_per_pair,
            $liquidity_trend_guard_enabled, $max_liquidity_drop_pct_30m, $max_liquidity_drop_pct_1h, $liquidity_trend_min_samples,
            $created_from_policy_version, $source_recommendation_id, $change_reason
          )
        `);
          db.transaction(() => {
            insertStmt.run({
              policy_version: newPolicyVersion,
              status: 'draft',
              created_at: now,
              created_by: createdBy,
              linked_policy_id: linkedPolicyIdNew,
              parent_policy_version: null,
              notes: base.notes ?? null,
              changelog: recommendationChangelog,
              max_pair_age_seconds: base.max_pair_age_seconds ?? null,
              min_token_age_seconds: base.min_token_age_seconds ?? null,
              min_liquidity_usd: base.min_liquidity_usd ?? null,
              min_volume_1m_usd: base.min_volume_1m_usd ?? null,
              min_price_change_1m_pct: base.min_price_change_1m_pct ?? null,
              min_volume_5m_usd: base.min_volume_5m_usd ?? null,
              min_buy_sell_ratio: base.min_buy_sell_ratio ?? null,
              require_no_mint_authority: b(base.require_no_mint_authority),
              require_no_freeze_authority: b(base.require_no_freeze_authority),
              require_lp_lock: b(base.require_lp_lock),
              max_top_holder_pct: base.max_top_holder_pct ?? null,
              min_holder_count: base.min_holder_count ?? null,
              allowed_dexes: base.allowed_dexes ?? null,
              weight_liquidity_velocity: base.weight_liquidity_velocity ?? null,
              weight_liquidity_absolute: base.weight_liquidity_absolute ?? null,
              weight_volume_1m: base.weight_volume_1m ?? null,
              weight_volume_5m: base.weight_volume_5m ?? null,
              weight_volume_acceleration_1m: base.weight_volume_acceleration_1m ?? null,
              weight_price_volatility_5m: base.weight_price_volatility_5m ?? null,
              weight_market_cap: base.weight_market_cap ?? null,
              weight_buy_sell_slope_1m: base.weight_buy_sell_slope_1m ?? null,
              weight_price_momentum_5m: base.weight_price_momentum_5m ?? null,
              weight_holder_growth: base.weight_holder_growth ?? null,
              weight_holder_concentration_penalty: base.weight_holder_concentration_penalty ?? null,
              weight_time_since_launch: base.weight_time_since_launch ?? null,
              min_trade_score: base.min_trade_score ?? null,
              priority_trade_score: base.priority_trade_score ?? null,
              risk_per_trade_pct: base.risk_per_trade_pct ?? null,
              stop_loss_pct: base.stop_loss_pct ?? null,
              take_profit_pct: base.take_profit_pct ?? base.take_profit_1_pct ?? null,
              max_trades_per_hour: base.max_trades_per_hour ?? null,
              max_concurrent_trades: base.max_concurrent_trades ?? null,
              cooldown_seconds_after_loss: base.cooldown_seconds_after_loss ?? null,
              time_stop_seconds: base.time_stop_seconds ?? null,
              halt_on_liquidity_drop_pct: base.halt_on_liquidity_drop_pct ?? null,
              cooldown_on_consecutive_losses: base.cooldown_on_consecutive_losses ?? null,
              cooldown_on_consecutive_losses_seconds: base.cooldown_on_consecutive_losses_seconds ?? null,
              halt_on_rug_detected: b(base.halt_on_rug_detected),
              allow_low_confidence_trades: b(base.allow_low_confidence_trades),
              token_reentry_cooldown_seconds: base.token_reentry_cooldown_seconds ?? null,
              token_reentry_cooldown_seconds_after_win: base.token_reentry_cooldown_seconds_after_win ?? null,
              max_trades_per_token_per_hour: base.max_trades_per_token_per_hour ?? null,
              pair_loss_cooldown_seconds: base.pair_loss_cooldown_seconds ?? null,
              max_consecutive_losses_per_pair: base.max_consecutive_losses_per_pair ?? null,
              liquidity_trend_guard_enabled: base.liquidity_trend_guard_enabled !== undefined ? (base.liquidity_trend_guard_enabled ? 1 : 0) : null,
              max_liquidity_drop_pct_30m: base.max_liquidity_drop_pct_30m ?? null,
              max_liquidity_drop_pct_1h: base.max_liquidity_drop_pct_1h ?? null,
              liquidity_trend_min_samples: base.liquidity_trend_min_samples ?? null,
              created_from_policy_version: null,
              source_recommendation_id: rec.id,
              change_reason: changeReason,
            });
            const previousActive = db.prepare("SELECT policy_version FROM policies WHERE status = 'active' LIMIT 1").get() as { policy_version: string } | undefined;
            if (previousActive) {
              db.prepare(`UPDATE policies SET status = 'retired', retired_at = $retired_at, retired_reason = 'superseded_by_recommendation' WHERE policy_version = $policy_version`).run({ retired_at: now, policy_version: previousActive.policy_version });
            }
            db.prepare(`UPDATE policies SET status = 'active', activated_at = $activated_at WHERE policy_version = $policy_version`).run({ activated_at: now, policy_version: newPolicyVersion });
            db.prepare(`UPDATE recommendations SET status = 'accepted', applied_policy_version = $applied_policy_version WHERE id = $id`).run({ applied_policy_version: newPolicyVersion, id: rec.id });
            const newPolicyRow = db.prepare(`SELECT policy_id FROM policies WHERE policy_version = $policy_version`).get({ policy_version: newPolicyVersion }) as { policy_id: number };
            if (previousActiveForLink != null && newPolicyRow != null) {
              cloneDeploymentsFromReplacedPolicy(previousActiveForLink.policy_id, newPolicyRow.policy_id, now);
            }
          })();
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({ new_policy_version: newPolicyVersion, created_from: 'new_policy_recommendation' }),
            }],
          };
        }

        const overrides: Record<string, unknown> = {};
        if (payload.parameter != null && payload.proposed_value !== undefined) {
          const key = String(payload.parameter);
          if (POLICY_PAYLOAD_KEYS.has(key)) overrides[key] = payload.proposed_value;
        } else {
          for (const k of Object.keys(payload)) {
            if (POLICY_PAYLOAD_KEYS.has(k)) overrides[k] = payload[k];
          }
        }

        const oldPolicy = db.prepare(
          `SELECT * FROM policies WHERE policy_version = $policy_version AND status = 'active'`
        ).get({ policy_version: rec.policy_version }) as Record<string, unknown> | undefined;
        if (!oldPolicy) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Active policy not found for this recommendation' }) }],
          };
        }

        const defaultVersion = rec.policy_version === NEW_POLICY_RECOMMENDATION_BASE
          ? `recommendation-${rec.id}`
          : `${rec.policy_version}-applied-${rec.id}`;
        const newPolicyVersion = (userVersion != null && userVersion.trim().length > 0)
          ? userVersion.trim()
          : defaultVersion;
        const existing = db.prepare(`SELECT 1 FROM policies WHERE policy_version = $policy_version`).get({ policy_version: newPolicyVersion });
        if (existing) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `Policy version "${newPolicyVersion}" already exists` }) }],
          };
        }
        const changeReason = (rec.rationale ?? 'accepted_recommendation').slice(0, 500);

        const insertStmt = db.prepare(`
          INSERT INTO policies (
            policy_version, status, created_at, created_by, linked_policy_id, parent_policy_version, notes, changelog,
            max_pair_age_seconds, min_token_age_seconds, min_liquidity_usd, min_volume_1m_usd, min_price_change_1m_pct, min_volume_5m_usd, min_buy_sell_ratio,
            require_no_mint_authority, require_no_freeze_authority, require_lp_lock, max_top_holder_pct, min_holder_count,
            allowed_dexes,
            weight_liquidity_velocity, weight_liquidity_absolute, weight_volume_1m, weight_volume_5m, weight_volume_acceleration_1m, weight_price_volatility_5m, weight_market_cap, weight_buy_sell_slope_1m,
            weight_price_momentum_5m, weight_holder_growth, weight_holder_concentration_penalty, weight_time_since_launch, min_trade_score, priority_trade_score,
            risk_per_trade_pct, stop_loss_pct, take_profit_pct,
            max_trades_per_hour, max_concurrent_trades, cooldown_seconds_after_loss, time_stop_seconds, halt_on_liquidity_drop_pct, cooldown_on_consecutive_losses, cooldown_on_consecutive_losses_seconds,
            halt_on_rug_detected, allow_low_confidence_trades, token_reentry_cooldown_seconds, token_reentry_cooldown_seconds_after_win, max_trades_per_token_per_hour,
            pair_loss_cooldown_seconds, max_consecutive_losses_per_pair,
            liquidity_trend_guard_enabled, max_liquidity_drop_pct_30m, max_liquidity_drop_pct_1h, liquidity_trend_min_samples,
            created_from_policy_version, source_recommendation_id, change_reason
          ) VALUES (
            $policy_version, $status, $created_at, $created_by, $linked_policy_id, $parent_policy_version, $notes, $changelog,
            $max_pair_age_seconds, $min_token_age_seconds, $min_liquidity_usd, $min_volume_1m_usd, $min_price_change_1m_pct, $min_volume_5m_usd, $min_buy_sell_ratio,
            $require_no_mint_authority, $require_no_freeze_authority, $require_lp_lock, $max_top_holder_pct, $min_holder_count,
            $allowed_dexes,
            $weight_liquidity_velocity, $weight_liquidity_absolute, $weight_volume_1m, $weight_volume_5m, $weight_volume_acceleration_1m, $weight_price_volatility_5m, $weight_market_cap, $weight_buy_sell_slope_1m,
            $weight_price_momentum_5m, $weight_holder_growth, $weight_holder_concentration_penalty, $weight_time_since_launch, $min_trade_score, $priority_trade_score,
            $risk_per_trade_pct, $stop_loss_pct, $take_profit_pct,
            $max_trades_per_hour, $max_concurrent_trades, $cooldown_seconds_after_loss, $time_stop_seconds, $halt_on_liquidity_drop_pct, $cooldown_on_consecutive_losses, $cooldown_on_consecutive_losses_seconds,
            $halt_on_rug_detected, $allow_low_confidence_trades, $token_reentry_cooldown_seconds, $token_reentry_cooldown_seconds_after_win, $max_trades_per_token_per_hour,
            $pair_loss_cooldown_seconds, $max_consecutive_losses_per_pair,
            $liquidity_trend_guard_enabled, $max_liquidity_drop_pct_30m, $max_liquidity_drop_pct_1h, $liquidity_trend_min_samples,
            $created_from_policy_version, $source_recommendation_id, $change_reason
          )
        `);

        const linkedPolicyIdVariant = oldPolicy.policy_id as number;
        const clone: Record<string, unknown> = { ...oldPolicy, ...overrides };
        clone.policy_version = newPolicyVersion;
        clone.status = 'draft';
        clone.created_at = now;
        clone.parent_policy_version = rec.policy_version;
        clone.activated_at = null;
        clone.retired_at = null;
        clone.retired_reason = null;
        clone.created_from_policy_version = rec.policy_version;
        clone.source_recommendation_id = rec.id;
        clone.change_reason = changeReason;

        const recCl = rec.changelog != null ? String(rec.changelog).trim() : '';
        const oldCl =
          clone.changelog != null && clone.changelog !== ''
            ? String(clone.changelog).trim()
            : '';
        const recommendationChangelogVariant = recCl !== '' ? rec.changelog : oldCl !== '' ? oldCl : null;

        db.transaction(() => {
          insertStmt.run({
            policy_version: clone.policy_version as string,
            status: 'draft',
            created_at: now,
            created_by: createdBy,
            linked_policy_id: linkedPolicyIdVariant,
            parent_policy_version: rec.policy_version,
            notes: clone.notes ?? null,
            changelog: recommendationChangelogVariant,
            max_pair_age_seconds: clone.max_pair_age_seconds ?? null,
            min_token_age_seconds: clone.min_token_age_seconds ?? null,
            min_liquidity_usd: clone.min_liquidity_usd ?? null,
            min_volume_1m_usd: clone.min_volume_1m_usd ?? null,
            min_price_change_1m_pct: clone.min_price_change_1m_pct ?? null,
            min_volume_5m_usd: clone.min_volume_5m_usd ?? null,
            min_buy_sell_ratio: clone.min_buy_sell_ratio ?? null,
            require_no_mint_authority: b(clone.require_no_mint_authority),
            require_no_freeze_authority: b(clone.require_no_freeze_authority),
            require_lp_lock: b(clone.require_lp_lock),
            max_top_holder_pct: clone.max_top_holder_pct ?? null,
            min_holder_count: clone.min_holder_count ?? null,
            allowed_dexes: clone.allowed_dexes ?? null,
            weight_liquidity_velocity: clone.weight_liquidity_velocity ?? null,
            weight_liquidity_absolute: clone.weight_liquidity_absolute ?? null,
            weight_volume_1m: clone.weight_volume_1m ?? null,
            weight_volume_5m: clone.weight_volume_5m ?? null,
            weight_volume_acceleration_1m: clone.weight_volume_acceleration_1m ?? null,
            weight_price_volatility_5m: clone.weight_price_volatility_5m ?? null,
            weight_market_cap: clone.weight_market_cap ?? null,
            weight_buy_sell_slope_1m: clone.weight_buy_sell_slope_1m ?? null,
            weight_price_momentum_5m: clone.weight_price_momentum_5m ?? null,
            weight_holder_growth: clone.weight_holder_growth ?? null,
            weight_holder_concentration_penalty: clone.weight_holder_concentration_penalty ?? null,
            weight_time_since_launch: clone.weight_time_since_launch ?? null,
            min_trade_score: clone.min_trade_score ?? null,
            priority_trade_score: clone.priority_trade_score ?? null,
            risk_per_trade_pct: clone.risk_per_trade_pct ?? null,
            stop_loss_pct: clone.stop_loss_pct ?? null,
            take_profit_pct: clone.take_profit_pct ?? clone.take_profit_1_pct ?? null,
            max_trades_per_hour: clone.max_trades_per_hour ?? null,
            max_concurrent_trades: clone.max_concurrent_trades ?? null,
            cooldown_seconds_after_loss: clone.cooldown_seconds_after_loss ?? null,
            time_stop_seconds: clone.time_stop_seconds ?? null,
            halt_on_liquidity_drop_pct: clone.halt_on_liquidity_drop_pct ?? null,
            cooldown_on_consecutive_losses: clone.cooldown_on_consecutive_losses ?? null,
            cooldown_on_consecutive_losses_seconds: clone.cooldown_on_consecutive_losses_seconds ?? null,
            halt_on_rug_detected: b(clone.halt_on_rug_detected),
            allow_low_confidence_trades: b(clone.allow_low_confidence_trades),
            token_reentry_cooldown_seconds: clone.token_reentry_cooldown_seconds ?? null,
            token_reentry_cooldown_seconds_after_win: clone.token_reentry_cooldown_seconds_after_win ?? null,
            max_trades_per_token_per_hour: clone.max_trades_per_token_per_hour ?? null,
            pair_loss_cooldown_seconds: clone.pair_loss_cooldown_seconds ?? null,
            max_consecutive_losses_per_pair: clone.max_consecutive_losses_per_pair ?? null,
            liquidity_trend_guard_enabled: clone.liquidity_trend_guard_enabled !== undefined ? (clone.liquidity_trend_guard_enabled ? 1 : 0) : null,
            max_liquidity_drop_pct_30m: clone.max_liquidity_drop_pct_30m ?? null,
            max_liquidity_drop_pct_1h: clone.max_liquidity_drop_pct_1h ?? null,
            liquidity_trend_min_samples: clone.liquidity_trend_min_samples ?? null,
            created_from_policy_version: rec.policy_version,
            source_recommendation_id: rec.id,
            change_reason: changeReason,
          });
          db.prepare(`UPDATE policies SET status = 'active', activated_at = $activated_at WHERE policy_version = $policy_version`).run({ activated_at: now, policy_version: newPolicyVersion });
          db.prepare(`UPDATE policies SET status = 'retired', retired_at = $retired_at, retired_reason = 'superseded_by_recommendation' WHERE policy_version = $policy_version`).run({ retired_at: now, policy_version: rec.policy_version });
          db.prepare(`UPDATE recommendations SET status = 'accepted', applied_policy_version = $applied_policy_version WHERE id = $id`).run({ applied_policy_version: newPolicyVersion, id: rec.id });
          const newPolicyRow = db.prepare(`SELECT policy_id FROM policies WHERE policy_version = $policy_version`).get({ policy_version: newPolicyVersion }) as { policy_id: number };
          if (newPolicyRow != null) {
            cloneDeploymentsFromReplacedPolicy(linkedPolicyIdVariant, newPolicyRow.policy_id, now);
          }
        })();

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ new_policy_version: newPolicyVersion, retired_policy_version: rec.policy_version }),
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[mcp-server] accept_policy_recommendation error:', msg);
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: msg }) }],
        };
      }
    }
  );
}
