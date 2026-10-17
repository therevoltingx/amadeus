import { useState, useEffect, useCallback } from 'react';
import { useMcpClient } from '../hooks/useMcpClient';
import './RecommendationsTab.css';

export interface RecommendationRow {
  id: number;
  policy_version: string;
  scope: string;
  source: string;
  source_id: string | null;
  recommendation_type: string;
  payload: Record<string, unknown>;
  confidence: number | null;
  status: string;
  rationale: string | null;
  created_at: number;
  applied_policy_version?: string | null;
  archived?: boolean;
  archived_at?: number | null;
  /** Proposed policy changelog (policy_variant / new_policy). */
  changelog?: string | null;
  /** Proposed new policy_version for policy_variant/new_policy (from agent; read-only in UI). */
  name?: string | null;
}

export function RecommendationsTab() {
  const { callTool, error, connected } = useMcpClient();
  const [items, setItems] = useState<RecommendationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [showArchived, setShowArchived] = useState(false);

  const fetchRecommendations = useCallback(
    async (showLoading = true) => {
      if (!connected) return;
      if (showLoading) setLoading(true);
      setLoadError(null);
      try {
        const args: { limit: number; offset: number; status?: string; include_archived?: boolean } = { limit: 100, offset: 0 };
        if (statusFilter && statusFilter !== 'all') args.status = statusFilter;
        args.include_archived = showArchived;
        const result = await callTool('list_recommendations', args);
        const list = Array.isArray(result) ? result : [];
        setItems(list as RecommendationRow[]);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
        setItems([]);
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [callTool, connected, statusFilter, showArchived]
  );

  useEffect(() => {
    fetchRecommendations(true);
  }, [fetchRecommendations]);

  useEffect(() => {
    const interval = setInterval(() => fetchRecommendations(false), 30_000);
    return () => clearInterval(interval);
  }, [fetchRecommendations]);

  const [applyingId, setApplyingId] = useState<number | null>(null);
  const [applyModal, setApplyModal] = useState<{
    recommendationId: number;
    policyVersion: string;
    isNewPolicy?: boolean;
  } | null>(null);
  const [applyModalResolvedName, setApplyModalResolvedName] = useState('');

  const updateStatus = useCallback(
    async (id: number, status: 'accepted' | 'rejected') => {
      try {
        await callTool('update_recommendation_status', { id, status });
        setItems((prev) => prev.map((r) => (r.id === id ? { ...r, status } : r)));
      } catch (err) {
        console.error('update_recommendation_status failed:', err);
      }
    },
    [callTool]
  );

  const archiveRecommendation = useCallback(
    async (id: number) => {
      try {
        await callTool('archive_recommendation', { id });
        if (!showArchived) {
          setItems((prev) => prev.filter((r) => r.id !== id));
        } else {
          setItems((prev) => prev.map((r) => (r.id === id ? { ...r, archived: true, archived_at: Math.floor(Date.now() / 1000) } : r)));
        }
      } catch (err) {
        console.error('archive_recommendation failed:', err);
      }
    },
    [callTool, showArchived]
  );

  const acceptPolicyRecommendation = useCallback(
    async (recommendationId: number, newPolicyVersion: string) => {
      if (applyingId != null) return;
      setApplyingId(recommendationId);
      try {
        const v = newPolicyVersion.trim();
        await callTool('update_recommendation_name', {
          id: recommendationId,
          name: v === '' ? null : v,
        });
        const result = await callTool('accept_policy_recommendation', {
          recommendation_id: recommendationId,
          new_policy_version: v || undefined,
        });
        const data = typeof result === 'object' && result != null && 'new_policy_version' in result
          ? result as { new_policy_version: string; retired_policy_version: string }
          : null;
        if (data) {
          setItems((prev) => prev.map((r) => r.id === recommendationId ? { ...r, status: 'accepted' } : r));
        }
        setApplyModal(null);
        await fetchRecommendations(false);
      } catch (err) {
        console.error('accept_policy_recommendation failed:', err);
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        setApplyingId(null);
      }
    },
    [callTool, applyingId, fetchRecommendations]
  );

  const resolvePolicyRecommendationName = (r: RecommendationRow): string => {
    const fromName = (r.name ?? '').trim();
    if (fromName) return fromName;
    const isNewPolicy = r.recommendation_type === 'new_policy';
    if (isNewPolicy && r.payload && typeof (r.payload as Record<string, unknown>).policy_version === 'string') {
      return ((r.payload as Record<string, unknown>).policy_version as string).trim();
    }
    if (!isNewPolicy) return `${r.policy_version}-applied-${r.id}`;
    return `new-policy-${r.id}`;
  };

  const formatCreatedAt = (ts: number) => new Date(ts * 1000).toLocaleString();

  const getPayloadDiff = (payload: Record<string, unknown>) => {
    if (payload.parameter != null && payload.current_value !== undefined && payload.proposed_value !== undefined) {
      return {
        parameter: String(payload.parameter),
        current: payload.current_value,
        proposed: payload.proposed_value,
        reason: payload.reason != null ? String(payload.reason) : '',
        metrics_used: Array.isArray(payload.metrics_used) ? payload.metrics_used as string[] : [],
        suggested_duration: payload.suggested_duration != null ? String(payload.suggested_duration) : '',
      };
    }
    return null;
  };

  const getPolicyRecommendationChangelog = (r: RecommendationRow): string => {
    if (r.recommendation_type !== 'policy_variant' && r.recommendation_type !== 'new_policy') return '';
    const fromRow = typeof r.changelog === 'string' ? r.changelog.trim() : '';
    if (fromRow) return fromRow;
    const fromPayload = r.payload?.changelog;
    return typeof fromPayload === 'string' ? fromPayload.trim() : '';
  };

  return (
    <div className="recommendations-tab">
      <header className="recommendations-header">
        <h2>Recommendations</h2>
        <div className="recommendations-status">
          {error && <span className="status-error">MCP: {error}</span>}
          {connected && !error && <span className="status-ok">Connected to MCP</span>}
        </div>
      </header>
      <p className="recommendations-intro">
        Policy variants can be applied to create a new active policy and retire the old one. Warnings and suggestions are advisory only.
      </p>
      <div className="recommendations-filters">
        <label>
          Status{' '}
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="accepted">Accepted</option>
            <option value="rejected">Rejected</option>
            <option value="expired">Expired</option>
          </select>
        </label>
        <label className="recommendations-show-archived">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          {' '}Show archived
        </label>
        <button type="button" onClick={() => fetchRecommendations(true)}>
          Refresh
        </button>
      </div>
      {applyModal && (
        <div className="recommendations-apply-modal-overlay" onClick={() => !applyingId && setApplyModal(null)}>
          <div className="recommendations-apply-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Apply recommendation</h3>
            <p className="recommendations-apply-modal-desc">
              {applyModal.isNewPolicy
                ? (
                    <>
                      This will create a brand-new policy from the recommendation and activate it. The new policy will
                      use the <strong>policy_version</strong> below (same string as the changelog release heading).
                    </>
                  )
                : (
                    <>
                      This will create a new policy, activate it, and retire <strong>{applyModal.policyVersion}</strong>.
                    </>
                  )}
            </p>
            <div className="recommendations-apply-modal-label">
              New policy name (<code>policy_version</code>)
              <div className="recommendations-apply-modal-name-readonly">
                <code>{applyModalResolvedName}</code>
              </div>
            </div>
            <div className="recommendations-apply-modal-actions">
              <button
                type="button"
                className="recommendation-btn recommendation-btn--accept"
                onClick={() =>
                  acceptPolicyRecommendation(applyModal.recommendationId, applyModalResolvedName.trim())
                }
                disabled={applyingId != null}
              >
                {applyingId === applyModal.recommendationId ? 'Applying…' : 'Apply'}
              </button>
              <button
                type="button"
                className="recommendation-btn recommendation-btn--reject"
                onClick={() => !applyingId && setApplyModal(null)}
                disabled={applyingId != null}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {loadError && (
        <div className="recommendations-error">
          {loadError}
          <button onClick={() => fetchRecommendations(true)}>Retry</button>
        </div>
      )}
      {loading ? (
        <div className="recommendations-loading">Loading…</div>
      ) : items.length === 0 ? (
        <div className="recommendations-empty">No recommendations.</div>
      ) : (
        <div className="recommendations-list">
          {items.map((r) => {
            const diff = getPayloadDiff(r.payload);
            return (
              <div key={r.id} className="recommendation-card">
                <div className="recommendation-meta">
                  <span className="recommendation-source">{r.source}</span>
                  {r.source_id && <span className="recommendation-source-id">{r.source_id}</span>}
                  <span className={`recommendation-badge recommendation-badge--${r.status}`}>{r.status}</span>
                  {r.archived && <span className="recommendation-badge recommendation-badge--archived">Archived</span>}
                  {r.confidence != null && (
                    <span className="recommendation-confidence">
                      {(r.confidence * 100).toFixed(0)}% confidence
                    </span>
                  )}
                  <span className="recommendation-created">Created {formatCreatedAt(r.created_at)}</span>
                </div>
                <div className="recommendation-policy">
                  Policy: <strong>{r.policy_version}</strong>
                  {r.applied_policy_version && (
                    <span className="recommendation-applied"> → Applied as: <strong>{r.applied_policy_version}</strong></span>
                  )}
                  {' · '}Scope: {r.scope} · Type: {r.recommendation_type}
                  {(r.recommendation_type === 'policy_variant' || r.recommendation_type === 'new_policy') && (
                    <>
                      {' - '}Name: <strong>{resolvePolicyRecommendationName(r)}</strong>
                      {(r.name ?? '').trim() === '' && (
                        <span className="recommendation-name-fallback-hint"> (fallback)</span>
                      )}
                    </>
                  )}
                </div>
                {diff && (
                  <div className="recommendation-diff">
                    <div className="recommendation-diff-param">{diff.parameter}</div>
                    <div className="recommendation-diff-values">
                      <span className="recommendation-diff-old">{String(diff.current)}</span>
                      <span className="recommendation-diff-arrow">→</span>
                      <span className="recommendation-diff-new">{String(diff.proposed)}</span>
                    </div>
                    {diff.reason && <div className="recommendation-diff-reason">{diff.reason}</div>}
                    {diff.metrics_used.length > 0 && (
                      <div className="recommendation-metrics">
                        Metrics: {diff.metrics_used.join(', ')}
                      </div>
                    )}
                    {diff.suggested_duration && (
                      <div className="recommendation-duration">Suggested: {diff.suggested_duration}</div>
                    )}
                  </div>
                )}
                {(() => {
                  const policyChangelog = getPolicyRecommendationChangelog(r);
                  if (!policyChangelog) return null;
                  return (
                    <div className="recommendation-changelog">
                      <strong className="recommendation-changelog-label">Changelog</strong>
                      <pre className="recommendation-changelog-body">{policyChangelog}</pre>
                    </div>
                  );
                })()}
                {!diff && (() => {
                  const policyChangelog = getPolicyRecommendationChangelog(r);
                  const payloadForJson =
                    policyChangelog && r.payload && typeof r.payload === 'object' && 'changelog' in r.payload
                      ? (() => {
                          const { changelog: _c, ...rest } = r.payload as Record<string, unknown>;
                          return rest;
                        })()
                      : r.payload;
                  return (
                    <pre className="recommendation-payload">{JSON.stringify(payloadForJson, null, 2)}</pre>
                  );
                })()}
                {r.rationale && (
                  <div className="recommendation-rationale">
                    <strong>Rationale:</strong> {r.rationale}
                  </div>
                )}
                {(r.status === 'accepted' || r.status === 'rejected') && !r.archived && (
                  <div className="recommendation-actions">
                    <button
                      type="button"
                      className="recommendation-btn recommendation-btn--archive"
                      onClick={() => archiveRecommendation(r.id)}
                    >
                      Archive
                    </button>
                  </div>
                )}
                {r.status === 'pending' && (
                  <div className="recommendation-actions">
                    {(r.recommendation_type === 'policy_variant' || r.recommendation_type === 'new_policy') ? (
                      <>
                        <button
                          type="button"
                          className="recommendation-btn recommendation-btn--accept"
                          onClick={() => {
                            const isNewPolicy = r.recommendation_type === 'new_policy';
                            setApplyModal({
                              recommendationId: r.id,
                              policyVersion: r.policy_version,
                              isNewPolicy,
                            });
                            setApplyModalResolvedName(resolvePolicyRecommendationName(r));
                          }}
                          disabled={applyingId != null}
                        >
                          {applyingId === r.id ? 'Applying…' : 'Review & Apply'}
                        </button>
                        <button
                          type="button"
                          className="recommendation-btn recommendation-btn--reject"
                          onClick={() => updateStatus(r.id, 'rejected')}
                          disabled={applyingId != null}
                        >
                          Reject
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="recommendation-btn recommendation-btn--accept"
                          onClick={() => updateStatus(r.id, 'accepted')}
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          className="recommendation-btn recommendation-btn--reject"
                          onClick={() => updateStatus(r.id, 'rejected')}
                        >
                          Reject
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
