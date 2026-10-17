/**
 * Policy status enum. Must match policies.status CHECK constraint in db.
 */
export const POLICY_STATUS_DRAFT = 'draft';
export const POLICY_STATUS_ACTIVE = 'active';
export const POLICY_STATUS_RETIRED = 'retired';

export const POLICY_STATUSES = [
  POLICY_STATUS_DRAFT,
  POLICY_STATUS_ACTIVE,
  POLICY_STATUS_RETIRED,
] as const;

export type PolicyStatus = (typeof POLICY_STATUSES)[number];

export function isPolicyStatus(s: string): s is PolicyStatus {
  return POLICY_STATUSES.includes(s as PolicyStatus);
}

/**
 * Policy created_by enum. Must match policies.created_by CHECK constraint in db.
 */
export const POLICY_CREATED_BY_AGENT = 'agent';
export const POLICY_CREATED_BY_HUMAN = 'human';
export const POLICY_CREATED_BY_SYSTEM = 'system';

export const POLICY_CREATED_BY_VALUES = [
  POLICY_CREATED_BY_AGENT,
  POLICY_CREATED_BY_HUMAN,
  POLICY_CREATED_BY_SYSTEM,
] as const;

export type PolicyCreatedBy = (typeof POLICY_CREATED_BY_VALUES)[number];

export function isPolicyCreatedBy(s: string): s is PolicyCreatedBy {
  return POLICY_CREATED_BY_VALUES.includes(s as PolicyCreatedBy);
}

/**
 * Allowed DEX enum. Must match policies.allowed_dexes CHECK constraint in db.
 * Stored as comma-separated when multiple (e.g. 'raydium,orca').
 */
export const POLICY_DEX_RAYDIUM = 'raydium';
export const POLICY_DEX_ORCA = 'orca';
export const POLICY_DEX_PUMPSWAP = 'pumpswap';
export const POLICY_DEX_PUMPFUN = 'pumpfun';

export const POLICY_ALLOWED_DEXES = [
  POLICY_DEX_RAYDIUM,
  POLICY_DEX_ORCA,
  POLICY_DEX_PUMPSWAP,
  POLICY_DEX_PUMPFUN,
] as const;

export type PolicyAllowedDex = (typeof POLICY_ALLOWED_DEXES)[number];

/** Valid stored values: null or comma-separated subset of raydium, orca, pumpswap, pumpfun */
export const POLICY_ALLOWED_DEXES_VALUES = [
  null,
  'raydium',
  'orca',
  'pumpswap',
  'pumpfun',
  'raydium,orca',
  'raydium,pumpswap',
  'raydium,pumpfun',
  'orca,pumpswap',
  'orca,pumpfun',
  'pumpswap,pumpfun',
  'raydium,orca,pumpswap',
  'raydium,orca,pumpfun',
  'raydium,pumpswap,pumpfun',
  'orca,pumpswap,pumpfun',
  'raydium,orca,pumpswap,pumpfun',
] as const;

export function isAllowedDexesValue(s: string | null): boolean {
  if (s === null || s === '') return true;
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  return parts.every((p) => POLICY_ALLOWED_DEXES.includes(p as PolicyAllowedDex));
}
