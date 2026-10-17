import { useState, useEffect, useCallback } from 'react';
import { useMcpClient } from '../hooks/useMcpClient';
import { PairAddressCell } from './PairAddressCell';
import './BacktestsTab.css';

export interface BacktestRunRow {
  id: number;
  label: string | null;
  source: string;
  source_id: string | null;
  policy_display: string | null;
  start_time: number;
  end_time: number;
  status: string;
  trades: number;
  win_rate: number | null;
  avg_pnl: number | null;
  max_drawdown: number | null;
  avg_hold_time_seconds: number | null;
  created_at: number;
  completed_at: number | null;
}

export interface BacktestDetail {
  id: number;
  label: string | null;
  source: string;
  source_id: string | null;
  policy_display: string | null;
  policy_config: Record<string, unknown> | null;
  start_time: number;
  end_time: number;
  status: string;
  created_at: number;
  completed_at: number | null;
  metrics: {
    trades: number;
    wins: number;
    losses: number;
    win_rate: number;
    avg_pnl: number;
    max_drawdown: number;
    avg_hold_time_seconds: number;
    entry_diagnostics_summary?: {
      total_entry_checks: number;
      entries_allowed: number;
      entries_rejected: number;
      rejection_breakdown: Record<string, number>;
    } | null;
  } | null;
  trades: {
    pair_address: string;
    base_symbol?: string | null;
    quote_symbol?: string | null;
    chain?: string | null;
    entry_time: number;
    exit_time: number;
    entry_price: number;
    exit_price: number;
    result: string;
    exit_reason: string;
    pnl: number;
    hold_time_seconds: number;
  }[];
}

type PolicyListScope = 'active_only' | 'all_non_archived' | 'all_including_archived';

type BacktestTimeRange = '4h' | '6h' | '12h' | '24h' | '7d' | 'custom';

const PRESET_RANGE_SECONDS: Record<Exclude<BacktestTimeRange, 'custom'>, number> = {
  '4h': 4 * 3600,
  '6h': 6 * 3600,
  '12h': 12 * 3600,
  '24h': 24 * 3600,
  '7d': 7 * 24 * 3600,
};

function isPresetRange(r: BacktestTimeRange): r is Exclude<BacktestTimeRange, 'custom'> {
  return r !== 'custom';
}

/** `datetime-local` value in local timezone (minute precision; seconds zeroed). */
function unixSecondsToDatetimeLocal(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function datetimeLocalToUnixSeconds(value: string): number | null {
  if (!value.trim()) return null;
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

function formatPolicyOptionLabel(p: {
  policy_version: string;
  status?: string | null;
  archived?: number | null;
}): string {
  const v = p.policy_version ?? '';
  const parts: string[] = [v];
  if (p.archived === 1) parts.push('archived');
  if (p.status && p.status !== 'active') parts.push(p.status);
  return parts.length > 1 ? `${v} (${parts.slice(1).join(', ')})` : v;
}

export function BacktestsTab() {
  const { callTool, connected } = useMcpClient();
  const [runs, setRuns] = useState<BacktestRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<BacktestDetail | null>(null);
  const [policies, setPolicies] = useState<
    { policy_version: string; status?: string | null; archived?: number | null }[]
  >([]);
  const [policyListScope, setPolicyListScope] = useState<PolicyListScope>('active_only');
  const [runForm, setRunForm] = useState({
    policy_version: '',
    range: '24h' as BacktestTimeRange,
    custom_start: '',
    custom_end: '',
    label: '',
  });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const fetchRuns = useCallback(
    async (showLoading = true) => {
      if (!connected) return;
      if (showLoading) setLoading(true);
      setLoadError(null);
      try {
        const result = await callTool('list_backtest_runs', { limit: 50, offset: 0 });
        const list = Array.isArray(result) ? result : [];
        setRuns(list as BacktestRunRow[]);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
        setRuns([]);
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [callTool, connected]
  );

  const fetchPolicies = useCallback(async () => {
    if (!connected) return;
    try {
      const args: Record<string, unknown> = { limit: 500, offset: 0 };
      if (policyListScope === 'active_only') {
        args.status = 'active';
        args.include_archived = false;
      } else if (policyListScope === 'all_non_archived') {
        args.include_archived = false;
      } else {
        args.include_archived = true;
      }
      const result = await callTool('list_policies', args);
      const list = Array.isArray(result) ? result : [];
      setPolicies(
        list.map((p: { policy_version?: string; status?: string | null; archived?: number | null }) => ({
          policy_version: p.policy_version ?? '',
          status: p.status ?? null,
          archived: p.archived ?? null,
        }))
      );
    } catch {
      setPolicies([]);
    }
  }, [callTool, connected, policyListScope]);

  useEffect(() => {
    fetchRuns(true);
    fetchPolicies();
  }, [fetchRuns, fetchPolicies]);

  const hasInProgressRuns = runs.some(
    (r) => r.status === 'queued' || r.status === 'running'
  );
  const selectedRunInProgress =
    selectedId != null &&
    detail != null &&
    (detail.status === 'queued' || detail.status === 'running');

  useEffect(() => {
    const ms = hasInProgressRuns ? 2_000 : 10_000;
    const id = setInterval(() => fetchRuns(false), ms);
    return () => clearInterval(id);
  }, [fetchRuns, hasInProgressRuns]);

  const fetchDetail = useCallback(
    async (id: number) => {
      if (!connected) return;
      try {
        const result = await callTool('get_backtest_run', { backtest_run_id: id });
        setDetail(result as BacktestDetail);
      } catch {
        setDetail(null);
      }
    },
    [callTool, connected]
  );

  useEffect(() => {
    if (selectedId != null) fetchDetail(selectedId);
    else setDetail(null);
  }, [selectedId, fetchDetail]);

  useEffect(() => {
    if (!selectedRunInProgress || selectedId == null) return;
    const id = setInterval(() => fetchDetail(selectedId), 2_000);
    return () => clearInterval(id);
  }, [selectedRunInProgress, selectedId, fetchDetail]);

  const handleRunBacktest = useCallback(async () => {
    if (!connected || submitting) return;
    const now = Math.floor(Date.now() / 1000);
    let startTime: number;
    let endTime: number;
    if (isPresetRange(runForm.range)) {
      const windowSec = PRESET_RANGE_SECONDS[runForm.range];
      startTime = now - windowSec;
      endTime = now;
    } else {
      const s = datetimeLocalToUnixSeconds(runForm.custom_start);
      const e = datetimeLocalToUnixSeconds(runForm.custom_end);
      if (s == null || e == null || s >= e) {
        setSubmitError('Invalid custom time range: choose a start and end, with start before end');
        return;
      }
      startTime = s;
      endTime = e;
    }
    if (!runForm.policy_version.trim()) {
      setSubmitError('Select a policy');
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await callTool('run_policy_backtest', {
        start_time: startTime,
        end_time: endTime,
        source: 'human',
        policy_version: runForm.policy_version.trim(),
        label: runForm.label.trim() || undefined,
      });
      const data = result as { success?: boolean; backtest_run_id?: number };
      if (data?.success && data?.backtest_run_id != null) {
        setSelectedId(data.backtest_run_id);
        setRunForm((f) => ({ ...f, label: '' }));
        await fetchRuns(false);
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [connected, submitting, runForm, callTool, fetchRuns]);

  const formatTs = (ts: number) => new Date(ts * 1000).toLocaleString();
  const formatRange = (start: number, end: number) =>
    `${formatTs(start).slice(0, 16)} – ${formatTs(end).slice(0, 16)}`;

  return (
    <div className="backtests-tab">
      <header className="backtests-header">
        <h2>Backtests</h2>
      </header>

      <div className="backtests-run-form">
        <label>
          Policy list
          <select
            value={policyListScope}
            onChange={(e) => {
              setPolicyListScope(e.target.value as PolicyListScope);
              setRunForm((f) => ({ ...f, policy_version: '' }));
            }}
          >
            <option value="active_only">Active only</option>
            <option value="all_non_archived">All non-archived (draft, active, retired)</option>
            <option value="all_including_archived">All policies including archived</option>
          </select>
        </label>
        <label>
          Policy
          <select
            className="backtests-policy-version-select"
            value={runForm.policy_version}
            onChange={(e) => setRunForm((f) => ({ ...f, policy_version: e.target.value }))}
          >
            <option value="">Select policy</option>
            {policies.map((p) => (
              <option key={p.policy_version} value={p.policy_version}>
                {formatPolicyOptionLabel(p)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Time range
          <select
            value={runForm.range}
            onChange={(e) => {
              const v = e.target.value as BacktestTimeRange;
              setRunForm((f) => {
                if (v !== 'custom') return { ...f, range: v };
                const now = Math.floor(Date.now() / 1000);
                if (f.range === 'custom') {
                  const s = datetimeLocalToUnixSeconds(f.custom_start);
                  const end = datetimeLocalToUnixSeconds(f.custom_end);
                  if (s != null && end != null && s < end) return { ...f, range: v };
                }
                const windowSec = isPresetRange(f.range) ? PRESET_RANGE_SECONDS[f.range] : PRESET_RANGE_SECONDS['24h'];
                const startUnix = now - windowSec;
                return {
                  ...f,
                  range: v,
                  custom_start: unixSecondsToDatetimeLocal(startUnix),
                  custom_end: unixSecondsToDatetimeLocal(now),
                };
              });
            }}
          >
            <option value="4h">Last 4 hours</option>
            <option value="6h">Last 6 hours</option>
            <option value="12h">Last 12 hours</option>
            <option value="24h">Last 24 hours</option>
            <option value="7d">Last 7 days</option>
            <option value="custom">Custom range</option>
          </select>
        </label>
        {runForm.range === 'custom' && (
          <div className="backtests-custom-range">
            <label>
              Start
              <input
                type="datetime-local"
                className="backtests-datetime-local"
                value={runForm.custom_start}
                onChange={(e) => setRunForm((f) => ({ ...f, custom_start: e.target.value }))}
              />
            </label>
            <label>
              End
              <input
                type="datetime-local"
                className="backtests-datetime-local"
                value={runForm.custom_end}
                onChange={(e) => setRunForm((f) => ({ ...f, custom_end: e.target.value }))}
              />
            </label>
          </div>
        )}
        <label>
          Label (optional)
          <input
            type="text"
            value={runForm.label}
            onChange={(e) => setRunForm((f) => ({ ...f, label: e.target.value }))}
            placeholder="e.g. pre-activation test"
          />
        </label>
        <button onClick={handleRunBacktest} disabled={submitting}>
          {submitting ? 'Queuing…' : 'Run backtest'}
        </button>
      </div>
      {submitError && <div className="backtests-load-error">{submitError}</div>}

      {loadError && <div className="backtests-load-error">{loadError}</div>}

      {detail != null && (
        <div className="backtests-back">
          <button type="button" onClick={() => setSelectedId(null)}>
            ← Back to list
          </button>
        </div>
      )}

      {detail != null ? (
        <div className="backtests-detail">
          <h3>Run #{detail.id}</h3>
          <div className="backtests-detail-grid">
            <div className="backtests-detail-row">
              <span className="backtests-detail-label">Policy</span>
              <span className="backtests-detail-value">{detail.policy_display ?? '—'}</span>
            </div>
            <div className="backtests-detail-row">
              <span className="backtests-detail-label">Source</span>
              <span className="backtests-detail-value">
                {detail.source}
                {detail.source_id ? ` (${detail.source_id})` : ''}
              </span>
            </div>
            <div className="backtests-detail-row">
              <span className="backtests-detail-label">Label</span>
              <span className="backtests-detail-value">{detail.label ?? '—'}</span>
            </div>
            <div className="backtests-detail-row">
              <span className="backtests-detail-label">Time range</span>
              <span className="backtests-detail-value">{formatRange(detail.start_time, detail.end_time)}</span>
            </div>
            <div className="backtests-detail-row">
              <span className="backtests-detail-label">Status</span>
              <span className={`backtests-status ${detail.status}`}>{detail.status}</span>
            </div>
          </div>
          {detail.metrics != null && (
            <>
              <h3>Summary</h3>
              <div className="backtests-detail-grid">
                <div className="backtests-detail-row">
                  <span className="backtests-detail-label">Trades</span>
                  <span className="backtests-detail-value">{detail.metrics.trades}</span>
                </div>
                <div className="backtests-detail-row">
                  <span className="backtests-detail-label">Wins / Losses</span>
                  <span className="backtests-detail-value">
                    {detail.metrics.wins} / {detail.metrics.losses}
                  </span>
                </div>
                <div className="backtests-detail-row">
                  <span className="backtests-detail-label">Win rate</span>
                  <span className="backtests-detail-value">
                    {detail.metrics.win_rate != null
                      ? `${(detail.metrics.win_rate * 100).toFixed(1)}%`
                      : '—'}
                  </span>
                </div>
                <div className="backtests-detail-row">
                  <span className="backtests-detail-label">Avg PnL %</span>
                  <span className="backtests-detail-value">
                    {detail.metrics.avg_pnl != null ? `${detail.metrics.avg_pnl.toFixed(2)}%` : '—'}
                  </span>
                </div>
                <div className="backtests-detail-row">
                  <span className="backtests-detail-label">Max drawdown %</span>
                  <span className="backtests-detail-value">
                    {detail.metrics.max_drawdown != null ? `${detail.metrics.max_drawdown.toFixed(2)}%` : '—'}
                  </span>
                </div>
                <div className="backtests-detail-row">
                  <span className="backtests-detail-label">Avg hold (s)</span>
                  <span className="backtests-detail-value">
                    {detail.metrics.avg_hold_time_seconds != null
                      ? Math.round(detail.metrics.avg_hold_time_seconds).toLocaleString()
                      : '—'}
                  </span>
                </div>
              </div>
            </>
          )}
          {detail.metrics?.entry_diagnostics_summary != null && (
            <>
              <h3>Entry diagnostics</h3>
              <div className="backtests-detail-grid backtests-entry-diag-summary">
                <div className="backtests-detail-row">
                  <span className="backtests-detail-label">Total entry attempts</span>
                  <span className="backtests-detail-value">
                    {detail.metrics.entry_diagnostics_summary.total_entry_checks.toLocaleString()}
                  </span>
                </div>
                <div className="backtests-detail-row">
                  <span className="backtests-detail-label">Allowed</span>
                  <span className="backtests-detail-value backtests-result-win">
                    {detail.metrics.entry_diagnostics_summary.entries_allowed.toLocaleString()}
                  </span>
                </div>
                <div className="backtests-detail-row">
                  <span className="backtests-detail-label">Rejected</span>
                  <span className="backtests-detail-value backtests-result-loss">
                    {detail.metrics.entry_diagnostics_summary.entries_rejected.toLocaleString()}
                  </span>
                </div>
              </div>
              <table className="backtests-trades-table backtests-rejection-table">
                <thead>
                  <tr>
                    <th>Reason</th>
                    <th>Count</th>
                    <th>% of attempts</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(detail.metrics.entry_diagnostics_summary.rejection_breakdown)
                    .sort(([, a], [, b]) => b - a)
                    .map(([reason, count]) => {
                      const total = detail.metrics!.entry_diagnostics_summary!.total_entry_checks;
                      const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0';
                      return (
                        <tr key={reason}>
                          <td><code>{reason}</code></td>
                          <td>{count.toLocaleString()}</td>
                          <td>{pct}%</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
              {Object.keys(detail.metrics.entry_diagnostics_summary.rejection_breakdown).length === 0 && (
                <p className="backtests-empty">No rejections recorded.</p>
              )}
            </>
          )}
          <h3>Trades</h3>
          {detail.trades.length === 0 ? (
            <p className="backtests-empty">No trades in this run.</p>
          ) : (
            <table className="backtests-trades-table">
              <thead>
                <tr>
                  <th>Pair</th>
                  <th>Entry → Exit</th>
                  <th>Result</th>
                  <th>Exit reason</th>
                  <th>PnL %</th>
                  <th>Hold (s)</th>
                </tr>
              </thead>
              <tbody>
                {detail.trades.map((t, i) => {
                  const label =
                    t.base_symbol && t.quote_symbol
                      ? `${t.base_symbol}/${t.quote_symbol}`
                      : `${t.pair_address.slice(0, 8)}…${t.pair_address.slice(-6)}`;
                  const dexChain = (t.chain ?? 'solana').toLowerCase();
                  return (
                    <tr key={i}>
                      <td className="backtests-pair-cell">
                        <PairAddressCell
                          address={label}
                          href={`https://dexscreener.com/${dexChain}/${t.pair_address}`}
                          copyValue={t.pair_address}
                          titleAttr={t.pair_address}
                        />
                      </td>
                      <td>
                        {formatTs(t.entry_time).slice(0, 16)} → {formatTs(t.exit_time).slice(0, 16)}
                      </td>
                      <td className={t.result === 'win' ? 'backtests-result-win' : 'backtests-result-loss'}>
                        {t.result}
                      </td>
                      <td>{t.exit_reason}</td>
                      <td>{t.pnl.toFixed(2)}%</td>
                      <td>{t.hold_time_seconds}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <div className="backtests-list">
          {loading ? (
            <div className="backtests-empty">Loading…</div>
          ) : runs.length === 0 ? (
            <div className="backtests-empty">No backtest runs yet. Run one above.</div>
          ) : (
            <table className="backtests-table">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Policy</th>
                  <th>Source</th>
                  <th>Time range</th>
                  <th>Trades</th>
                  <th>Win rate</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr
                    key={r.id}
                    className={selectedId === r.id ? 'selected' : ''}
                    onClick={() => setSelectedId(r.id)}
                  >
                    <td>{r.label ?? '—'}</td>
                    <td>{r.policy_display ?? '—'}</td>
                    <td>{r.source}</td>
                    <td>{formatRange(r.start_time, r.end_time)}</td>
                    <td>{r.trades}</td>
                    <td>{r.win_rate != null ? `${(r.win_rate * 100).toFixed(1)}%` : '—'}</td>
                    <td>
                      <span className={`backtests-status ${r.status}`}>{r.status}</span>
                    </td>
                    <td>{formatTs(r.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
