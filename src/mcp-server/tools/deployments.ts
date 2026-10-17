import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { randomUUID } from 'node:crypto';
import { db, SOLANA_DEFAULT_ACCOUNT_ID } from '../../db.js';
import { getSolPriceUsd } from '../../sol-price.js';
import { getSolanaPublicKeyString } from '../../solana-signer.js';
import { z } from '../schema.js';

async function createPolicyDeploymentHandler(input: { policy_id: number; account_id: string }) {
  const policyId = String(input.policy_id);
  const accountId = input.account_id;
  const policy = db
    .prepare('SELECT policy_id, policy_version FROM policies WHERE policy_id = $policyId')
    .get({ policyId: Number(policyId) }) as { policy_id: number; policy_version: string } | undefined;
  if (!policy) {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Policy not found' }) }] };
  }
  const account = db
    .prepare('SELECT account_id FROM accounts WHERE account_id = $accountId')
    .get({ accountId }) as { account_id: string } | undefined;
  if (!account) {
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Account not found' }) }] };
  }
  const existing = db
    .prepare(
      `SELECT id FROM policy_deployments WHERE policy_id = $policyId AND account_id = $accountId`
    )
    .get({ policyId, accountId }) as { id: string } | undefined;
  if (existing) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: false,
            error: 'A deployment for this policy and account already exists.',
          }),
        },
      ],
    };
  }
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  try {
    db.prepare(
      `INSERT INTO policy_deployments (id, policy_id, account_id, is_active, created_at) VALUES ($id, $policyId, $accountId, 1, $now)`
    ).run({ id, policyId, accountId, now });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: msg }) }] };
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, deployment_id: id }) }] };
}

export function registerDeploymentsTools(server: McpServer): void {
  server.registerTool(
    'list_policy_deployments',
    {
      description:
        'List policy deployments (policy + account links). Returns deployment_id, policy_id, policy_version, account_id, account mode, is_active, created_at, policy_status, policy_archived, archived, archived_at. By default excludes archived deployments; set include_archived to true to show them. Optional filter by policy_id or account_id.',
      inputSchema: z.object({
        policy_id: z.optional(z.number()),
        account_id: z.optional(z.string()),
        include_archived: z.optional(z.boolean()),
      }),
    },
    async (input) => {
      const policyId = input?.policy_id;
      const accountId = input?.account_id;
      const includeArchived = input?.include_archived === true;
      let sql = `
        SELECT pd.id AS deployment_id, pd.policy_id, pd.account_id, pd.is_active, pd.created_at,
               COALESCE(pd.archived, 0) AS archived, pd.archived_at,
               p.policy_version, p.status AS policy_status, COALESCE(p.archived, 0) AS policy_archived,
               a.mode AS account_mode
        FROM policy_deployments pd
        INNER JOIN policies p ON p.policy_id = CAST(pd.policy_id AS INTEGER)
        INNER JOIN accounts a ON a.account_id = pd.account_id
        WHERE 1=1
      `;
      const params: Record<string, number | string> = {};
      if (policyId != null) {
        sql += ` AND pd.policy_id = $policyId`;
        params.policyId = String(policyId);
      }
      if (accountId != null) {
        sql += ` AND pd.account_id = $accountId`;
        params.accountId = accountId;
      }
      if (!includeArchived) {
        sql += ` AND (COALESCE(pd.archived, 0) = 0)`;
      }
      sql += ` ORDER BY pd.created_at DESC`;
      const rows = db.prepare(sql).all(params) as {
        deployment_id: string;
        policy_id: string;
        account_id: string;
        is_active: number;
        created_at: number | null;
        archived: number;
        archived_at: number | null;
        policy_version: string;
        policy_status: string;
        policy_archived: number;
        account_mode: string;
      }[];
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(rows),
          },
        ],
      };
    }
  );

  server.registerTool(
    'archive_policy_deployment',
    {
      description:
        'Archive a policy deployment. Only deployments whose linked policy is both retired and archived can be archived. Archived deployments can be shown again by listing with include_archived: true.',
      inputSchema: z.object({
        deployment_id: z.string(),
      }),
    },
    async (input) => {
      const deploymentId = input.deployment_id;
      const row = db
        .prepare(
          `SELECT pd.id, pd.policy_id, pd.archived, p.status AS policy_status, COALESCE(p.archived, 0) AS policy_archived
           FROM policy_deployments pd
           INNER JOIN policies p ON p.policy_id = CAST(pd.policy_id AS INTEGER)
           WHERE pd.id = $deploymentId`
        )
        .get({ deploymentId }) as
        | { id: string; policy_id: string; archived: number | null; policy_status: string; policy_archived: number }
        | undefined;
      if (!row) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Deployment not found' }) }],
        };
      }
      if (row.policy_status !== 'retired' || row.policy_archived !== 1) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({
                ok: false,
                error: 'Only deployments whose policy is retired and archived can be archived.',
              }),
            },
          ],
        };
      }
      if (row.archived === 1) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, already_archived: true }) }],
        };
      }
      const now = Math.floor(Date.now() / 1000);
      db.prepare(
        `UPDATE policy_deployments SET archived = 1, archived_at = $archived_at WHERE id = $deploymentId`
      ).run({ archived_at: now, deploymentId });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, archived_at: now }) }],
      };
    }
  );

  server.registerTool(
    'create_policy_deployment',
    {
      description: 'Deploy a policy to an account. Creates a row in policy_deployments. Returns the new deployment_id.',
      inputSchema: z.object({
        policy_id: z.number(),
        account_id: z.string(),
      }),
    },
    createPolicyDeploymentHandler
  );

  server.registerTool(
    'update_policy_deployment',
    {
      description: 'Update a policy deployment (e.g. toggle is_active).',
      inputSchema: z.object({
        deployment_id: z.string(),
        is_active: z.optional(z.boolean()),
      }),
    },
    async (input) => {
      const deploymentId = input.deployment_id;
      const isActive = input.is_active;
      if (isActive === undefined) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'No updates provided' }) }],
        };
      }
      if (isActive) {
        const row = db
          .prepare(
            `SELECT p.status AS policy_status FROM policy_deployments pd
             INNER JOIN policies p ON p.policy_id = CAST(pd.policy_id AS INTEGER)
             WHERE pd.id = $deploymentId`
          )
          .get({ deploymentId }) as { policy_status: string } | undefined;
        if (!row) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'Deployment not found' }) }],
          };
        }
        if (row.policy_status === 'retired') {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({
                  ok: false,
                  error: 'Cannot activate a deployment whose policy is retired.',
                }),
              },
            ],
          };
        }
      }
      const result = db
        .prepare(`UPDATE policy_deployments SET is_active = $isActive WHERE id = $deploymentId`)
        .run({ isActive: isActive ? 1 : 0, deploymentId }) as { changes: number };
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ ok: result.changes > 0, changes: result.changes }),
          },
        ],
      };
    }
  );

  server.registerTool(
    'list_accounts',
    {
      description: 'List all accounts (account_id, mode, balance, is_active, etc.). For UI accounts page.',
      inputSchema: z.object({}),
    },
    async () => {
      const rows = db
        .prepare(
          `SELECT account_id, mode, COALESCE(chain, 'paper') AS chain, name, address,
                  starting_equity, current_equity, available_balance,
                  balance_native, balance_last_updated,
                  max_daily_drawdown_pct, max_total_open_trades, COALESCE(max_total_risk_pct, 15) AS max_total_risk_pct,
                  trading_enabled, COALESCE(is_active, 1) AS is_active, created_at, updated_at
           FROM accounts ORDER BY mode, chain, account_id`
        )
        .all() as {
        account_id: string;
        mode: string;
        chain: string;
        name: string | null;
        address: string | null;
        starting_equity: number;
        current_equity: number;
        available_balance: number;
        balance_native: number | null;
        balance_last_updated: number | null;
        max_daily_drawdown_pct: number | null;
        max_total_open_trades: number | null;
        max_total_risk_pct: number;
        trading_enabled: number;
        is_active: number;
        created_at: number;
        updated_at: number;
      }[];
      const solanaPublicAddress = getSolanaPublicKeyString() ?? null;
      let solPriceUsd: number | null = null;
      const hasSolanaBalance = rows.some((r) => r.chain === 'solana' && r.balance_native != null);
      if (hasSolanaBalance) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            solPriceUsd = await getSolPriceUsd();
            break;
          } catch {
            if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
          }
        }
      }
      const withAddress = rows.map((row) => ({
        ...row,
        address:
          row.account_id === SOLANA_DEFAULT_ACCOUNT_ID
            ? solanaPublicAddress ?? row.address ?? null
            : row.address ?? null,
        balance_native_usd:
          row.chain === 'solana' && row.balance_native != null && solPriceUsd != null
            ? row.balance_native * solPriceUsd
            : null,
      }));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(withAddress) }],
      };
    }
  );
}
