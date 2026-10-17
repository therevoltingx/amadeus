import { db } from './db.js';

export interface AccountRow {
  account_id: string;
  mode: 'paper' | 'live';
  chain: string | null;
  address: string | null;
  name: string | null;
  starting_equity: number;
  current_equity: number;
  available_balance: number;
  balance_native: number | null;
  max_daily_drawdown_pct: number | null;
  max_total_open_trades: number | null;
  max_total_risk_pct: number;
  trading_enabled: number;
  is_active: number;
  updated_at: number;
}

export interface PolicyRow {
  policy_id: number;
  policy_version: string;
  status: string;
  [key: string]: unknown;
}

export interface ActiveDeployment {
  deployment_id: string;
  account: AccountRow;
  policy: PolicyRow;
}

const getActiveDeploymentsForPolicyQuery = db.prepare(`
  SELECT
    pd.id AS deployment_id,
    a.account_id, a.mode, COALESCE(a.chain, 'paper') AS chain, a.address, a.name,
    a.starting_equity, a.current_equity, a.available_balance, a.balance_native,
    a.max_daily_drawdown_pct, a.max_total_open_trades,
    COALESCE(a.max_total_risk_pct, 15) AS max_total_risk_pct,
    a.trading_enabled, COALESCE(a.is_active, 1) AS is_active, a.updated_at
  FROM policy_deployments pd
  INNER JOIN accounts a ON a.account_id = pd.account_id
  INNER JOIN policies p ON p.policy_id = CAST(pd.policy_id AS INTEGER)
  WHERE pd.policy_id = $policyId AND pd.is_active = 1
    AND COALESCE(a.is_active, 1) = 1
    AND p.status = 'active'
  ORDER BY pd.id
`);

const getPolicyById = db.prepare(`
  SELECT * FROM policies WHERE policy_id = $policyId
`);

const getAccountByIdQuery = db.prepare(`
  SELECT account_id, mode, COALESCE(chain, 'paper') AS chain, address, name,
    starting_equity, current_equity, available_balance, balance_native,
    max_daily_drawdown_pct, max_total_open_trades, COALESCE(max_total_risk_pct, 15) AS max_total_risk_pct,
    trading_enabled, COALESCE(is_active, 1) AS is_active, updated_at
  FROM accounts WHERE account_id = $accountId
`);

/**
 * Load account by id. Returns undefined if not found.
 * Does not filter by is_active; used by the exit worker so exits complete even when deployment is inactive.
 */
export function getAccountById(accountId: string): AccountRow | undefined {
  const row = getAccountByIdQuery.get({ accountId }) as Omit<AccountRow, 'chain'> & { chain: string } | undefined;
  if (!row) return undefined;
  return {
    ...row,
    chain: row.chain ?? 'paper',
  };
}

/**
 * Returns active deployments for a policy: deployment_id, account (eager-loaded), policy (eager-loaded).
 * Only active deployments, active accounts, and policy status = 'active'. Deterministic order by deployment id.
 */
export function getActiveDeploymentsForPolicy(policyId: number | string): ActiveDeployment[] {
  const policyIdStr = String(policyId);
  const rows = getActiveDeploymentsForPolicyQuery.all({ policyId: policyIdStr }) as (AccountRow & { deployment_id: string })[];
  const policy = getPolicyById.get({ policyId: Number(policyIdStr) }) as PolicyRow | undefined;
  if (!policy) return [];

  return rows.map((row) => {
    const { deployment_id, ...rest } = row;
    const account: AccountRow = {
      account_id: row.account_id,
      mode: row.mode as 'paper' | 'live',
      chain: row.chain ?? 'paper',
      address: row.address ?? null,
      name: row.name ?? null,
      starting_equity: row.starting_equity,
      current_equity: row.current_equity,
      available_balance: row.available_balance,
      balance_native: row.balance_native ?? null,
      max_daily_drawdown_pct: row.max_daily_drawdown_pct,
      max_total_open_trades: row.max_total_open_trades,
      max_total_risk_pct: row.max_total_risk_pct,
      trading_enabled: row.trading_enabled,
      is_active: row.is_active,
      updated_at: row.updated_at,
    };
    return { deployment_id, account, policy };
  });
}
