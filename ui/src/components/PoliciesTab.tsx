import { useState, useEffect, useCallback, useRef } from 'react';
import { useMcpClient } from '../hooks/useMcpClient';
import './PoliciesTab.css';

// New policy form: only status defaults to 'draft'; all other fields empty/null
const INITIAL_FORM = {
  policy_version: '',
  status: 'draft' as const,
  created_by: 'human' as const,
  linked_policy_id: null as number | null,
  notes: '',
  changelog: '',
  auto_optimize: false,
  max_pair_age_seconds: null as number | null,
  min_token_age_seconds: null as number | null,
  min_liquidity_usd: null as number | null,
  min_volume_1m_usd: null as number | null,
  min_price_change_1m_pct: null as number | null,
  min_volume_5m_usd: null as number | null,
  min_buy_sell_ratio: null as number | null,
  min_transactions_1m: null as number | null,
  min_velocity_score_1m: null as number | null,
  min_buy_pressure_1m: null as number | null,
  min_buy_volume_1m_usd: null as number | null,
  min_sell_volume_1m_usd: null as number | null,
  require_no_mint_authority: false,
  require_no_freeze_authority: false,
  require_lp_lock: false,
  max_top_holder_pct: null as number | null,
  min_holder_count: null as number | null,
  allowed_dexes: '',
  weight_liquidity_velocity: null as number | null,
  weight_liquidity_absolute: null as number | null,
  weight_volume_1m: null as number | null,
  weight_volume_5m: null as number | null,
  weight_volume_acceleration_1m: null as number | null,
  weight_price_volatility_5m: null as number | null,
  weight_market_cap: null as number | null,
  weight_buy_sell_slope_1m: null as number | null,
  weight_velocity_score_1m: null as number | null,
  weight_buy_pressure_1m: null as number | null,
  weight_sell_pressure_1m: null as number | null,
  weight_buy_volume_1m: null as number | null,
  weight_sell_volume_1m: null as number | null,
  weight_price_momentum_5m: null as number | null,
  weight_holder_growth: null as number | null,
  weight_holder_concentration_penalty: null as number | null,
  weight_time_since_launch: null as number | null,
  weight_pair_age_seconds: null as number | null,
  min_trade_score: null as number | null,
  priority_trade_score: null as number | null,
  max_trades_per_hour: null as number | null,
  max_concurrent_trades: null as number | null,
  cooldown_seconds_after_loss: null as number | null,
  risk_per_trade_pct: null as number | null,
  stop_loss_pct: null as number | null,
  take_profit_pct: null as number | null,
  time_stop_seconds: null as number | null,
  halt_on_liquidity_drop_pct: null as number | null,
  cooldown_on_consecutive_losses: null as number | null,
  cooldown_on_consecutive_losses_seconds: null as number | null,
  halt_on_rug_detected: false,
  allow_low_confidence_trades: false,
  token_reentry_cooldown_seconds: null as number | null,
  token_reentry_cooldown_seconds_after_win: null as number | null,
  max_trades_per_token_per_hour: null as number | null,
  pair_loss_cooldown_seconds: null as number | null,
  max_consecutive_losses_per_pair: null as number | null,
  volume_collapse_exit_enabled: false,
  volume_collapse_ratio_threshold: null as number | null,
  volume_collapse_consecutive_checks: null as number | null,
  volume_collapse_min_samples: null as number | null,
  liquidity_trend_guard_enabled: false,
  max_liquidity_drop_pct_30m: null as number | null,
  max_liquidity_drop_pct_1h: null as number | null,
  liquidity_trend_min_samples: null as number | null,
  rug_exit_enabled: true,
  rug_liquidity_floor_usd: null as number | null,
  rug_snapshot_stale_seconds: null as number | null,
  rug_pair_missing_threshold: 3 as number | null,
};

// Allow numeric fields to hold string while typing (e.g. "-" for negative)
type FormState = {
  [K in keyof typeof INITIAL_FORM]: (typeof INITIAL_FORM)[K] extends number
    ? number | string | null
    : (typeof INITIAL_FORM)[K] extends number | null
      ? number | string | null
      : (typeof INITIAL_FORM)[K];
};

function toNumericInputValue(raw: string, emptyValue: number | null): number | string | null {
  if (raw === '') return emptyValue;
  const n = Number(raw);
  if (!isNaN(n)) return n;
  return raw; // allow "-" or "-5." etc while typing
}

function parseNumericFormValue(v: number | string | null | undefined): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'number') return isNaN(v) ? undefined : v;
  const n = Number(v);
  return isNaN(n) ? undefined : n;
}

/** Keys from policies/policy_format.md (form/MCP schema only). Excludes read-only/system fields. */
const POLICY_FORMAT_KEYS = new Set([
  'policy_version', 'status', 'created_by', 'linked_policy_id', 'notes', 'changelog', 'auto_optimize',
  'max_pair_age_seconds', 'min_token_age_seconds', 'min_liquidity_usd', 'min_volume_1m_usd', 'min_price_change_1m_pct', 'min_volume_5m_usd',
  'min_buy_sell_ratio', 'min_transactions_1m', 'min_velocity_score_1m', 'min_buy_pressure_1m', 'min_buy_volume_1m_usd', 'min_sell_volume_1m_usd',
  'max_top_holder_pct', 'min_holder_count',
  'liquidity_trend_guard_enabled', 'max_liquidity_drop_pct_30m', 'max_liquidity_drop_pct_1h', 'liquidity_trend_min_samples',
  'allowed_dexes',
  'weight_liquidity_velocity', 'weight_liquidity_absolute', 'weight_volume_1m', 'weight_volume_5m', 'weight_volume_acceleration_1m',
  'weight_price_volatility_5m', 'weight_market_cap', 'weight_buy_sell_slope_1m', 'weight_velocity_score_1m',
  'weight_buy_pressure_1m', 'weight_sell_pressure_1m', 'weight_buy_volume_1m', 'weight_sell_volume_1m', 'weight_price_momentum_5m',
  'weight_holder_growth', 'weight_holder_concentration_penalty', 'weight_time_since_launch', 'weight_pair_age_seconds',
  'min_trade_score', 'priority_trade_score',
  'risk_per_trade_pct', 'stop_loss_pct', 'take_profit_pct', 'time_stop_seconds',
  'volume_collapse_exit_enabled', 'volume_collapse_ratio_threshold', 'volume_collapse_consecutive_checks', 'volume_collapse_min_samples',
  'rug_exit_enabled', 'rug_liquidity_floor_usd', 'rug_snapshot_stale_seconds', 'rug_pair_missing_threshold',
  'max_trades_per_hour', 'max_concurrent_trades', 'cooldown_seconds_after_loss', 'cooldown_on_consecutive_losses', 'cooldown_on_consecutive_losses_seconds',
  'token_reentry_cooldown_seconds', 'token_reentry_cooldown_seconds_after_win', 'max_trades_per_token_per_hour', 'pair_loss_cooldown_seconds', 'max_consecutive_losses_per_pair',
  'halt_on_liquidity_drop_pct', 'require_no_mint_authority', 'require_no_freeze_authority', 'require_lp_lock', 'halt_on_rug_detected', 'allow_low_confidence_trades',
]);

function exportPolicyFormatOnly(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    if (POLICY_FORMAT_KEYS.has(key)) out[key] = row[key];
  }
  return out;
}

/** Section order and table format matching policies/policy_format.md (no Read-only section). */
const POLICY_MD_SECTIONS: { title: string; fields: string[]; threeCol?: boolean }[] = [
  { title: 'Metadata (top of form)', fields: ['policy_version', 'status', 'created_by', 'linked_policy_id', 'notes', 'changelog', 'auto_optimize'] },
  { title: 'Entry filters', fields: ['max_pair_age_seconds', 'min_token_age_seconds', 'min_liquidity_usd', 'min_volume_1m_usd', 'min_price_change_1m_pct', 'min_volume_5m_usd', 'min_buy_sell_ratio', 'min_transactions_1m', 'min_velocity_score_1m', 'min_buy_pressure_1m', 'min_buy_volume_1m_usd', 'min_sell_volume_1m_usd', 'max_top_holder_pct', 'min_holder_count'] },
  { title: 'Liquidity Trend Guard', fields: ['liquidity_trend_guard_enabled', 'max_liquidity_drop_pct_30m', 'max_liquidity_drop_pct_1h', 'liquidity_trend_min_samples'], threeCol: true },
  { title: 'Allowed DEXes', fields: ['allowed_dexes'] },
  { title: 'Scoring weights', fields: ['weight_liquidity_velocity', 'weight_liquidity_absolute', 'weight_volume_1m', 'weight_volume_5m', 'weight_volume_acceleration_1m', 'weight_price_volatility_5m', 'weight_market_cap', 'weight_buy_sell_slope_1m', 'weight_velocity_score_1m', 'weight_buy_pressure_1m', 'weight_sell_pressure_1m', 'weight_buy_volume_1m', 'weight_sell_volume_1m', 'weight_price_momentum_5m', 'weight_holder_growth', 'weight_holder_concentration_penalty', 'weight_time_since_launch', 'weight_pair_age_seconds'] },
  { title: 'Score Thresholds', fields: ['min_trade_score', 'priority_trade_score'] },
  { title: 'Risk', fields: ['risk_per_trade_pct', 'stop_loss_pct', 'take_profit_pct', 'time_stop_seconds'] },
  { title: 'Volume Collapse Exit', fields: ['volume_collapse_exit_enabled', 'volume_collapse_ratio_threshold', 'volume_collapse_consecutive_checks', 'volume_collapse_min_samples'], threeCol: true },
  { title: 'Rug Protection', fields: ['rug_exit_enabled', 'rug_liquidity_floor_usd', 'rug_snapshot_stale_seconds', 'rug_pair_missing_threshold'], threeCol: true },
  { title: 'Limits', fields: ['max_trades_per_hour', 'max_concurrent_trades', 'cooldown_seconds_after_loss', 'cooldown_on_consecutive_losses', 'cooldown_on_consecutive_losses_seconds'] },
  { title: 'Token Execution Controls', fields: ['token_reentry_cooldown_seconds', 'token_reentry_cooldown_seconds_after_win', 'max_trades_per_token_per_hour', 'pair_loss_cooldown_seconds', 'max_consecutive_losses_per_pair'] },
  { title: 'Safety & Kill Switches', fields: ['halt_on_liquidity_drop_pct', 'require_no_mint_authority', 'require_no_freeze_authority', 'require_lp_lock', 'halt_on_rug_detected', 'allow_low_confidence_trades'] },
];

/** Convert policy format object to YAML matching policies/policy_format.yaml (flat key-value with section comments). */
function policyToYaml(data: Record<string, unknown>, policyTitle: string): string {
  const boolKeys = new Set([
    'liquidity_trend_guard_enabled', 'volume_collapse_exit_enabled', 'rug_exit_enabled',
    'require_no_mint_authority', 'require_no_freeze_authority', 'require_lp_lock', 'halt_on_rug_detected', 'allow_low_confidence_trades', 'auto_optimize',
  ]);
  const norm = (k: string, v: unknown): unknown =>
    boolKeys.has(k) && (v === 0 || v === 1) ? v === 1 : v;

  const yamlValue = (v: unknown): string => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return String(v);
    const s = String(v);
    if (s.includes('\n') || s.includes(':') || s.includes('#') || s.includes('"') || /^\s|\s$/.test(s)) return JSON.stringify(s);
    return s;
  };

  const lines: string[] = [];
  lines.push('# ' + policyTitle);
  lines.push('');
  for (const section of POLICY_MD_SECTIONS) {
    const present = section.fields.filter((f) => f in data);
    if (present.length === 0) continue;
    lines.push('# --- ' + section.title + ' ---');
    for (const f of present) {
      const v = norm(f, data[f]);
      const yv = yamlValue(v);
      lines.push(f + ': ' + yv);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

/** Parse policy YAML (policy_format.yaml style): flat key-value pairs, optional # comments. */
function parsePolicyYaml(content: string): Partial<FormState> {
  const result: Record<string, unknown> = {};
  const lines = content.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([a-z_][a-z0-9_]*)\s*:\s*(.*)$/i);
    if (!match) continue;
    const field = match[1];
    let raw = match[2].trim();
    const commentIdx = raw.indexOf(' #');
    if (commentIdx >= 0) raw = raw.slice(0, commentIdx).trim();
    if (!(field in INITIAL_FORM)) continue;

    if (raw.startsWith('"') && raw.length > 1) {
      const end = raw.indexOf('"', 1);
      raw = end >= 0 ? raw.slice(1, end) : raw.slice(1);
    } else if (raw.startsWith("'") && raw.length > 1) {
      const end = raw.indexOf("'", 1);
      raw = end >= 0 ? raw.slice(1, end) : raw.slice(1);
    }

    let value: string | number | boolean | null;
    if (raw === '' || raw === 'null') value = null;
    else if (raw === 'true') value = true;
    else if (raw === 'false') value = false;
    else if (/^-?\d*\.?\d+$/.test(raw)) value = Number(raw);
    else value = raw;

    const key = field as keyof FormState;
    const initial = INITIAL_FORM[key];
    if (typeof initial === 'boolean' && typeof value === 'boolean') result[key] = value;
    else if (typeof initial === 'boolean' && (value === 'true' || value === 'false')) result[key] = value === 'true';
    else if ((initial === null || typeof initial === 'number') && (value === null || typeof value === 'number')) result[key] = value;
    else if (typeof initial === 'number' && value === null) result[key] = null;
    else if (typeof initial === 'string' && typeof value === 'string') result[key] = value;
    else if (value === null) result[key] = null;
    else if (typeof value === 'number' && (initial === null || typeof initial === 'number')) result[key] = value;
    else if (typeof value === 'string') result[key] = value;
  }

  return result as Partial<FormState>;
}

function policyToFormData(p: Policy): FormState {
  const dex = (v: string | null) =>
    v ?? 'raydium,orca';
  const num = (n: number | null | undefined, def: number) =>
    n != null ? n : def;
  const numOrNull = (n: number | null | undefined) =>
    n != null ? n : null;
  const status = (p.status === 'draft' || p.status === 'active' || p.status === 'retired') ? p.status : 'active';
  const createdBy = (p.created_by === 'agent' || p.created_by === 'human') ? p.created_by : 'human';
  return {
    policy_version: p.policy_version ?? '1.0',
    status,
    created_by: createdBy,
    linked_policy_id: numOrNull(p.linked_policy_id),
    notes: p.notes ?? '',
    changelog: p.changelog ?? '',
    auto_optimize: p.auto_optimize === 1,
    max_pair_age_seconds: num(p.max_pair_age_seconds, 1200),
    min_token_age_seconds: numOrNull(p.min_token_age_seconds),
    min_liquidity_usd: numOrNull(p.min_liquidity_usd),
    min_volume_1m_usd: numOrNull(p.min_volume_1m_usd),
    min_price_change_1m_pct: numOrNull(p.min_price_change_1m_pct),
    min_volume_5m_usd: numOrNull(p.min_volume_5m_usd),
    min_buy_sell_ratio: num(p.min_buy_sell_ratio, 1.1),
    min_transactions_1m: numOrNull(p.min_transactions_1m),
    min_velocity_score_1m: numOrNull(p.min_velocity_score_1m),
    min_buy_pressure_1m: numOrNull(p.min_buy_pressure_1m),
    min_buy_volume_1m_usd: numOrNull(p.min_buy_volume_1m_usd),
    min_sell_volume_1m_usd: numOrNull(p.min_sell_volume_1m_usd),
    require_no_mint_authority: p.require_no_mint_authority === 1,
    require_no_freeze_authority: p.require_no_freeze_authority === 1,
    require_lp_lock: p.require_lp_lock === 1,
    max_top_holder_pct: num(p.max_top_holder_pct, 40),
    min_holder_count: numOrNull(p.min_holder_count),
    allowed_dexes: dex(p.allowed_dexes),
    weight_liquidity_velocity: num(p.weight_liquidity_velocity, 0.30),
    weight_liquidity_absolute: num(p.weight_liquidity_absolute, 0),
    weight_volume_1m: num(p.weight_volume_1m, 0),
    weight_volume_5m: num(p.weight_volume_5m, 0),
    weight_volume_acceleration_1m: num(p.weight_volume_acceleration_1m, 0.30),
    weight_price_volatility_5m: num(p.weight_price_volatility_5m, 0),
    weight_market_cap: num(p.weight_market_cap, 0),
    weight_buy_sell_slope_1m: num(p.weight_buy_sell_slope_1m, 0.20),
    weight_velocity_score_1m: num(p.weight_velocity_score_1m, 0),
    weight_buy_pressure_1m: num(p.weight_buy_pressure_1m, 0),
    weight_sell_pressure_1m: num(p.weight_sell_pressure_1m, 0),
    weight_buy_volume_1m: num(p.weight_buy_volume_1m, 0),
    weight_sell_volume_1m: num(p.weight_sell_volume_1m, 0),
    weight_price_momentum_5m: num(p.weight_price_momentum_5m, 0.10),
    weight_holder_growth: num(p.weight_holder_growth, 0),
    weight_holder_concentration_penalty: num(p.weight_holder_concentration_penalty, -0.40),
    weight_time_since_launch: num(p.weight_time_since_launch, 0),
    weight_pair_age_seconds: num(p.weight_pair_age_seconds, 0),
    min_trade_score: num(p.min_trade_score, 70),
    priority_trade_score: num(p.priority_trade_score, 85),
    max_trades_per_hour: num(p.max_trades_per_hour, 2),
    max_concurrent_trades: num(p.max_concurrent_trades, 2),
    cooldown_seconds_after_loss: num(p.cooldown_seconds_after_loss, 900),
    risk_per_trade_pct: num(p.risk_per_trade_pct, 5),
    stop_loss_pct: num(p.stop_loss_pct, -20),
    take_profit_pct: num(p.take_profit_pct, 25),
    time_stop_seconds: num(p.time_stop_seconds, 600),
    halt_on_liquidity_drop_pct: numOrNull(p.halt_on_liquidity_drop_pct),
    cooldown_on_consecutive_losses: num(p.cooldown_on_consecutive_losses, 0),
    cooldown_on_consecutive_losses_seconds: numOrNull(p.cooldown_on_consecutive_losses_seconds),
    halt_on_rug_detected: p.halt_on_rug_detected === 1,
    allow_low_confidence_trades: p.allow_low_confidence_trades === 1,
    token_reentry_cooldown_seconds: num(p.token_reentry_cooldown_seconds, 0),
    token_reentry_cooldown_seconds_after_win: numOrNull(p.token_reentry_cooldown_seconds_after_win),
    max_trades_per_token_per_hour: numOrNull(p.max_trades_per_token_per_hour),
    pair_loss_cooldown_seconds: numOrNull(p.pair_loss_cooldown_seconds),
    max_consecutive_losses_per_pair: numOrNull(p.max_consecutive_losses_per_pair),
    volume_collapse_exit_enabled: p.volume_collapse_exit_enabled === 1,
    volume_collapse_ratio_threshold: numOrNull(p.volume_collapse_ratio_threshold),
    volume_collapse_consecutive_checks: numOrNull(p.volume_collapse_consecutive_checks),
    volume_collapse_min_samples: numOrNull(p.volume_collapse_min_samples),
    liquidity_trend_guard_enabled: p.liquidity_trend_guard_enabled === 1,
    max_liquidity_drop_pct_30m: numOrNull(p.max_liquidity_drop_pct_30m),
    max_liquidity_drop_pct_1h: numOrNull(p.max_liquidity_drop_pct_1h),
    liquidity_trend_min_samples: numOrNull(p.liquidity_trend_min_samples),
    rug_exit_enabled: p.rug_exit_enabled !== 0,
    rug_liquidity_floor_usd: numOrNull(p.rug_liquidity_floor_usd),
    rug_snapshot_stale_seconds: numOrNull(p.rug_snapshot_stale_seconds),
    rug_pair_missing_threshold: numOrNull(p.rug_pair_missing_threshold) ?? 3,
  } as FormState;
}

export interface Policy {
  policy_id: number;
  policy_version: string;
  status: string;
  created_at: number;
  updated_at?: number | null;
  activated_at: number | null;
  retired_at: number | null;
  retired_reason?: string | null;
  created_by: string;
  linked_policy_id?: number | null;
  parent_policy_version?: string | null;
  created_from_policy_version?: string | null;
  source_recommendation_id?: number | null;
  change_reason?: string | null;
  notes: string | null;
  changelog?: string | null;
  auto_optimize?: number | null;
  max_pair_age_seconds: number | null;
  min_token_age_seconds?: number | null;
  min_liquidity_usd: number | null;
  min_volume_1m_usd: number | null;
  min_price_change_1m_pct?: number | null;
  min_volume_5m_usd: number | null;
  min_buy_sell_ratio: number | null;
  min_transactions_1m?: number | null;
  min_velocity_score_1m?: number | null;
  min_buy_pressure_1m?: number | null;
  min_buy_volume_1m_usd?: number | null;
  min_sell_volume_1m_usd?: number | null;
  require_no_mint_authority: number | null;
  require_no_freeze_authority: number | null;
  require_lp_lock: number | null;
  max_top_holder_pct: number | null;
  min_holder_count: number | null;
  allowed_dexes: string | null;
  weight_liquidity_velocity?: number | null;
  weight_liquidity_absolute?: number | null;
  weight_volume_1m?: number | null;
  weight_volume_5m?: number | null;
  weight_volume_acceleration_1m?: number | null;
  weight_price_volatility_5m?: number | null;
  weight_market_cap?: number | null;
  weight_holder_growth?: number | null;
  weight_time_since_launch?: number | null;
  weight_pair_age_seconds?: number | null;
  weight_buy_sell_slope_1m?: number | null;
  weight_velocity_score_1m?: number | null;
  weight_buy_pressure_1m?: number | null;
  weight_sell_pressure_1m?: number | null;
  weight_buy_volume_1m?: number | null;
  weight_sell_volume_1m?: number | null;
  weight_price_momentum_5m?: number | null;
  weight_holder_concentration_penalty?: number | null;
  min_trade_score: number | null;
  priority_trade_score: number | null;
  max_trades_per_hour: number | null;
  max_concurrent_trades: number | null;
  cooldown_seconds_after_loss: number | null;
  risk_per_trade_pct: number | null;
  stop_loss_pct: number | null;
  take_profit_pct: number | null;
  time_stop_seconds: number | null;
  halt_on_liquidity_drop_pct: number | null;
  cooldown_on_consecutive_losses: number | null;
  cooldown_on_consecutive_losses_seconds: number | null;
  halt_on_consecutive_losses?: number | null;
  halt_on_rug_detected: number | null;
  policy_cooldown_until?: number | null;
  consecutive_loss_count?: number | null;
  allow_low_confidence_trades: number | null;
  token_reentry_cooldown_seconds: number | null;
  token_reentry_cooldown_seconds_after_win: number | null;
  max_trades_per_token_per_hour: number | null;
  pair_loss_cooldown_seconds: number | null;
  max_consecutive_losses_per_pair: number | null;
  volume_collapse_exit_enabled?: number | null;
  volume_collapse_ratio_threshold?: number | null;
  volume_collapse_consecutive_checks?: number | null;
  volume_collapse_min_samples?: number | null;
  liquidity_trend_guard_enabled?: number | null;
  max_liquidity_drop_pct_30m?: number | null;
  max_liquidity_drop_pct_1h?: number | null;
  liquidity_trend_min_samples?: number | null;
  rug_exit_enabled?: number | null;
  rug_liquidity_floor_usd?: number | null;
  rug_snapshot_stale_seconds?: number | null;
  rug_pair_missing_threshold?: number | null;
  archived?: boolean;
  archived_at?: number | null;
}

export function PoliciesTab() {
  const { callTool, error, connected } = useMcpClient();
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<'draft' | 'active' | 'retired' | ''>('');
  const [showArchived, setShowArchived] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<Policy | null>(null);
  const [selectedPolicy, setSelectedPolicy] = useState<Policy | null>(null);
  const [formData, setFormData] = useState<FormState>(INITIAL_FORM as FormState);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [volumeCollapseFieldErrors, setVolumeCollapseFieldErrors] = useState<{ ratio?: string; consecutive?: string; minSamples?: string } | null>(null);
  const [tokenAgeError, setTokenAgeError] = useState<string | null>(null);
  const [liquidityTrendFieldErrors, setLiquidityTrendFieldErrors] = useState<{ drop30m?: string; drop1h?: string; minSamples?: string } | null>(null);
  const [rugFieldErrors, setRugFieldErrors] = useState<{ liquidity_floor?: string; stale_seconds?: string; pair_missing_threshold?: string } | null>(null);
  const [retiringId, setRetiringId] = useState<number | null>(null);
  const [archivingId, setArchivingId] = useState<number | null>(null);
  const [activatingId, setActivatingId] = useState<number | null>(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [importYamlError, setImportYamlError] = useState<string | null>(null);
  const [formOpenedViaClone, setFormOpenedViaClone] = useState(false);
  const yamlFileInputRef = useRef<HTMLInputElement>(null);
  const limit = 25;

  const fetchPolicies = useCallback(async () => {
    if (!connected) return;
    setLoading(true);
    setLoadError(null);
    try {
      const args: { limit: number; offset: number; status?: string; include_archived?: boolean } = {
        limit,
        offset: page * limit,
      };
      if (statusFilter) args.status = statusFilter;
      args.include_archived = showArchived;
      const result = await callTool('list_policies', args);
      setPolicies(Array.isArray(result) ? result : []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      setPolicies([]);
    } finally {
      setLoading(false);
    }
  }, [callTool, connected, page, statusFilter, showArchived]);

  const archivePolicy = useCallback(
    async (policyId: number) => {
      setArchivingId(policyId);
      try {
        await callTool('archive_policy', { policy_id: policyId });
        if (!showArchived) {
          setPolicies((prev) => prev.filter((p) => p.policy_id !== policyId));
        } else {
          setPolicies((prev) =>
            prev.map((p) =>
              p.policy_id === policyId ? { ...p, archived: true, archived_at: Math.floor(Date.now() / 1000) } : p
            )
          );
        }
        if (selectedPolicy?.policy_id === policyId) setSelectedPolicy(null);
      } catch (err) {
        console.error('archive_policy failed:', err);
      } finally {
        setArchivingId(null);
      }
    },
    [callTool, showArchived, selectedPolicy?.policy_id]
  );

  useEffect(() => {
    fetchPolicies();
  }, [fetchPolicies]);

  const handleExportYaml = useCallback(async () => {
    if (!selectedPolicy?.policy_version || !connected) return;
    setExportLoading(true);
    try {
      const row = await callTool('export_policy', {
        policy_version: selectedPolicy.policy_version,
      });
      const safeName = (selectedPolicy.policy_version ?? 'export')
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .slice(0, 80) || 'policy';
      const data = row != null && typeof row === 'object' && !Array.isArray(row)
        ? exportPolicyFormatOnly(row as Record<string, unknown>)
        : {};
      const yaml = policyToYaml(data as Record<string, unknown>, selectedPolicy.policy_version);
      const blob = new Blob([yaml], { type: 'application/x-yaml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `policy-${safeName}.yaml`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // export_policy returns isError when policy not found; callTool throws
    } finally {
      setExportLoading(false);
    }
  }, [selectedPolicy?.policy_version, connected, callTool]);

  const handleImportYamlClick = () => {
    setImportYamlError(null);
    yamlFileInputRef.current?.click();
  };

  const handleImportYamlFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    setImportYamlError(null);
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = typeof reader.result === 'string' ? reader.result : '';
        const parsed = parsePolicyYaml(text);
        setFormData((prev) => ({ ...prev, ...parsed }));
      } catch (err) {
        setImportYamlError(err instanceof Error ? err.message : 'Failed to parse YAML');
      }
    };
    reader.onerror = () => setImportYamlError('Failed to read file');
    reader.readAsText(file, 'UTF-8');
  };

  const formatTimestamp = (ts: number | null) =>
    ts != null ? new Date(ts * 1000).toLocaleString() : '—';

  const fmtNum = (n: number | null | undefined, decimals = 2) =>
    n != null ? n.toLocaleString(undefined, { maximumFractionDigits: decimals }) : '—';

  const fmtBool = (v: number | null) =>
    v === 1 ? 'Yes' : v === 0 ? 'No' : '—';

  const statusClass = (s: string) => {
    if (s === 'active') return 'status-active';
    if (s === 'draft') return 'status-draft';
    if (s === 'retired') return 'status-retired';
    return '';
  };

  /** True if this draft can be activated: no linked policy or linked policy is not active. */
  const canActivatePolicy = (policy: Policy): boolean => {
    if (policy.status !== 'draft') return false;
    if (policy.linked_policy_id == null) return true;
    const linked = policies.find((p) => p.policy_id === policy.linked_policy_id);
    return linked == null || linked.status !== 'active';
  };

  const getActivateDisabledReason = (policy: Policy): string | null => {
    if (policy.status !== 'draft') return null;
    if (policy.linked_policy_id == null) return null;
    const linked = policies.find((p) => p.policy_id === policy.linked_policy_id);
    if (linked == null || linked.status !== 'active') return null;
    return `Linked policy "${linked.policy_version}" (ID: ${linked.policy_id}) is still active. Retire it first.`;
  };

  const handleAddClick = () => {
    setEditingPolicy(null);
    setFormData(INITIAL_FORM as FormState);
    setFormOpenedViaClone(false);
    setShowAddForm(true);
    setSubmitError(null);
    setImportYamlError(null);
    setVolumeCollapseFieldErrors(null);
    setTokenAgeError(null);
    setLiquidityTrendFieldErrors(null);
  };

  const handleEditClick = (policy: Policy) => {
    setEditingPolicy(policy);
    setFormData(policyToFormData(policy));
    setSelectedPolicy(null);
    setFormOpenedViaClone(false);
    setShowAddForm(true);
    setSubmitError(null);
    setImportYamlError(null);
    setVolumeCollapseFieldErrors(null);
    setTokenAgeError(null);
    setLiquidityTrendFieldErrors(null);
  };

  const handleCloneClick = (policy: Policy) => {
    setEditingPolicy(null);
    const cloned = policyToFormData(policy);
    setFormData({ ...cloned, policy_version: (policy.policy_version ?? '').trim() + ' [CLONE]', status: 'draft', linked_policy_id: policy.policy_id });
    setSelectedPolicy(null);
    setFormOpenedViaClone(true);
    setShowAddForm(true);
    setSubmitError(null);
    setImportYamlError(null);
    setVolumeCollapseFieldErrors(null);
    setTokenAgeError(null);
    setLiquidityTrendFieldErrors(null);
  };

  const handleRetireClick = async (policy: Policy) => {
    if (policy.status !== 'active' || !connected || retiringId != null) return;
    setRetiringId(policy.policy_id);
    try {
      await callTool('retire_policy', { policy_id: policy.policy_id });
      setSelectedPolicy(null);
      fetchPolicies();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setRetiringId(null);
    }
  };

  const handleActivateClick = async (policy: Policy) => {
    if (policy.status !== 'draft' || !connected || activatingId != null || !canActivatePolicy(policy)) return;
    setActivatingId(policy.policy_id);
    try {
      await callTool('activate_policy', { policy_id: policy.policy_id });
      if (selectedPolicy?.policy_id === policy.policy_id) {
        setSelectedPolicy({
          ...selectedPolicy,
          status: 'active',
          activated_at: Math.floor(Date.now() / 1000),
        });
      }
      fetchPolicies();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setActivatingId(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!connected) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const afterWin = parseNumericFormValue(formData.token_reentry_cooldown_seconds_after_win);
      const baseReentry = parseNumericFormValue(formData.token_reentry_cooldown_seconds);
      if (afterWin != null && baseReentry != null && afterWin >= baseReentry) {
        setSubmitError('Token reentry cooldown after win must be less than Token Re-entry Cooldown (seconds).');
        setSubmitting(false);
        return;
      }
      const payload: Record<string, unknown> = {
        policy_version: formData.policy_version,
        status: formData.status,
        created_by: formData.created_by,
        linked_policy_id: parseNumericFormValue(formData.linked_policy_id) ?? undefined,
        notes: formData.notes || undefined,
        changelog: formData.changelog || undefined,
        auto_optimize: formData.auto_optimize,
        max_pair_age_seconds: parseNumericFormValue(formData.max_pair_age_seconds) ?? undefined,
        min_token_age_seconds: parseNumericFormValue(formData.min_token_age_seconds) ?? undefined,
        min_liquidity_usd: parseNumericFormValue(formData.min_liquidity_usd) ?? undefined,
        min_volume_1m_usd: parseNumericFormValue(formData.min_volume_1m_usd) ?? undefined,
        min_price_change_1m_pct: parseNumericFormValue(formData.min_price_change_1m_pct) ?? undefined,
        min_volume_5m_usd: parseNumericFormValue(formData.min_volume_5m_usd) ?? undefined,
        min_buy_sell_ratio: parseNumericFormValue(formData.min_buy_sell_ratio) ?? undefined,
        min_transactions_1m: parseNumericFormValue(formData.min_transactions_1m) ?? undefined,
        min_velocity_score_1m: parseNumericFormValue(formData.min_velocity_score_1m) ?? undefined,
        min_buy_pressure_1m: parseNumericFormValue(formData.min_buy_pressure_1m) ?? undefined,
        min_buy_volume_1m_usd: parseNumericFormValue(formData.min_buy_volume_1m_usd) ?? undefined,
        min_sell_volume_1m_usd: parseNumericFormValue(formData.min_sell_volume_1m_usd) ?? undefined,
        require_no_mint_authority: formData.require_no_mint_authority,
        require_no_freeze_authority: formData.require_no_freeze_authority,
        require_lp_lock: formData.require_lp_lock,
        max_top_holder_pct: parseNumericFormValue(formData.max_top_holder_pct) ?? undefined,
        min_holder_count: parseNumericFormValue(formData.min_holder_count) ?? undefined,
        allowed_dexes: formData.allowed_dexes || undefined,
        weight_liquidity_velocity: parseNumericFormValue(formData.weight_liquidity_velocity) ?? undefined,
        weight_liquidity_absolute: parseNumericFormValue(formData.weight_liquidity_absolute) ?? undefined,
        weight_volume_1m: parseNumericFormValue(formData.weight_volume_1m) ?? undefined,
        weight_volume_5m: parseNumericFormValue(formData.weight_volume_5m) ?? undefined,
        weight_volume_acceleration_1m: parseNumericFormValue(formData.weight_volume_acceleration_1m) ?? undefined,
        weight_price_volatility_5m: parseNumericFormValue(formData.weight_price_volatility_5m) ?? undefined,
        weight_market_cap: parseNumericFormValue(formData.weight_market_cap) ?? undefined,
        weight_buy_sell_slope_1m: parseNumericFormValue(formData.weight_buy_sell_slope_1m) ?? undefined,
        weight_velocity_score_1m: parseNumericFormValue(formData.weight_velocity_score_1m) ?? undefined,
        weight_buy_pressure_1m: parseNumericFormValue(formData.weight_buy_pressure_1m) ?? undefined,
        weight_sell_pressure_1m: parseNumericFormValue(formData.weight_sell_pressure_1m) ?? undefined,
        weight_buy_volume_1m: parseNumericFormValue(formData.weight_buy_volume_1m) ?? undefined,
        weight_sell_volume_1m: parseNumericFormValue(formData.weight_sell_volume_1m) ?? undefined,
        weight_price_momentum_5m: parseNumericFormValue(formData.weight_price_momentum_5m) ?? undefined,
        weight_holder_growth: parseNumericFormValue(formData.weight_holder_growth) ?? undefined,
        weight_holder_concentration_penalty: parseNumericFormValue(formData.weight_holder_concentration_penalty) ?? undefined,
        weight_time_since_launch: parseNumericFormValue(formData.weight_time_since_launch) ?? undefined,
        weight_pair_age_seconds: parseNumericFormValue(formData.weight_pair_age_seconds) ?? undefined,
        min_trade_score: parseNumericFormValue(formData.min_trade_score) ?? undefined,
        priority_trade_score: parseNumericFormValue(formData.priority_trade_score) ?? undefined,
        risk_per_trade_pct: parseNumericFormValue(formData.risk_per_trade_pct) ?? undefined,
        stop_loss_pct: parseNumericFormValue(formData.stop_loss_pct) ?? undefined,
        take_profit_pct: parseNumericFormValue(formData.take_profit_pct) ?? undefined,
        max_trades_per_hour: parseNumericFormValue(formData.max_trades_per_hour) ?? undefined,
        max_concurrent_trades: parseNumericFormValue(formData.max_concurrent_trades) ?? undefined,
        cooldown_seconds_after_loss: parseNumericFormValue(formData.cooldown_seconds_after_loss) ?? undefined,
        time_stop_seconds: parseNumericFormValue(formData.time_stop_seconds) ?? undefined,
        halt_on_liquidity_drop_pct: parseNumericFormValue(formData.halt_on_liquidity_drop_pct) ?? undefined,
        cooldown_on_consecutive_losses: parseNumericFormValue(formData.cooldown_on_consecutive_losses) ?? undefined,
        cooldown_on_consecutive_losses_seconds: parseNumericFormValue(formData.cooldown_on_consecutive_losses_seconds) ?? undefined,
        halt_on_rug_detected: formData.halt_on_rug_detected,
        allow_low_confidence_trades: formData.allow_low_confidence_trades,
        token_reentry_cooldown_seconds: parseNumericFormValue(formData.token_reentry_cooldown_seconds) ?? undefined,
        token_reentry_cooldown_seconds_after_win: parseNumericFormValue(formData.token_reentry_cooldown_seconds_after_win) ?? undefined,
        max_trades_per_token_per_hour: parseNumericFormValue(formData.max_trades_per_token_per_hour) ?? undefined,
        pair_loss_cooldown_seconds: parseNumericFormValue(formData.pair_loss_cooldown_seconds) ?? undefined,
        max_consecutive_losses_per_pair: parseNumericFormValue(formData.max_consecutive_losses_per_pair) ?? undefined,
        volume_collapse_exit_enabled: formData.volume_collapse_exit_enabled,
        volume_collapse_ratio_threshold: parseNumericFormValue(formData.volume_collapse_ratio_threshold) ?? undefined,
        volume_collapse_consecutive_checks: parseNumericFormValue(formData.volume_collapse_consecutive_checks) ?? undefined,
        volume_collapse_min_samples: parseNumericFormValue(formData.volume_collapse_min_samples) ?? undefined,
        liquidity_trend_guard_enabled: formData.liquidity_trend_guard_enabled,
        max_liquidity_drop_pct_30m: parseNumericFormValue(formData.max_liquidity_drop_pct_30m) ?? undefined,
        max_liquidity_drop_pct_1h: parseNumericFormValue(formData.max_liquidity_drop_pct_1h) ?? undefined,
        liquidity_trend_min_samples: parseNumericFormValue(formData.liquidity_trend_min_samples) ?? undefined,
        rug_exit_enabled: formData.rug_exit_enabled,
        rug_liquidity_floor_usd: parseNumericFormValue(formData.rug_liquidity_floor_usd) ?? undefined,
        rug_snapshot_stale_seconds: parseNumericFormValue(formData.rug_snapshot_stale_seconds) ?? null,
        rug_pair_missing_threshold: parseNumericFormValue(formData.rug_pair_missing_threshold) ?? undefined,
      };
      const minAgeVal = parseNumericFormValue(formData.min_token_age_seconds);
      const maxAgeVal = parseNumericFormValue(formData.max_pair_age_seconds);
      if (minAgeVal != null && maxAgeVal != null && minAgeVal > maxAgeVal) {
        setTokenAgeError('Minimum Token Age must be ≤ Max pair age when both are set.');
        setSubmitError('Please fix token age fields above.');
        setSubmitting(false);
        return;
      }
      setTokenAgeError(null);
      if (formData.volume_collapse_exit_enabled) {
        const ratio = parseNumericFormValue(formData.volume_collapse_ratio_threshold);
        const consecutive = parseNumericFormValue(formData.volume_collapse_consecutive_checks);
        const minSamples = parseNumericFormValue(formData.volume_collapse_min_samples);
        const fieldErrors: { ratio?: string; consecutive?: string; minSamples?: string } = {};
        if (ratio == null || ratio < 0.05 || ratio > 1) {
          fieldErrors.ratio = 'Must be between 0.05 and 1';
        }
        if (consecutive == null || consecutive < 1 || consecutive > 10) {
          fieldErrors.consecutive = 'Must be between 1 and 10';
        }
        if (minSamples == null || minSamples < 1 || minSamples > 50) {
          fieldErrors.minSamples = 'Must be between 1 and 50';
        }
        if (Object.keys(fieldErrors).length > 0) {
          setVolumeCollapseFieldErrors(fieldErrors);
          setSubmitError('Please fix Volume Collapse Exit fields above.');
          setSubmitting(false);
          return;
        }
        setVolumeCollapseFieldErrors(null);
      } else {
        setVolumeCollapseFieldErrors(null);
      }
      if (formData.liquidity_trend_guard_enabled) {
        const drop30m = parseNumericFormValue(formData.max_liquidity_drop_pct_30m);
        const drop1h = parseNumericFormValue(formData.max_liquidity_drop_pct_1h);
        const minSamp = parseNumericFormValue(formData.liquidity_trend_min_samples);
        const fieldErrors: { drop30m?: string; drop1h?: string; minSamples?: string } = {};
        if (drop30m == null || drop30m > 0 || drop30m < -1) fieldErrors.drop30m = 'Must be between -1 and 0';
        if (drop1h == null || drop1h > 0 || drop1h < -1) fieldErrors.drop1h = 'Must be between -1 and 0';
        if (minSamp == null || minSamp < 1) fieldErrors.minSamples = 'Must be at least 1';
        if (Object.keys(fieldErrors).length > 0) {
          setLiquidityTrendFieldErrors(fieldErrors);
          setSubmitError('Please fix Liquidity Trend Guard fields above.');
          setSubmitting(false);
          return;
        }
        setLiquidityTrendFieldErrors(null);
      } else {
        setLiquidityTrendFieldErrors(null);
      }
      if (formData.rug_exit_enabled) {
        const floor = parseNumericFormValue(formData.rug_liquidity_floor_usd);
        const staleSec = parseNumericFormValue(formData.rug_snapshot_stale_seconds);
        const threshold = parseNumericFormValue(formData.rug_pair_missing_threshold);
        const fieldErrors: { liquidity_floor?: string; stale_seconds?: string; pair_missing_threshold?: string } = {};
        if (floor != null && floor < 0) fieldErrors.liquidity_floor = 'Must be ≥ 0';
        if (staleSec != null && staleSec < 30) fieldErrors.stale_seconds = 'Must be ≥ 30 seconds';
        if (threshold != null && threshold < 1) fieldErrors.pair_missing_threshold = 'Must be ≥ 1';
        if (Object.keys(fieldErrors).length > 0) {
          setRugFieldErrors(fieldErrors);
          setSubmitError('Please fix Rug Protection fields above.');
          setSubmitting(false);
          return;
        }
        setRugFieldErrors(null);
      } else {
        setRugFieldErrors(null);
      }
      if (editingPolicy) {
        await callTool('update_policy', { ...payload, policy_id: editingPolicy.policy_id });
      } else {
        await callTool('create_policy', payload);
      }
      setShowAddForm(false);
      setEditingPolicy(null);
      setFormData(INITIAL_FORM as FormState);
      setVolumeCollapseFieldErrors(null);
      setTokenAgeError(null);
      setLiquidityTrendFieldErrors(null);
      setRugFieldErrors(null);
      fetchPolicies();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const updateForm = (field: keyof typeof formData, value: string | number | boolean | null) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
  };

  return (
    <div className="policies-tab">
      <header className="policies-header">
        <h2>Policies</h2>
        <div className="policies-controls">
          <button
            type="button"
            className="policies-add-btn"
            onClick={handleAddClick}
          >
            Add Policy
          </button>
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value as typeof statusFilter);
              setPage(0);
            }}
          >
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="active">Active</option>
            <option value="retired">Retired</option>
          </select>
          <label className="policies-show-archived">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => {
                setShowArchived(e.target.checked);
                setPage(0);
              }}
            />
            {' '}Show archived
          </label>
          <div className="policies-status">
            {error && <span className="status-error">MCP: {error}</span>}
            {connected && !error && (
              <span className="status-ok">Connected to MCP</span>
            )}
          </div>
        </div>
      </header>

      {showAddForm && (
        <div className="policies-modal-overlay" onClick={() => !submitting && (setShowAddForm(false), setEditingPolicy(null), setFormOpenedViaClone(false))}>
          <div className="policies-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{editingPolicy ? `Edit Policy (ID: ${editingPolicy.policy_id})` : 'Add Policy'}</h3>
            <p className="policies-form-note">This policy runs under global account risk limits.</p>
            {!formOpenedViaClone && !editingPolicy && (
              <>
            <div className="form-row policies-import-yaml-row">
              <input
                ref={yamlFileInputRef}
                type="file"
                accept=".yaml,.yml,application/x-yaml,text/yaml"
                className="policies-import-yaml-input"
                onChange={handleImportYamlFileChange}
                aria-label="Import policy from YAML file"
              />
              <button
                type="button"
                className="policies-import-yaml-btn"
                onClick={handleImportYamlClick}
              >
                Import from YAML file
              </button>
              <span className="form-helper">Upload a .yaml file matching policies/policy_format.yaml to fill the form.</span>
            </div>
            {importYamlError && (
              <div className="policies-import-yaml-error" role="alert">
                {importYamlError}
              </div>
            )}
              </>
            )}
            <form onSubmit={handleSubmit} className="policies-form">
              <div className="form-row">
                <label>Version *</label>
                <input
                  type="text"
                  value={formData.policy_version}
                  onChange={(e) => updateForm('policy_version', e.target.value)}
                  required
                />
              </div>
              <div className="form-row">
                <label>Status</label>
                <select
                  value={formData.status}
                  onChange={(e) => updateForm('status', e.target.value as 'draft' | 'active' | 'retired')}
                >
                  <option value="draft">Draft</option>
                  <option value="active">Active</option>
                  <option value="retired">Retired</option>
                </select>
              </div>
              <div className="form-row">
                <label>Created by *</label>
                <select
                  value={formData.created_by}
                  onChange={(e) => updateForm('created_by', e.target.value as 'agent' | 'human')}
                >
                  <option value="human">Human</option>
                  <option value="agent">Agent</option>
                </select>
              </div>
              <div className="form-row">
                <label title="Policy this policy was cloned from or derived from">Linked policy</label>
                <select
                  value={formData.linked_policy_id ?? ''}
                  onChange={(e) => updateForm('linked_policy_id', e.target.value === '' ? null : Number(e.target.value))}
                >
                  <option value="">None</option>
                  {formData.linked_policy_id != null &&
                    !policies.some((p) => p.policy_id === formData.linked_policy_id) && (
                    <option value={formData.linked_policy_id}>Policy ID: {formData.linked_policy_id}</option>
                  )}
                  {policies
                    .filter((p) => !editingPolicy || p.policy_id !== editingPolicy.policy_id)
                    .map((p) => (
                      <option key={p.policy_id} value={p.policy_id}>
                        {p.policy_version} (ID: {p.policy_id})
                      </option>
                    ))}
                </select>
                <span className="form-helper">Optional. Link to the policy this was cloned or derived from. Only current page is listed.</span>
              </div>
              <div className="form-row">
                <label>Notes</label>
                <textarea
                  value={formData.notes}
                  onChange={(e) => updateForm('notes', e.target.value)}
                  rows={2}
                />
              </div>
              <div className="form-row">
                <label>Changelog</label>
                <textarea
                  value={formData.changelog}
                  onChange={(e) => updateForm('changelog', e.target.value)}
                  rows={3}
                  placeholder="History of changes and reasons (e.g. optimizer entries)"
                />
              </div>
              <div className="form-row">
                <label className="form-checkbox-label">
                  <input
                    type="checkbox"
                    checked={formData.auto_optimize ?? false}
                    onChange={(e) => updateForm('auto_optimize', e.target.checked)}
                  />
                  Auto Optimize
                </label>
                <span className="form-helper">Enable automatic optimization of this policy.</span>
              </div>
              <div className="form-section">Entry filters</div>
              <div className="form-grid">
                <div className="form-row">
                  <label>Max pair age (sec)</label>
                  <input
                    type="number"
                    value={formData.max_pair_age_seconds ?? ''}
                    onChange={(e) => { updateForm('max_pair_age_seconds', toNumericInputValue(e.target.value, 0)); setTokenAgeError(null); }}
                  />
                </div>
                <div className="form-row">
                  <label>Minimum Token Age (seconds)</label>
                  <input
                    type="number"
                    min={0}
                    step={60}
                    placeholder="optional"
                    value={formData.min_token_age_seconds ?? ''}
                    onChange={(e) => { updateForm('min_token_age_seconds', toNumericInputValue(e.target.value, null)); setTokenAgeError(null); }}
                  />
                  {tokenAgeError && <span className="form-error-inline">{tokenAgeError}</span>}
                  <span className="form-helper">Require the token to be at least this old before entries are allowed. Leave empty to disable.</span>
                </div>
                <div className="form-row">
                  <label>Min liquidity $</label>
                  <input
                    type="number"
                    placeholder="optional"
                    value={formData.min_liquidity_usd ?? ''}
                    onChange={(e) => updateForm('min_liquidity_usd', toNumericInputValue(e.target.value, null))}
                  />
                </div>
                <div className="form-row">
                  <label>Min volume 1m $</label>
                  <input
                    type="number"
                    placeholder="optional"
                    value={formData.min_volume_1m_usd ?? ''}
                    onChange={(e) => updateForm('min_volume_1m_usd', toNumericInputValue(e.target.value, null))}
                  />
                </div>
                <div className="form-row">
                  <label title="Requires pair_snapshots.price_change_1m ≥ this value (%). Use negative to allow only mild dumps.">
                    Min 1m price change %
                  </label>
                  <input
                    type="number"
                    step="0.1"
                    placeholder="optional"
                    value={formData.min_price_change_1m_pct ?? ''}
                    onChange={(e) => updateForm('min_price_change_1m_pct', toNumericInputValue(e.target.value, null))}
                  />
                  <span className="form-helper">Same units as snapshot price_change_1m (percent points). Leave empty to disable.</span>
                </div>
                <div className="form-row">
                  <label>Min volume 5m $</label>
                  <input
                    type="number"
                    placeholder="optional"
                    value={formData.min_volume_5m_usd ?? ''}
                    onChange={(e) => updateForm('min_volume_5m_usd', toNumericInputValue(e.target.value, null))}
                  />
                </div>
                <div className="form-row">
                  <label>Min buy/sell ratio 1m</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.min_buy_sell_ratio ?? ''}
                    onChange={(e) => updateForm('min_buy_sell_ratio', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label>Min transactions 1m</label>
                  <input
                    type="number"
                    placeholder="optional"
                    value={formData.min_transactions_1m ?? ''}
                    onChange={(e) => updateForm('min_transactions_1m', toNumericInputValue(e.target.value, null))}
                  />
                </div>
                <div className="form-row">
                  <label>Min velocity score 1m</label>
                  <input
                    type="number"
                    placeholder="optional"
                    value={formData.min_velocity_score_1m ?? ''}
                    onChange={(e) => updateForm('min_velocity_score_1m', toNumericInputValue(e.target.value, null))}
                  />
                </div>
                <div className="form-row">
                  <label>Min buy pressure 1m</label>
                  <input
                    type="number"
                    placeholder="optional"
                    value={formData.min_buy_pressure_1m ?? ''}
                    onChange={(e) => updateForm('min_buy_pressure_1m', toNumericInputValue(e.target.value, null))}
                  />
                </div>
                <div className="form-row">
                  <label>Min buy volume 1m $</label>
                  <input
                    type="number"
                    placeholder="optional"
                    value={formData.min_buy_volume_1m_usd ?? ''}
                    onChange={(e) => updateForm('min_buy_volume_1m_usd', toNumericInputValue(e.target.value, null))}
                  />
                </div>
                <div className="form-row">
                  <label>Min sell volume 1m $</label>
                  <input
                    type="number"
                    placeholder="optional"
                    value={formData.min_sell_volume_1m_usd ?? ''}
                    onChange={(e) => updateForm('min_sell_volume_1m_usd', toNumericInputValue(e.target.value, null))}
                  />
                </div>
                <div className="form-row">
                  <label>Max top holder %</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.max_top_holder_pct ?? ''}
                    onChange={(e) => updateForm('max_top_holder_pct', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label>Min holder count</label>
                  <input
                    type="number"
                    placeholder="optional"
                    value={formData.min_holder_count ?? ''}
                    onChange={(e) => updateForm('min_holder_count', toNumericInputValue(e.target.value, null))}
                  />
                </div>
              </div>
              <div className="form-section">Liquidity Trend Guard</div>
              <div className="form-grid">
                <div className="form-row form-row-full">
                  <label className="form-checkbox-label">
                    <input
                      type="checkbox"
                      checked={!!formData.liquidity_trend_guard_enabled}
                      onChange={(e) => {
                        const enabled = e.target.checked;
                        setFormData((prev) => {
                          const next = { ...prev, liquidity_trend_guard_enabled: enabled };
                          if (enabled && prev.max_liquidity_drop_pct_30m == null && prev.max_liquidity_drop_pct_1h == null && prev.liquidity_trend_min_samples == null) {
                            next.max_liquidity_drop_pct_30m = -0.25;
                            next.max_liquidity_drop_pct_1h = -0.35;
                            next.liquidity_trend_min_samples = 6;
                          }
                          return next;
                        });
                        if (!enabled) setLiquidityTrendFieldErrors(null);
                      }}
                    />
                    Enable Liquidity Drain Protection
                  </label>
                </div>
                {formData.liquidity_trend_guard_enabled && (
                  <>
                    <div className="form-row">
                      <label>Max Liquidity Drop (30m)</label>
                      <input
                        type="number"
                        step="0.01"
                        min={-1}
                        max={0}
                        value={formData.max_liquidity_drop_pct_30m ?? ''}
                        onChange={(e) => { updateForm('max_liquidity_drop_pct_30m', toNumericInputValue(e.target.value, null)); setLiquidityTrendFieldErrors((prev) => (prev ? { ...prev, drop30m: undefined } : null)); }}
                      />
                      {liquidityTrendFieldErrors?.drop30m && <span className="form-error-inline">{liquidityTrendFieldErrors.drop30m}</span>}
                      <span className="form-helper">Reject entries if liquidity has fallen more than this percentage over the last 30 minutes.</span>
                    </div>
                    <div className="form-row">
                      <label>Max Liquidity Drop (1h)</label>
                      <input
                        type="number"
                        step="0.01"
                        min={-1}
                        max={0}
                        value={formData.max_liquidity_drop_pct_1h ?? ''}
                        onChange={(e) => { updateForm('max_liquidity_drop_pct_1h', toNumericInputValue(e.target.value, null)); setLiquidityTrendFieldErrors((prev) => (prev ? { ...prev, drop1h: undefined } : null)); }}
                      />
                      {liquidityTrendFieldErrors?.drop1h && <span className="form-error-inline">{liquidityTrendFieldErrors.drop1h}</span>}
                      <span className="form-helper">Reject entries if liquidity has fallen more than this percentage over the last hour.</span>
                    </div>
                    <div className="form-row">
                      <label>Minimum Liquidity Samples</label>
                      <input
                        type="number"
                        min={1}
                        value={formData.liquidity_trend_min_samples ?? ''}
                        onChange={(e) => { updateForm('liquidity_trend_min_samples', toNumericInputValue(e.target.value, null)); setLiquidityTrendFieldErrors((prev) => (prev ? { ...prev, minSamples: undefined } : null)); }}
                      />
                      {liquidityTrendFieldErrors?.minSamples && <span className="form-error-inline">{liquidityTrendFieldErrors.minSamples}</span>}
                      <span className="form-helper">Minimum number of snapshots required before liquidity protection activates.</span>
                    </div>
                  </>
                )}
              </div>
              <div className="form-section" aria-hidden="true" />
              <div className="form-grid">
                <div className="form-row form-row-full">
                  <label>Allowed DEXes</label>
                  <div className="form-checkboxes">
                    {(['raydium', 'orca', 'pumpswap', 'pumpfun'] as const).map((dex) => (
                      <label key={dex} className="form-check">
                        <input
                          type="checkbox"
                          checked={(formData.allowed_dexes ?? '').split(',').map((d) => d.trim()).includes(dex)}
                          onChange={(e) => {
                            const current = (formData.allowed_dexes ?? '').split(',').map((d) => d.trim()).filter(Boolean);
                            const next = e.target.checked
                              ? [...current.filter((d) => d !== dex), dex].sort()
                              : current.filter((d) => d !== dex);
                            updateForm('allowed_dexes', next.join(',') || '');
                          }}
                        />
                        {dex === 'raydium' ? 'Raydium' : dex === 'orca' ? 'Orca' : dex === 'pumpswap' ? 'Pumpswap' : 'Pumpfun'}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              <div className="form-section">Scoring weights</div>
              <div className="form-grid">
                <div className="form-row">
                  <label title="Weight for liquidity velocity">Liq velocity</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.weight_liquidity_velocity ?? ''}
                    onChange={(e) => updateForm('weight_liquidity_velocity', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label title="Weight for current total liquidity level of the pair">Liq absolute</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.weight_liquidity_absolute ?? ''}
                    onChange={(e) => updateForm('weight_liquidity_absolute', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label title="Weight for 1-minute volume">Vol 1m</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.weight_volume_1m ?? ''}
                    onChange={(e) => updateForm('weight_volume_1m', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label title="Weight for 5-minute volume">Vol 5m</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.weight_volume_5m ?? ''}
                    onChange={(e) => updateForm('weight_volume_5m', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label title="Weight for volume acceleration 1m">Weight vol accel 1m</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.weight_volume_acceleration_1m ?? ''}
                    onChange={(e) => updateForm('weight_volume_acceleration_1m', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label title="Weight for abs(price_change_5m). Snapshot: price_change_5m">Price volatility 5m</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.weight_price_volatility_5m ?? ''}
                    onChange={(e) => updateForm('weight_price_volatility_5m', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label title="Weight for market cap">Market cap</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.weight_market_cap ?? ''}
                    onChange={(e) => updateForm('weight_market_cap', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label title="Weight for buy/sell ratio 1m. Snapshot: buy_sell_ratio_1m">B/S slope 1m</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.weight_buy_sell_slope_1m ?? ''}
                    onChange={(e) => updateForm('weight_buy_sell_slope_1m', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label title="Weight for velocity score 1m">Velocity score 1m</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.weight_velocity_score_1m ?? ''}
                    onChange={(e) => updateForm('weight_velocity_score_1m', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label title="Weight for buy pressure 1m">Buy pressure 1m</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.weight_buy_pressure_1m ?? ''}
                    onChange={(e) => updateForm('weight_buy_pressure_1m', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label title="Weight for sell pressure 1m">Sell pressure 1m</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.weight_sell_pressure_1m ?? ''}
                    onChange={(e) => updateForm('weight_sell_pressure_1m', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label title="Weight for buy volume 1m">Buy volume 1m</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.weight_buy_volume_1m ?? ''}
                    onChange={(e) => updateForm('weight_buy_volume_1m', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label title="Weight for sell volume 1m">Sell volume 1m</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.weight_sell_volume_1m ?? ''}
                    onChange={(e) => updateForm('weight_sell_volume_1m', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label title="Weight for price change 5m. Snapshot: price_change_5m">Price momentum 5m</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.weight_price_momentum_5m ?? ''}
                    onChange={(e) => updateForm('weight_price_momentum_5m', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label title="Weight for holder growth">Holder growth</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.weight_holder_growth ?? ''}
                    onChange={(e) => updateForm('weight_holder_growth', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label title="Weight for holder concentration penalty">Holder conc. penalty</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.weight_holder_concentration_penalty ?? ''}
                    onChange={(e) => updateForm('weight_holder_concentration_penalty', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label title="Weight for time since launch">Time since launch</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.weight_time_since_launch ?? ''}
                    onChange={(e) => updateForm('weight_time_since_launch', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label title="Bias toward newer or older pairs. Negative values favor newer pairs. Positive values favor older pairs.">Pair Age Bias</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.weight_pair_age_seconds ?? ''}
                    onChange={(e) => updateForm('weight_pair_age_seconds', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
              </div>
              <div className="form-section">Score Thresholds</div>
              <div className="form-grid">
                <div className="form-row">
                  <label>Min trade score</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.min_trade_score ?? ''}
                    onChange={(e) => updateForm('min_trade_score', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label>Priority trade score</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.priority_trade_score ?? ''}
                    onChange={(e) => updateForm('priority_trade_score', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
              </div>
              <div className="form-section">Risk</div>
              <div className="form-grid">
                <div className="form-row">
                  <label>Risk per trade %</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.risk_per_trade_pct ?? ''}
                    onChange={(e) => updateForm('risk_per_trade_pct', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label>Stop loss %</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.stop_loss_pct ?? ''}
                    onChange={(e) => updateForm('stop_loss_pct', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label>Take profit %</label>
                  <input
                    type="number"
                    step="0.1"
                    value={formData.take_profit_pct ?? ''}
                    onChange={(e) => updateForm('take_profit_pct', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label>Time stop (sec)</label>
                  <input
                    type="number"
                    value={formData.time_stop_seconds ?? ''}
                    onChange={(e) => updateForm('time_stop_seconds', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
              </div>
              <div className="form-section">Volume Collapse Exit</div>
              <div className="form-grid">
                <div className="form-row form-row-full">
                  <label className="form-checkbox-label">
                    <input
                      type="checkbox"
                      checked={!!formData.volume_collapse_exit_enabled}
                      onChange={(e) => {
                        const enabled = e.target.checked;
                        setFormData((prev) => {
                          const next = { ...prev, volume_collapse_exit_enabled: enabled };
                          if (enabled && prev.volume_collapse_ratio_threshold == null && prev.volume_collapse_consecutive_checks == null && prev.volume_collapse_min_samples == null) {
                            next.volume_collapse_ratio_threshold = 0.35;
                            next.volume_collapse_consecutive_checks = 2;
                            next.volume_collapse_min_samples = 6;
                          }
                          return next;
                        });
                        if (!enabled) setVolumeCollapseFieldErrors(null);
                      }}
                    />
                    Enable Volume Collapse Exit
                  </label>
                </div>
                {formData.volume_collapse_exit_enabled && (
                  <>
                    <div className="form-row">
                      <label>Volume Collapse Ratio Threshold</label>
                      <input
                        type="number"
                        step="0.01"
                        min={0.05}
                        max={1}
                        value={formData.volume_collapse_ratio_threshold ?? ''}
                        onChange={(e) => { updateForm('volume_collapse_ratio_threshold', toNumericInputValue(e.target.value, null)); setVolumeCollapseFieldErrors((prev) => (prev ? { ...prev, ratio: undefined } : null)); }}
                      />
                      {volumeCollapseFieldErrors?.ratio && <span className="form-error-inline">{volumeCollapseFieldErrors.ratio}</span>}
                      <span className="form-helper">Triggers exit when 5m volume falls below this fraction of the rolling 1h baseline.</span>
                    </div>
                    <div className="form-row">
                      <label>Consecutive Collapse Checks</label>
                      <input
                        type="number"
                        min={1}
                        max={10}
                        step={1}
                        value={formData.volume_collapse_consecutive_checks ?? ''}
                        onChange={(e) => { updateForm('volume_collapse_consecutive_checks', toNumericInputValue(e.target.value, null)); setVolumeCollapseFieldErrors((prev) => (prev ? { ...prev, consecutive: undefined } : null)); }}
                      />
                      {volumeCollapseFieldErrors?.consecutive && <span className="form-error-inline">{volumeCollapseFieldErrors.consecutive}</span>}
                      <span className="form-helper">Number of consecutive snapshots below threshold required before exit.</span>
                    </div>
                    <div className="form-row">
                      <label>Minimum Rolling Samples</label>
                      <input
                        type="number"
                        min={1}
                        max={50}
                        step={1}
                        value={formData.volume_collapse_min_samples ?? ''}
                        onChange={(e) => { updateForm('volume_collapse_min_samples', toNumericInputValue(e.target.value, null)); setVolumeCollapseFieldErrors((prev) => (prev ? { ...prev, minSamples: undefined } : null)); }}
                      />
                      {volumeCollapseFieldErrors?.minSamples && <span className="form-error-inline">{volumeCollapseFieldErrors.minSamples}</span>}
                      <span className="form-helper">Minimum number of rolling-volume samples required before collapse logic activates.</span>
                    </div>
                  </>
                )}
              </div>
              <div className="form-section">🔻 Rug Protection</div>
              <div className="form-grid">
                <div className="form-row form-row-full">
                  <label className="form-checkbox-label">
                    <input
                      type="checkbox"
                      checked={!!formData.rug_exit_enabled}
                      onChange={(e) => updateForm('rug_exit_enabled', e.target.checked)}
                    />
                    Enable Rug Exit (force-close on liquidity collapse, stale snapshot, or pair unavailable)
                  </label>
                </div>
                {formData.rug_exit_enabled && (
                  <>
                    <div className="form-row">
                      <label>Liquidity floor (USD)</label>
                      <input
                        type="number"
                        min={0}
                        step="100"
                        value={formData.rug_liquidity_floor_usd ?? ''}
                        onChange={(e) => updateForm('rug_liquidity_floor_usd', toNumericInputValue(e.target.value, null))}
                      />
                      <span className="form-helper">Force exit if pool liquidity falls below this value. Leave empty to disable.</span>
                      {rugFieldErrors?.liquidity_floor && <span className="form-error-inline">{rugFieldErrors.liquidity_floor}</span>}
                    </div>
                    <div className="form-row">
                      <label>Snapshot stale (seconds)</label>
                      <input
                        type="number"
                        min={30}
                        step="1"
                        value={formData.rug_snapshot_stale_seconds ?? ''}
                        onChange={(e) => updateForm('rug_snapshot_stale_seconds', toNumericInputValue(e.target.value, null))}
                      />
                      <span className="form-helper">Force exit if no fresh snapshot arrives within this time. Min 30. Leave empty to disable.</span>
                      {rugFieldErrors?.stale_seconds && <span className="form-error-inline">{rugFieldErrors.stale_seconds}</span>}
                    </div>
                    <div className="form-row">
                      <label>Pair missing threshold</label>
                      <input
                        type="number"
                        min={1}
                        step="1"
                        value={formData.rug_pair_missing_threshold ?? ''}
                        onChange={(e) => updateForm('rug_pair_missing_threshold', toNumericInputValue(e.target.value, 3))}
                      />
                      <span className="form-helper">Number of consecutive scrape failures before forced exit. Min 1. Default 3.</span>
                      {rugFieldErrors?.pair_missing_threshold && <span className="form-error-inline">{rugFieldErrors.pair_missing_threshold}</span>}
                    </div>
                  </>
                )}
              </div>
              <div className="form-section">Limits</div>
              <div className="form-grid">
                <div className="form-row">
                  <label>Max trades/hour</label>
                  <input
                    type="number"
                    value={formData.max_trades_per_hour ?? ''}
                    onChange={(e) => updateForm('max_trades_per_hour', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label>Max concurrent</label>
                  <input
                    type="number"
                    value={formData.max_concurrent_trades ?? ''}
                    onChange={(e) => updateForm('max_concurrent_trades', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label>Cooldown after loss (sec)</label>
                  <input
                    type="number"
                    value={formData.cooldown_seconds_after_loss ?? ''}
                    onChange={(e) => updateForm('cooldown_seconds_after_loss', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label>Pause after N consecutive losses</label>
                  <input
                    type="number"
                    min={0}
                    placeholder="0 = off"
                    value={formData.cooldown_on_consecutive_losses ?? ''}
                    onChange={(e) => updateForm('cooldown_on_consecutive_losses', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label>Cooldown after consecutive losses (sec)</label>
                  <input
                    type="number"
                    min={0}
                    placeholder="optional"
                    value={formData.cooldown_on_consecutive_losses_seconds ?? ''}
                    onChange={(e) => updateForm('cooldown_on_consecutive_losses_seconds', toNumericInputValue(e.target.value, null))}
                  />
                </div>
              </div>
              <div className="form-section" title="These controls prevent over-trading hot tokens.">
                Token Execution Controls
              </div>
              <div className="form-grid">
                <div className="form-row">
                  <label title="Minimum time to wait after exiting a trade before re-entering the same token. 0 = disabled.">
                    Token Re-entry Cooldown (seconds)
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={formData.token_reentry_cooldown_seconds ?? ''}
                    onChange={(e) => updateForm('token_reentry_cooldown_seconds', toNumericInputValue(e.target.value, 0))}
                  />
                </div>
                <div className="form-row">
                  <label title="If set, allows faster re-entry into the same token after a profitable trade. Losses always use the normal cooldown. Must be less than Token Re-entry Cooldown.">
                    Token reentry cooldown after win (seconds)
                  </label>
                  <input
                    type="number"
                    min={0}
                    placeholder="optional"
                    value={formData.token_reentry_cooldown_seconds_after_win ?? ''}
                    onChange={(e) => updateForm('token_reentry_cooldown_seconds_after_win', toNumericInputValue(e.target.value, null))}
                  />
                </div>
                <div className="form-row">
                  <label title="Max trades this policy may take on the same token within one hour. Empty = disabled.">
                    Max Trades per Token per Hour
                  </label>
                  <input
                    type="number"
                    min={1}
                    placeholder="optional"
                    value={formData.max_trades_per_token_per_hour ?? ''}
                    onChange={(e) => updateForm('max_trades_per_token_per_hour', toNumericInputValue(e.target.value, null))}
                  />
                </div>
                <div className="form-row">
                  <label title="Seconds to wait after a loss on a token/pair before re-entering. 0 or empty = disabled.">
                    Token reentry cooldown after loss (seconds)
                  </label>
                  <input
                    type="number"
                    min={0}
                    placeholder="optional"
                    value={formData.pair_loss_cooldown_seconds ?? ''}
                    onChange={(e) => updateForm('pair_loss_cooldown_seconds', toNumericInputValue(e.target.value, null))}
                  />
                </div>
                <div className="form-row">
                  <label title="Max consecutive losses on the same token/pair per calendar day before blocking new entries. Empty = disabled.">
                    Max Consecutive Losses per Pair
                  </label>
                  <input
                    type="number"
                    min={1}
                    placeholder="optional"
                    value={formData.max_consecutive_losses_per_pair ?? ''}
                    onChange={(e) => updateForm('max_consecutive_losses_per_pair', toNumericInputValue(e.target.value, null))}
                  />
                </div>
              </div>
              <div className="form-section">Safety & Kill Switches</div>
              <div className="form-grid">
                <div className="form-row">
                  <label>Halt on liq drop % (optional)</label>
                  <input
                    type="number"
                    step="0.1"
                    placeholder="Optional"
                    value={formData.halt_on_liquidity_drop_pct ?? ''}
                    onChange={(e) => updateForm('halt_on_liquidity_drop_pct', toNumericInputValue(e.target.value, null))}
                  />
                </div>
              </div>
              <div className="form-checkboxes">
                <label className="form-check">
                  <input
                    type="checkbox"
                    checked={formData.require_no_mint_authority}
                    onChange={(e) => updateForm('require_no_mint_authority', e.target.checked)}
                  />
                  Require no mint authority
                </label>
                <label className="form-check">
                  <input
                    type="checkbox"
                    checked={formData.require_no_freeze_authority}
                    onChange={(e) => updateForm('require_no_freeze_authority', e.target.checked)}
                  />
                  Require no freeze authority
                </label>
                <label className="form-check">
                  <input
                    type="checkbox"
                    checked={formData.require_lp_lock}
                    onChange={(e) => updateForm('require_lp_lock', e.target.checked)}
                  />
                  Require LP lock
                </label>
                <label className="form-check">
                  <input
                    type="checkbox"
                    checked={formData.halt_on_rug_detected ?? false}
                    onChange={(e) => updateForm('halt_on_rug_detected', e.target.checked)}
                  />
                  Halt on rug detected
                </label>
                <label className="form-check">
                  <input
                    type="checkbox"
                    checked={formData.allow_low_confidence_trades ?? false}
                    onChange={(e) => updateForm('allow_low_confidence_trades', e.target.checked)}
                  />
                  Allow low confidence trades
                </label>
              </div>
              {submitError && (
                <div className="policies-form-error">{submitError}</div>
              )}
              <div className="policies-form-buttons">
                <button type="button" onClick={() => !submitting && setShowAddForm(false)}>
                  Cancel
                </button>
                <button type="submit" disabled={submitting}>
                  {submitting
                    ? (editingPolicy ? 'Updating…' : 'Creating…')
                    : (editingPolicy ? 'Update' : 'Create')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {selectedPolicy && (
        <div
          className="policies-modal-overlay"
          onClick={() => setSelectedPolicy(null)}
        >
          <div
            className="policies-modal policies-detail-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="policies-detail-header">
              <h3>Policy {selectedPolicy.policy_version} (ID: {selectedPolicy.policy_id})</h3>
              <div className="policies-detail-header-actions">
                <div className="policies-detail-actions-row policies-detail-actions-row--primary">
                  {selectedPolicy.status === 'active' && (
                    <button
                      type="button"
                      className="policies-action-btn policies-action-btn--danger"
                      onClick={() => handleRetireClick(selectedPolicy)}
                      disabled={retiringId === selectedPolicy.policy_id}
                    >
                      {retiringId === selectedPolicy.policy_id ? 'Retiring…' : 'Retire'}
                    </button>
                  )}
                  {selectedPolicy.status === 'draft' && !selectedPolicy.archived && (
                    <>
                      <button
                        type="button"
                        className="policies-action-btn policies-action-btn--success"
                        onClick={() => handleActivateClick(selectedPolicy)}
                        disabled={activatingId === selectedPolicy.policy_id || !canActivatePolicy(selectedPolicy)}
                        title={getActivateDisabledReason(selectedPolicy) ?? undefined}
                      >
                        {activatingId === selectedPolicy.policy_id ? 'Activating…' : 'Activate'}
                      </button>
                      <button
                        type="button"
                        className="policies-action-btn policies-action-btn--accent"
                        onClick={() => handleEditClick(selectedPolicy)}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="policies-action-btn policies-action-btn--muted"
                        onClick={() => archivePolicy(selectedPolicy.policy_id)}
                        disabled={archivingId === selectedPolicy.policy_id}
                      >
                        {archivingId === selectedPolicy.policy_id ? 'Archiving…' : 'Archive'}
                      </button>
                    </>
                  )}
                  {selectedPolicy.status === 'retired' && !selectedPolicy.archived && (
                    <button
                      type="button"
                      className="policies-action-btn policies-action-btn--muted"
                      onClick={() => archivePolicy(selectedPolicy.policy_id)}
                      disabled={archivingId === selectedPolicy.policy_id}
                    >
                      {archivingId === selectedPolicy.policy_id ? 'Archiving…' : 'Archive'}
                    </button>
                  )}
                </div>
                {selectedPolicy.status === 'draft' && !selectedPolicy.archived && getActivateDisabledReason(selectedPolicy) != null && (
                  <p className="policies-activate-hint" title={getActivateDisabledReason(selectedPolicy)!}>
                    Activate disabled: linked policy is still active.
                  </p>
                )}
                <div className="policies-detail-actions-row policies-detail-actions-row--tools">
                  <button
                    type="button"
                    className="policies-action-btn policies-action-btn--ghost"
                    onClick={() => handleCloneClick(selectedPolicy)}
                  >
                    Clone
                  </button>
                  <button
                    type="button"
                    className="policies-action-btn policies-action-btn--ghost policies-action-btn--download"
                    onClick={handleExportYaml}
                    disabled={exportLoading || !connected}
                  >
                    {exportLoading ? 'Exporting…' : 'Download YAML'}
                  </button>
                </div>
              </div>
            </div>
            <div className="policies-detail">
              <div className="form-section">Metadata</div>
              <div className="policies-detail-grid">
                <div className="policies-detail-row">
                  <span className="detail-label">Status</span>
                  <span className="detail-value">
                    {selectedPolicy.status === 'active' &&
                     selectedPolicy.policy_cooldown_until != null &&
                     selectedPolicy.policy_cooldown_until > Math.floor(Date.now() / 1000) ? (
                      <span className={statusClass(selectedPolicy.status)}>
                        Paused (cooldown until {new Date(selectedPolicy.policy_cooldown_until * 1000).toLocaleTimeString()})
                      </span>
                    ) : (
                      <span className={statusClass(selectedPolicy.status)}>{selectedPolicy.status}</span>
                    )}
                  </span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Created</span>
                  <span className="detail-value">{formatTimestamp(selectedPolicy.created_at)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Activated</span>
                  <span className="detail-value">{formatTimestamp(selectedPolicy.activated_at)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Retired</span>
                  <span className="detail-value">{formatTimestamp(selectedPolicy.retired_at)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Created by</span>
                  <span className="detail-value">{selectedPolicy.created_by}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Linked policy</span>
                  <span className="detail-value">
                    {selectedPolicy.linked_policy_id != null
                      ? (() => {
                          const linked = policies.find((p) => p.policy_id === selectedPolicy.linked_policy_id);
                          return linked ? `${linked.policy_version} (ID: ${selectedPolicy.linked_policy_id})` : `ID: ${selectedPolicy.linked_policy_id}`;
                        })()
                      : '—'}
                  </span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Updated</span>
                  <span className="detail-value">{formatTimestamp(selectedPolicy.updated_at ?? null)}</span>
                </div>
                {selectedPolicy.retired_reason != null && selectedPolicy.retired_reason !== '' && (
                  <div className="policies-detail-row">
                    <span className="detail-label">Retired reason</span>
                    <span className="detail-value">{selectedPolicy.retired_reason}</span>
                  </div>
                )}
                {selectedPolicy.parent_policy_version != null && selectedPolicy.parent_policy_version !== '' && (
                  <div className="policies-detail-row">
                    <span className="detail-label">Parent policy</span>
                    <span className="detail-value">{selectedPolicy.parent_policy_version}</span>
                  </div>
                )}
                {selectedPolicy.created_from_policy_version != null && selectedPolicy.created_from_policy_version !== '' && (
                  <div className="policies-detail-row">
                    <span className="detail-label">Created from policy</span>
                    <span className="detail-value">{selectedPolicy.created_from_policy_version}</span>
                  </div>
                )}
                {selectedPolicy.change_reason != null && selectedPolicy.change_reason !== '' && (
                  <div className="policies-detail-row">
                    <span className="detail-label">Change reason</span>
                    <span className="detail-value">{selectedPolicy.change_reason}</span>
                  </div>
                )}
                {(selectedPolicy.archived === true || selectedPolicy.archived_at != null) && (
                  <div className="policies-detail-row">
                    <span className="detail-label">Archived</span>
                    <span className="detail-value">{selectedPolicy.archived_at != null ? formatTimestamp(selectedPolicy.archived_at) : 'Yes'}</span>
                  </div>
                )}
                {selectedPolicy.source_recommendation_id != null && (
                  <div className="policies-detail-row">
                    <span className="detail-label">Source recommendation ID</span>
                    <span className="detail-value">{selectedPolicy.source_recommendation_id}</span>
                  </div>
                )}
              </div>
              {selectedPolicy.notes && (
                <>
                  <div className="form-section">Notes</div>
                  <p className="policies-detail-notes">{selectedPolicy.notes}</p>
                </>
              )}
              {(selectedPolicy.changelog ?? '').trim() && (
                <>
                  <div className="form-section">Changelog</div>
                  <p className="policies-detail-notes policies-detail-changelog">{selectedPolicy.changelog}</p>
                </>
              )}
              <div className="form-section">Entry filters</div>
              <div className="policies-detail-grid">
                <div className="policies-detail-row">
                  <span className="detail-label">Max pair age (sec)</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.max_pair_age_seconds, 0)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Min token age (sec)</span>
                  <span className="detail-value">{selectedPolicy.min_token_age_seconds != null ? `${selectedPolicy.min_token_age_seconds}s` : '—'}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Min liquidity $</span>
                  <span className="detail-value">${fmtNum(selectedPolicy.min_liquidity_usd, 0)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Liquidity Trend Guard</span>
                  <span className="detail-value">
                    {selectedPolicy.liquidity_trend_guard_enabled === 1
                      ? `ON (30m ${selectedPolicy.max_liquidity_drop_pct_30m != null ? (selectedPolicy.max_liquidity_drop_pct_30m * 100).toFixed(0) : '—'}%, 1h ${selectedPolicy.max_liquidity_drop_pct_1h != null ? (selectedPolicy.max_liquidity_drop_pct_1h * 100).toFixed(0) : '—'}%, min samples ${selectedPolicy.liquidity_trend_min_samples ?? '—'})`
                      : '—'}
                  </span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Min volume 1m $</span>
                  <span className="detail-value">${fmtNum(selectedPolicy.min_volume_1m_usd, 0)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Min 1m price change %</span>
                  <span className="detail-value">
                    {selectedPolicy.min_price_change_1m_pct != null
                      ? `${fmtNum(selectedPolicy.min_price_change_1m_pct, 2)}%`
                      : '—'}
                  </span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Min volume 5m $</span>
                  <span className="detail-value">${fmtNum(selectedPolicy.min_volume_5m_usd, 0)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Min buy/sell ratio 1m</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.min_buy_sell_ratio, 2)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Min transactions 1m</span>
                  <span className="detail-value">{selectedPolicy.min_transactions_1m != null ? fmtNum(selectedPolicy.min_transactions_1m, 0) : '—'}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Min velocity score 1m</span>
                  <span className="detail-value">{selectedPolicy.min_velocity_score_1m != null ? fmtNum(selectedPolicy.min_velocity_score_1m, 2) : '—'}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Min buy pressure 1m</span>
                  <span className="detail-value">{selectedPolicy.min_buy_pressure_1m != null ? fmtNum(selectedPolicy.min_buy_pressure_1m, 2) : '—'}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Min buy volume 1m $</span>
                  <span className="detail-value">{selectedPolicy.min_buy_volume_1m_usd != null ? fmtNum(selectedPolicy.min_buy_volume_1m_usd, 2) : '—'}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Min sell volume 1m $</span>
                  <span className="detail-value">{selectedPolicy.min_sell_volume_1m_usd != null ? fmtNum(selectedPolicy.min_sell_volume_1m_usd, 2) : '—'}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Max top holder %</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.max_top_holder_pct, 1)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Min holder count</span>
                  <span className="detail-value">{selectedPolicy.min_holder_count ?? '—'}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Allowed DEXes</span>
                  <span className="detail-value">{selectedPolicy.allowed_dexes ?? '—'}</span>
                </div>
              </div>
              <div className="form-section">Scoring weights</div>
              <div className="policies-detail-grid">
                <div className="policies-detail-row">
                  <span className="detail-label">Liquidity velocity</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.weight_liquidity_velocity, 2)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Liquidity absolute</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.weight_liquidity_absolute, 2)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Volume 1m</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.weight_volume_1m, 2)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Volume 5m</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.weight_volume_5m, 2)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Weight volume acceleration 1m</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.weight_volume_acceleration_1m, 2)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Price volatility 5m</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.weight_price_volatility_5m, 2)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Market cap</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.weight_market_cap, 2)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">B/S slope 1m</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.weight_buy_sell_slope_1m, 2)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Velocity score 1m</span>
                  <span className="detail-value">{selectedPolicy.weight_velocity_score_1m != null ? fmtNum(selectedPolicy.weight_velocity_score_1m, 2) : '—'}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Buy pressure 1m</span>
                  <span className="detail-value">{selectedPolicy.weight_buy_pressure_1m != null ? fmtNum(selectedPolicy.weight_buy_pressure_1m, 2) : '—'}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Sell pressure 1m</span>
                  <span className="detail-value">{selectedPolicy.weight_sell_pressure_1m != null ? fmtNum(selectedPolicy.weight_sell_pressure_1m, 2) : '—'}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Buy volume 1m</span>
                  <span className="detail-value">{selectedPolicy.weight_buy_volume_1m != null ? fmtNum(selectedPolicy.weight_buy_volume_1m, 2) : '—'}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Sell volume 1m</span>
                  <span className="detail-value">{selectedPolicy.weight_sell_volume_1m != null ? fmtNum(selectedPolicy.weight_sell_volume_1m, 2) : '—'}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Price momentum 5m</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.weight_price_momentum_5m, 2)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Holder growth</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.weight_holder_growth, 2)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Holder conc. penalty</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.weight_holder_concentration_penalty, 2)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Time since launch</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.weight_time_since_launch, 2)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Pair Age Bias</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.weight_pair_age_seconds, 2)}</span>
                </div>
              </div>
              <div className="form-section">Score Thresholds</div>
              <div className="policies-detail-grid">
                <div className="policies-detail-row">
                  <span className="detail-label">Min trade score</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.min_trade_score, 1)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Priority trade score</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.priority_trade_score, 1)}</span>
                </div>
              </div>
              <div className="form-section">Risk</div>
              <div className="policies-detail-grid">
                <div className="policies-detail-row">
                  <span className="detail-label">Risk per trade %</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.risk_per_trade_pct, 2)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Stop loss %</span>
                  <span className="detail-value">{selectedPolicy.stop_loss_pct != null ? `${selectedPolicy.stop_loss_pct}%` : '—'}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Take profit %</span>
                  <span className="detail-value">{selectedPolicy.take_profit_pct != null ? `${selectedPolicy.take_profit_pct}%` : '—'}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Time stop (sec)</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.time_stop_seconds, 0)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Volume Collapse</span>
                  <span className="detail-value">
                    {selectedPolicy.volume_collapse_exit_enabled === 1
                      ? `ON (${selectedPolicy.volume_collapse_ratio_threshold != null ? Number(selectedPolicy.volume_collapse_ratio_threshold).toFixed(2) : '—'}×, ${selectedPolicy.volume_collapse_consecutive_checks ?? '—'} checks, min samples ${selectedPolicy.volume_collapse_min_samples ?? '—'})`
                      : '—'}
                  </span>
                </div>
              </div>
              <div className="form-section">Limits</div>
              <div className="policies-detail-grid">
                <div className="policies-detail-row">
                  <span className="detail-label">Max trades/hour</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.max_trades_per_hour, 0)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Max concurrent</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.max_concurrent_trades, 0)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Cooldown after loss (sec)</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.cooldown_seconds_after_loss, 0)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Pause after N consecutive losses</span>
                  <span className="detail-value">
                    {selectedPolicy.cooldown_on_consecutive_losses != null
                      ? fmtNum(selectedPolicy.cooldown_on_consecutive_losses, 0)
                      : '—'}
                  </span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Cooldown after consecutive losses (sec)</span>
                  <span className="detail-value">
                    {selectedPolicy.cooldown_on_consecutive_losses_seconds != null
                      ? fmtNum(selectedPolicy.cooldown_on_consecutive_losses_seconds, 0)
                      : '—'}
                  </span>
                </div>
              </div>
              <div className="form-section" title="These controls prevent over-trading hot tokens.">
                Token Execution Controls
              </div>
              <div className="policies-detail-grid">
                <div className="policies-detail-row">
                  <span className="detail-label">Token re-entry cooldown (sec)</span>
                  <span className="detail-value">{fmtNum(selectedPolicy.token_reentry_cooldown_seconds, 0)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Token reentry cooldown after win (sec)</span>
                  <span className="detail-value">{selectedPolicy.token_reentry_cooldown_seconds_after_win != null ? fmtNum(selectedPolicy.token_reentry_cooldown_seconds_after_win, 0) : '—'}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Max trades per token per hour</span>
                  <span className="detail-value">{selectedPolicy.max_trades_per_token_per_hour != null ? fmtNum(selectedPolicy.max_trades_per_token_per_hour, 0) : '—'}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Token reentry cooldown after loss (sec)</span>
                  <span className="detail-value">{selectedPolicy.pair_loss_cooldown_seconds != null ? fmtNum(selectedPolicy.pair_loss_cooldown_seconds, 0) : '—'}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Max consecutive losses per pair</span>
                  <span className="detail-value">{selectedPolicy.max_consecutive_losses_per_pair != null ? fmtNum(selectedPolicy.max_consecutive_losses_per_pair, 0) : '—'}</span>
                </div>
              </div>
              <div className="form-section">Safety & Kill Switches</div>
              <div className="policies-detail-grid">
                <div className="policies-detail-row">
                  <span className="detail-label">Halt on liq drop %</span>
                  <span className="detail-value">
                    {selectedPolicy.halt_on_liquidity_drop_pct != null
                      ? fmtNum(selectedPolicy.halt_on_liquidity_drop_pct, 1)
                      : '—'}
                  </span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Require no mint authority</span>
                  <span className="detail-value">{fmtBool(selectedPolicy.require_no_mint_authority)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Require no freeze authority</span>
                  <span className="detail-value">{fmtBool(selectedPolicy.require_no_freeze_authority)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Require LP lock</span>
                  <span className="detail-value">{fmtBool(selectedPolicy.require_lp_lock)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Halt on rug</span>
                  <span className="detail-value">{fmtBool(selectedPolicy.halt_on_rug_detected)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Allow low confidence trades</span>
                  <span className="detail-value">{fmtBool(selectedPolicy.allow_low_confidence_trades)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Auto Optimize</span>
                  <span className="detail-value">{fmtBool(selectedPolicy.auto_optimize ?? null)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Halt on N consecutive losses</span>
                  <span className="detail-value">
                    {selectedPolicy.halt_on_consecutive_losses != null
                      ? fmtNum(selectedPolicy.halt_on_consecutive_losses, 0)
                      : '—'}
                  </span>
                </div>
              </div>
              <div className="form-section">Rug exit</div>
              <div className="policies-detail-grid">
                <div className="policies-detail-row">
                  <span className="detail-label">Rug exit enabled</span>
                  <span className="detail-value">{fmtBool(selectedPolicy.rug_exit_enabled ?? null)}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Rug liquidity floor $</span>
                  <span className="detail-value">{selectedPolicy.rug_liquidity_floor_usd != null ? `$${fmtNum(selectedPolicy.rug_liquidity_floor_usd, 0)}` : '—'}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Rug snapshot stale (sec)</span>
                  <span className="detail-value">{selectedPolicy.rug_snapshot_stale_seconds != null ? fmtNum(selectedPolicy.rug_snapshot_stale_seconds, 0) : '—'}</span>
                </div>
                <div className="policies-detail-row">
                  <span className="detail-label">Rug pair missing threshold</span>
                  <span className="detail-value">{selectedPolicy.rug_pair_missing_threshold != null ? fmtNum(selectedPolicy.rug_pair_missing_threshold, 0) : '—'}</span>
                </div>
              </div>
            </div>
            <div className="policies-form-buttons">
              <button type="button" onClick={() => setSelectedPolicy(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {loadError && (
        <div className="policies-error">
          {loadError}
          <button onClick={fetchPolicies}>Retry</button>
        </div>
      )}

      {loading ? (
        <div className="policies-loading">Loading policies…</div>
      ) : (
        <>
          <div className="policies-table-wrapper">
            <table className="policies-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>By</th>
                  <th>Min Liq $</th>
                  <th>Max Age</th>
                  <th>Min Age</th>
                  <th>Risk %</th>
                  <th>Stop Loss</th>
                  <th>Take profit %</th>
                  <th>Max/Hr</th>
                  <th>Notes</th>
                  <th className="policies-table-actions-heading">Actions</th>
                </tr>
              </thead>
              <tbody>
                {policies.map((p) => (
                  <tr key={p.policy_id}>
                    <td>{p.policy_id}</td>
                    <td>{p.policy_version}</td>
                    <td>
                      {p.archived ? <span className="policies-badge policies-badge--archived">Archived</span> : null}
                      {p.status === 'active' &&
                       p.policy_cooldown_until != null &&
                       p.policy_cooldown_until > Math.floor(Date.now() / 1000) ? (
                        <span className="status-paused" title="Policy will auto-resume">
                          Paused (cooldown until {new Date(p.policy_cooldown_until * 1000).toLocaleTimeString()})
                        </span>
                      ) : (
                        <span className={statusClass(p.status)}>{p.status}</span>
                      )}
                    </td>
                    <td>{formatTimestamp(p.created_at)}</td>
                    <td>{p.created_by}</td>
                    <td>${fmtNum(p.min_liquidity_usd, 0)}</td>
                    <td>
                      {p.max_pair_age_seconds != null
                        ? `${Math.floor(p.max_pair_age_seconds / 60)}m`
                        : '—'}
                    </td>
                    <td>
                      {p.min_token_age_seconds != null ? `${p.min_token_age_seconds}s` : '—'}
                    </td>
                    <td>{fmtNum(p.risk_per_trade_pct, 2)}</td>
                    <td>{p.stop_loss_pct != null ? `${p.stop_loss_pct}%` : '—'}</td>
                    <td>{p.take_profit_pct != null ? `${p.take_profit_pct}%` : '—'}</td>
                    <td>{fmtNum(p.max_trades_per_hour, 0)}</td>
                    <td className="notes-cell" title={p.notes ?? undefined}>
                      {p.notes ? (p.notes.length > 40 ? p.notes.slice(0, 40) + '…' : p.notes) : '—'}
                    </td>
                    <td className="policies-table-actions-cell">
                      <div className="policies-table-actions">
                        <button
                          type="button"
                          className="policies-action-btn policies-action-btn--compact policies-action-btn--ghost"
                          onClick={() => setSelectedPolicy(p)}
                        >
                          View
                        </button>
                        {p.status === 'draft' && !p.archived && (
                          <>
                            <button
                              type="button"
                              className="policies-action-btn policies-action-btn--compact policies-action-btn--success"
                              onClick={() => handleActivateClick(p)}
                              disabled={activatingId === p.policy_id || !canActivatePolicy(p)}
                              title={getActivateDisabledReason(p) ?? undefined}
                            >
                              {activatingId === p.policy_id ? 'Activating…' : 'Activate'}
                            </button>
                            <button
                              type="button"
                              className="policies-action-btn policies-action-btn--compact policies-action-btn--accent"
                              onClick={() => handleEditClick(p)}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="policies-action-btn policies-action-btn--compact policies-action-btn--muted"
                              onClick={() => archivePolicy(p.policy_id)}
                              disabled={archivingId === p.policy_id}
                            >
                              {archivingId === p.policy_id ? 'Archiving…' : 'Archive'}
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          className="policies-action-btn policies-action-btn--compact policies-action-btn--ghost"
                          onClick={() => handleCloneClick(p)}
                        >
                          Clone
                        </button>
                        {p.status === 'active' && (
                          <button
                            type="button"
                            className="policies-action-btn policies-action-btn--compact policies-action-btn--danger"
                            onClick={() => handleRetireClick(p)}
                            disabled={retiringId === p.policy_id}
                          >
                            {retiringId === p.policy_id ? 'Retiring…' : 'Retire'}
                          </button>
                        )}
                        {p.status === 'retired' && !p.archived && (
                          <button
                            type="button"
                            className="policies-action-btn policies-action-btn--compact policies-action-btn--muted"
                            onClick={() => archivePolicy(p.policy_id)}
                            disabled={archivingId === p.policy_id}
                          >
                            {archivingId === p.policy_id ? 'Archiving…' : 'Archive'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="policies-pagination">
            <button
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </button>
            <span>Page {page + 1}</span>
            <button
              disabled={policies.length < limit}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
