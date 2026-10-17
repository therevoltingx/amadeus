import { useState, useEffect, useCallback, useMemo } from 'react';
import { useMcpClient } from '../hooks/useMcpClient';
import './DeploymentsTab.css';

const ARCHIVE_BUTTON_TOOLTIP =
  'Only deployments whose policy is retired and archived can be archived. Archive the policy on the Policies tab first if needed.';

export interface PolicyDeploymentRow {
  deployment_id: string;
  policy_id: string;
  account_id: string;
  is_active: number;
  created_at: number;
  policy_version: string;
  account_mode: string;
  policy_status?: string;
  policy_archived?: number;
  archived?: number;
  archived_at?: number | null;
}

export function DeploymentsTab() {
  const { callTool, error, connected } = useMcpClient();
  const [deployments, setDeployments] = useState<PolicyDeploymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [createPolicyId, setCreatePolicyId] = useState('');
  const [createAccountId, setCreateAccountId] = useState('');
  const [policies, setPolicies] = useState<{ policy_id: number; policy_version: string }[]>([]);
  const [accounts, setAccounts] = useState<{ account_id: string; mode: string; name?: string | null }[]>([]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [archivingId, setArchivingId] = useState<string | null>(null);

  const fetchDeployments = useCallback(async () => {
    if (!connected) return;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await callTool('list_policy_deployments', { include_archived: showArchived });
      setDeployments(Array.isArray(result) ? result : []);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
      setDeployments([]);
    } finally {
      setLoading(false);
    }
  }, [callTool, connected, showArchived]);

  const fetchPoliciesAndAccounts = useCallback(async () => {
    if (!connected) return;
    try {
      const pList = await callTool('list_policies', { status: 'active' });
      const aList = await callTool('list_accounts', {});
      setPolicies(Array.isArray(pList) ? pList : []);
      setAccounts(Array.isArray(aList) ? aList : []);
    } catch {
      setPolicies([]);
      setAccounts([]);
    }
  }, [callTool, connected]);

  useEffect(() => {
    fetchDeployments();
  }, [fetchDeployments]);

  useEffect(() => {
    fetchPoliciesAndAccounts();
  }, [fetchPoliciesAndAccounts]);

  const handleCreate = useCallback(async () => {
    const policyId = createPolicyId.trim() ? Number(createPolicyId) : NaN;
    const accountId = createAccountId.trim();
    if (!connected || creating || !Number.isInteger(policyId) || !accountId) return;
    setCreateError(null);
    setCreating(true);
    try {
      const result = (await callTool('create_policy_deployment', {
        policy_id: policyId,
        account_id: accountId,
      })) as { ok?: boolean; error?: string };
      if (result?.ok) {
        setCreatePolicyId('');
        setCreateAccountId('');
        await fetchDeployments();
      } else {
        setCreateError(result?.error ?? 'Failed to create deployment');
      }
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [callTool, connected, creating, createPolicyId, createAccountId, fetchDeployments]);

  const handleToggleActive = useCallback(
    async (deploymentId: string, currentActive: number) => {
      if (!connected || togglingId) return;
      setTogglingId(deploymentId);
      setLoadError(null);
      try {
        const result = (await callTool('update_policy_deployment', {
          deployment_id: deploymentId,
          is_active: currentActive !== 1,
        })) as { ok?: boolean; error?: string };
        if (result?.ok) await fetchDeployments();
        else if (result?.error) setLoadError(result.error);
      } finally {
        setTogglingId(null);
      }
    },
    [callTool, connected, togglingId, fetchDeployments]
  );

  const canArchiveDeployment = (d: PolicyDeploymentRow) =>
    d.policy_status === 'retired' && d.policy_archived === 1 && d.archived !== 1;

  const handleArchive = useCallback(
    async (deploymentId: string) => {
      if (!connected || archivingId) return;
      setArchivingId(deploymentId);
      try {
        const result = (await callTool('archive_policy_deployment', { deployment_id: deploymentId })) as {
          ok?: boolean;
          error?: string;
        };
        if (result?.ok) await fetchDeployments();
      } finally {
        setArchivingId(null);
      }
    },
    [callTool, connected, archivingId, fetchDeployments]
  );

  const formatDate = (ts: number) =>
    ts ? new Date(ts * 1000).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : '—';

  const accountIdToName = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accounts) {
      m.set(a.account_id, (a.name && a.name.trim()) ? a.name.trim() : a.account_id);
    }
    return m;
  }, [accounts]);

  return (
    <div className="deployments-tab">
      <header className="deployments-header">
        <h2>Policy Deployments</h2>
        <div className="deployments-status">
          {error && <span className="status-error">MCP: {error}</span>}
          {connected && !error && <span className="status-ok">Connected</span>}
        </div>
      </header>
      <p className="deployments-intro">
        Deployments link policies to accounts. Each active deployment runs the policy for that account.
      </p>

      <section className="deployments-create">
        <h3>Deploy policy to account</h3>
        <div className="deployments-create-grid">
          <div className="deployments-create-row">
            <label htmlFor="create-policy">Policy</label>
            <select
              id="create-policy"
              value={createPolicyId}
              onChange={(e) => setCreatePolicyId(e.target.value)}
              disabled={!connected}
            >
              <option value="">Select policy</option>
              {policies.map((p) => (
                <option key={p.policy_id} value={String(p.policy_id)}>
                  {p.policy_version} (id: {p.policy_id})
                </option>
              ))}
            </select>
          </div>
          <div className="deployments-create-row">
            <label htmlFor="create-account">Account</label>
            <select
              id="create-account"
              value={createAccountId}
              onChange={(e) => setCreateAccountId(e.target.value)}
              disabled={!connected}
            >
              <option value="">Select account</option>
              {accounts.map((a) => (
                <option key={a.account_id} value={a.account_id}>
                  {a.name || a.account_id} ({a.mode})
                </option>
              ))}
            </select>
          </div>
          <div className="deployments-create-actions">
            <button
              type="button"
              className="deployments-create-btn"
              onClick={handleCreate}
              disabled={!connected || creating || !createPolicyId || !createAccountId}
            >
              {creating ? 'Creating…' : 'Create deployment'}
            </button>
          </div>
        </div>
        {createError && <div className="deployments-create-error">{createError}</div>}
      </section>

      {loadError && (
        <div className="deployments-error">
          {loadError}
          <button onClick={fetchDeployments}>Retry</button>
        </div>
      )}

      <div className="deployments-list-options">
        <label>
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived deployments
        </label>
      </div>

      {loading ? (
        <div className="deployments-loading">Loading deployments…</div>
      ) : (
        <section className="deployments-table-wrap">
          <table className="deployments-table">
            <thead>
              <tr>
                <th>Policy</th>
                <th>Account</th>
                <th>Mode</th>
                <th>Active</th>
                <th>Created at</th>
                <th>Archive</th>
              </tr>
            </thead>
            <tbody>
              {deployments.length === 0 ? (
                <tr>
                  <td colSpan={6}>No deployments. Create one above.</td>
                </tr>
              ) : (
                deployments.map((d) => (
                  <tr key={d.deployment_id}>
                    <td>{d.policy_version}</td>
                    <td>{accountIdToName.get(d.account_id) ?? d.account_id}</td>
                    <td>{d.account_mode}</td>
                    <td>
                      <button
                        type="button"
                        className={`deployments-toggle ${d.is_active ? 'active' : 'inactive'}`}
                        onClick={() => handleToggleActive(d.deployment_id, d.is_active)}
                        disabled={
                          togglingId === d.deployment_id ||
                          (d.is_active !== 1 && d.policy_status === 'retired')
                        }
                        title={
                          d.is_active !== 1 && d.policy_status === 'retired'
                            ? 'Cannot activate: policy is retired'
                            : d.is_active
                              ? 'Deactivate'
                              : 'Activate'
                        }
                      >
                        {togglingId === d.deployment_id ? '…' : d.is_active ? 'On' : 'Off'}
                      </button>
                    </td>
                    <td>{formatDate(d.created_at)}</td>
                    <td>
                      <button
                        type="button"
                        className="deployments-archive-btn"
                        onClick={() => handleArchive(d.deployment_id)}
                        disabled={!canArchiveDeployment(d) || archivingId === d.deployment_id}
                        title={ARCHIVE_BUTTON_TOOLTIP}
                      >
                        {archivingId === d.deployment_id ? '…' : 'Archive'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
