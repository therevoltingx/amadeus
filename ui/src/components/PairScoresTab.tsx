import { useState, useEffect, useCallback, useRef } from 'react';
import { useMcpClient } from '../hooks/useMcpClient';
import { PairAddressCell } from './PairAddressCell';
import './PairScoresTab.css';

interface ScoreSnapshot {
  snapshot_id: number;
  pair_address: string;
  chain: string;
  source?: string | null;
  method?: string | null;
  timestamp: number;
  seconds_since_creation: number | null;
  price_usd: number | null;
  price_change_5m: number | null;
  market_cap: number | null;
  fdv: number | null;
  liquidity_usd: number | null;
  volume_1m: number | null;
  volume_5m: number | null;
  buys_1m: number | null;
  sells_1m: number | null;
  buy_sell_ratio_1m: number | null;
  top_holder_pct: number | null;
  top_5_holder_pct: number | null;
  holder_count: number | null;
  wallet_concentration_score: number | null;
}

export interface PairScore {
  id: number;
  pair_address: string;
  dex?: string | null;
  base_symbol?: string | null;
  quote_symbol?: string | null;
  chain: string;
  scored_at: number;
  policy_version: string;
  eligible: number;
  reject_reason: string | null;
  reject_stage: string | null;
  total_score: number | null;
  score_normalized: number | null;
  signal: string | null;
  confidence_level: string | null;
  feature_values: string | null;
  feature_weights: string | null;
  feature_contributions: string | null;
  penalty_contributions: string | null;
  snapshot_ids: string | null;
  snapshot_window_seconds: number | null;
  missing_feature_count: number | null;
  missing_features: string | null;
  used_fallback_values: number | null;
  data_quality_score: number | null;
  worker_version: string | null;
  run_id: string | null;
  notes: string | null;
}

export function PairScoresTab() {
  const { callTool, error, connected } = useMcpClient();
  const [scores, setScores] = useState<PairScore[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [signalFilter, setSignalFilter] = useState<string>('');
  const [eligibleFilter, setEligibleFilter] = useState<string>('');
  const [dexFilter, setDexFilter] = useState<string>('');
  const [pairAddressFilter, setPairAddressFilter] = useState<string>('');
  const [policyVersionFilter, setPolicyVersionFilter] = useState<string>('');
  const [activePolicies, setActivePolicies] = useState<{ policy_version: string }[]>([]);
  const [selectedScore, setSelectedScore] = useState<PairScore | null>(null);
  const [scoreDetailSnapshots, setScoreDetailSnapshots] = useState<ScoreSnapshot[]>([]);
  const [scoreDetailSnapshotsLoading, setScoreDetailSnapshotsLoading] = useState(false);
  const [newScoreIds, setNewScoreIds] = useState<Set<number>>(new Set());
  const [newScoreCount, setNewScoreCount] = useState(0);
  const prevScoreIdsRef = useRef<Set<number>>(new Set());
  const limit = 50;

  const fetchActivePolicies = useCallback(async () => {
    if (!connected) return;
    try {
      const result = await callTool('list_policies', { status: 'active', limit: 100, offset: 0 });
      const list = Array.isArray(result) ? result : [];
      const policies = list
        .map((r: { policy_version?: string }) => r?.policy_version)
        .filter((v: unknown): v is string => typeof v === 'string' && v.length > 0)
        .map((policy_version) => ({ policy_version }));
      setActivePolicies(policies);
    } catch {
      setActivePolicies([]);
    }
  }, [callTool, connected]);

  const fetchScores = useCallback(
    async (showLoading = true) => {
      if (!connected) return;
      if (showLoading) setLoading(true);
      setLoadError(null);
      try {
        const args: {
          limit: number;
          offset: number;
          signal?: string;
          eligible?: boolean;
          dex?: string;
          pair_address?: string;
          policy_version?: string;
        } = {
          limit,
          offset: page * limit,
        };
        if (signalFilter) args.signal = signalFilter;
        if (eligibleFilter === 'yes') args.eligible = true;
        if (eligibleFilter === 'no') args.eligible = false;
        if (dexFilter) args.dex = dexFilter;
        if (pairAddressFilter.trim()) args.pair_address = pairAddressFilter.trim();
        if (policyVersionFilter) args.policy_version = policyVersionFilter;
        const result = await callTool('list_pair_scores', args);
        const nextScores = Array.isArray(result) ? result : [];
        setScores(nextScores);

        if (!showLoading && nextScores.length > 0) {
          const nextIds = new Set(nextScores.map((r: PairScore) => r.id));
          const prevIds = prevScoreIdsRef.current;
          const added = nextScores.filter((r: PairScore) => !prevIds.has(r.id)).map((r: PairScore) => r.id);
          if (added.length > 0) {
            setNewScoreIds(new Set(added));
            setNewScoreCount(added.length);
          }
          prevScoreIdsRef.current = nextIds;
        } else if (nextScores.length > 0) {
          prevScoreIdsRef.current = new Set(nextScores.map((r: PairScore) => r.id));
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
        setScores([]);
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [callTool, connected, page, signalFilter, eligibleFilter, dexFilter, pairAddressFilter, policyVersionFilter]
  );

  useEffect(() => {
    fetchActivePolicies();
  }, [fetchActivePolicies]);

  useEffect(() => {
    fetchScores(true);
  }, [fetchScores]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchScores(false);
    }, 30_000);
    return () => clearInterval(interval);
  }, [fetchScores]);

  useEffect(() => {
    if (newScoreCount === 0) return;
    const t = setTimeout(() => {
      setNewScoreIds(new Set());
      setNewScoreCount(0);
    }, 4000);
    return () => clearTimeout(t);
  }, [newScoreCount]);

  useEffect(() => {
    if (!selectedScore?.snapshot_ids || !connected || !callTool) {
      setScoreDetailSnapshots([]);
      return;
    }
    let ids: number[];
    try {
      ids = JSON.parse(selectedScore.snapshot_ids);
    } catch {
      setScoreDetailSnapshots([]);
      return;
    }
    if (!Array.isArray(ids) || ids.length === 0) {
      setScoreDetailSnapshots([]);
      return;
    }
    let cancelled = false;
    setScoreDetailSnapshotsLoading(true);
    setScoreDetailSnapshots([]);
    callTool('get_snapshots_by_ids', { snapshot_ids: ids })
      .then((result) => {
        if (!cancelled && Array.isArray(result)) {
          setScoreDetailSnapshots(result);
        }
      })
      .catch(() => {
        if (!cancelled) setScoreDetailSnapshots([]);
      })
      .finally(() => {
        if (!cancelled) setScoreDetailSnapshotsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedScore?.id, selectedScore?.snapshot_ids, connected, callTool]);

  const formatTimestamp = (ts: number | null) =>
    ts != null ? new Date(ts * 1000).toLocaleString() : '—';

const fmtNum = (n: number | null | undefined, decimals = 2) =>
    n != null ? n.toLocaleString(undefined, { maximumFractionDigits: decimals }) : '—';

  const FEATURE_LABELS: Record<string, string> = {
    liquidity_velocity: 'Liquidity velocity',
    liquidity_absolute: 'Liquidity absolute',
    volume_1m: 'Volume 1m',
    volume_5m: 'Volume 5m',
    volume_acceleration_1m: 'Volume acceleration 1m',
    price_volatility: 'Price volatility',
    market_cap: 'Market cap',
    buy_sell_slope: 'Buy/sell slope',
    price_momentum: 'Price momentum',
    holder_concentration_penalty: 'Holder concentration penalty',
  };

  const getMissingFeatureNames = (score: PairScore): string[] => {
    if (score.missing_features) {
      try {
        const parsed = JSON.parse(score.missing_features) as string[];
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        /* fall through to feature_values */
      }
    }
    if (!score.feature_values) return [];
    try {
      const fv = JSON.parse(score.feature_values) as Record<string, unknown>;
      return (Object.keys(FEATURE_LABELS) as string[]).filter(
        (k) => fv[k] == null || (typeof fv[k] === 'number' && !Number.isFinite(fv[k] as number))
      ).map((k) => FEATURE_LABELS[k]);
    } catch {
      return [];
    }
  };

  const chain = 'solana';

  const signalClass = (s: string | null) => {
    if (!s) return '';
    if (s === 'PRIORITY_TRADE') return 'signal-priority';
    if (s === 'TRADE_CANDIDATE') return 'signal-candidate';
    if (s === 'WATCH') return 'signal-watch';
    return 'signal-no-trade';
  };

  return (
    <div className="pair-scores-tab">
      <header className="pair-scores-header">
        <h2>Pair Scores</h2>
        <div className="pair-scores-controls">
          <select
            value={signalFilter}
            onChange={(e) => {
              setSignalFilter(e.target.value);
              setPage(0);
            }}
          >
            <option value="">All signals</option>
            <option value="NO_TRADE">No trade</option>
            <option value="WATCH">Watch</option>
            <option value="TRADE_CANDIDATE">Trade candidate</option>
            <option value="PRIORITY_TRADE">Priority trade</option>
          </select>
          <select
            value={eligibleFilter}
            onChange={(e) => {
              setEligibleFilter(e.target.value);
              setPage(0);
            }}
          >
            <option value="">All eligibility</option>
            <option value="yes">Eligible</option>
            <option value="no">Ineligible</option>
          </select>
          <select
            value={dexFilter}
            onChange={(e) => {
              setDexFilter(e.target.value);
              setPage(0);
            }}
            title="Filter by DEX"
          >
            <option value="">All DEXs</option>
            <option value="raydium">raydium</option>
            <option value="orca">orca</option>
            <option value="pumpswap">pumpswap</option>
            <option value="pumpfun">pumpfun</option>
          </select>
          <input
            type="text"
            value={pairAddressFilter}
            onChange={(e) => {
              setPairAddressFilter(e.target.value);
              setPage(0);
            }}
            placeholder="Pair address…"
            title="Filter by pair address (prefix match)"
            className="pair-scores-pair-filter"
          />
          <select
            value={policyVersionFilter}
            onChange={(e) => {
              setPolicyVersionFilter(e.target.value);
              setPage(0);
            }}
            title="Filter by active policy"
          >
            <option value="">All policies</option>
            {activePolicies.map((p) => (
              <option key={p.policy_version} value={p.policy_version}>
                {p.policy_version}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="pair-scores-refresh-btn"
            onClick={() => fetchScores(true)}
            disabled={loading}
          >
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <div className="pair-scores-status">
            {error && <span className="status-error">MCP: {error}</span>}
            {connected && !error && (
              <span className="status-ok">Connected to MCP</span>
            )}
          </div>
        </div>
      </header>

      {selectedScore && (
        <div
          className="pair-scores-modal-overlay"
          onClick={() => setSelectedScore(null)}
        >
          <div
            className="pair-scores-detail-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>
              Score #{selectedScore.id} —{' '}
              {selectedScore.base_symbol && selectedScore.quote_symbol
                ? `${selectedScore.base_symbol}/${selectedScore.quote_symbol}`
                : selectedScore.pair_address.slice(0, 12) + '…'}
            </h3>
            <div className="pair-scores-detail">
              <div className="pair-scores-detail-section">Summary</div>
              <div className="pair-scores-detail-grid">
                <div className="pair-scores-detail-row">
                  <span className="detail-label">Pair address</span>
                  <a
                    href={`https://dexscreener.com/${chain}/${selectedScore.pair_address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="detail-link"
                  >
                    {selectedScore.pair_address}
                  </a>
                </div>
                <div className="pair-scores-detail-row">
                  <span className="detail-label">Scored at</span>
                  <span className="detail-value">{formatTimestamp(selectedScore.scored_at)}</span>
                </div>
                <div className="pair-scores-detail-row">
                  <span className="detail-label">Policy</span>
                  <span className="detail-value">{selectedScore.policy_version}</span>
                </div>
                <div className="pair-scores-detail-row">
                  <span className="detail-label">Eligible</span>
                  <span className="detail-value">{selectedScore.eligible === 1 ? 'Yes' : 'No'}</span>
                </div>
                <div className="pair-scores-detail-row">
                  <span className="detail-label">Reject reason</span>
                  <span className="detail-value">{selectedScore.reject_reason ?? '—'}</span>
                </div>
                <div className="pair-scores-detail-row">
                  <span className="detail-label">Reject stage</span>
                  <span className="detail-value">{selectedScore.reject_stage ?? '—'}</span>
                </div>
                <div className="pair-scores-detail-row">
                  <span className="detail-label">Total score</span>
                  <span className="detail-value">{fmtNum(selectedScore.total_score, 4)}</span>
                </div>
                <div className="pair-scores-detail-row">
                  <span className="detail-label">Score normalized</span>
                  <span className="detail-value">{fmtNum(selectedScore.score_normalized, 2)}</span>
                </div>
                <div className="pair-scores-detail-row">
                  <span className="detail-label">Signal</span>
                  <span className={`detail-value ${signalClass(selectedScore.signal)}`}>{selectedScore.signal ?? '—'}</span>
                </div>
                <div className="pair-scores-detail-row">
                  <span className="detail-label">Confidence</span>
                  <span className="detail-value">{selectedScore.confidence_level ?? '—'}</span>
                </div>
              </div>
              <div className="pair-scores-detail-section">Data quality</div>
              <div className="pair-scores-detail-grid">
                <div className="pair-scores-detail-row">
                  <span className="detail-label">Missing features</span>
                  <span className="detail-value">
                    {(selectedScore.missing_feature_count ?? 0) > 0 ? (
                      (() => {
                        const missing = getMissingFeatureNames(selectedScore);
                        return missing.length > 0 ? (
                          <>
                            {selectedScore.missing_feature_count} —{' '}
                            <span className="pair-scores-missing-list">{missing.join(', ')}</span>
                          </>
                        ) : (
                          selectedScore.missing_feature_count
                        );
                      })()
                    ) : (
                      '—'
                    )}
                  </span>
                </div>
                <div className="pair-scores-detail-row">
                  <span className="detail-label">Used fallback</span>
                  <span className="detail-value">{selectedScore.used_fallback_values === 1 ? 'Yes' : 'No'}</span>
                </div>
                <div className="pair-scores-detail-row">
                  <span className="detail-label">Data quality score</span>
                  <span className="detail-value">{fmtNum(selectedScore.data_quality_score, 2)}</span>
                </div>
                <div className="pair-scores-detail-row">
                  <span className="detail-label">Snapshot window (sec)</span>
                  <span className="detail-value">{selectedScore.snapshot_window_seconds ?? '—'}</span>
                </div>
                <div className="pair-scores-detail-row">
                  <span className="detail-label">Worker version</span>
                  <span className="detail-value">{selectedScore.worker_version ?? '—'}</span>
                </div>
                <div className="pair-scores-detail-row">
                  <span className="detail-label">Run ID</span>
                  <span className="detail-value detail-mono">{selectedScore.run_id ?? '—'}</span>
                </div>
              </div>
              {selectedScore.feature_values && (
                <>
                  <div className="pair-scores-detail-section">Feature values</div>
                  <pre className="pair-scores-detail-json">{selectedScore.feature_values}</pre>
                </>
              )}
              {selectedScore.feature_weights && (
                <>
                  <div className="pair-scores-detail-section">Feature weights</div>
                  <pre className="pair-scores-detail-json">{selectedScore.feature_weights}</pre>
                </>
              )}
              {selectedScore.feature_contributions && (
                <>
                  <div className="pair-scores-detail-section">Feature contributions</div>
                  <pre className="pair-scores-detail-json">{selectedScore.feature_contributions}</pre>
                </>
              )}
              {selectedScore.penalty_contributions && (
                <>
                  <div className="pair-scores-detail-section">Penalty contributions</div>
                  <pre className="pair-scores-detail-json">{selectedScore.penalty_contributions}</pre>
                </>
              )}
              {selectedScore.snapshot_ids && (
                <>
                  <div className="pair-scores-detail-section">Snapshots used</div>
                  {scoreDetailSnapshotsLoading ? (
                    <p className="pair-scores-detail-notes">Loading snapshots…</p>
                  ) : scoreDetailSnapshots.length > 0 ? (
                    <div className="pair-scores-snapshots-table-wrapper">
                      <table className="pair-scores-snapshots-table">
                        <thead>
                          <tr>
                            <th>ID</th>
                            <th>Time</th>
                            <th>Source</th>
                            <th>Method</th>
                            <th>Age</th>
                            <th>Price $</th>
                            <th>Liq $</th>
                            <th>Vol 1m</th>
                            <th>Vol 5m</th>
                            <th>Buys</th>
                            <th>Sells</th>
                            <th>B/S</th>
                            <th>Top %</th>
                            <th>Holders</th>
                          </tr>
                        </thead>
                        <tbody>
                          {scoreDetailSnapshots.map((sn) => (
                            <tr key={sn.snapshot_id}>
                              <td>{sn.snapshot_id}</td>
                              <td>{formatTimestamp(sn.timestamp)}</td>
                              <td>{sn.source ?? '—'}</td>
                              <td>{sn.method ?? '—'}</td>
                              <td>{sn.seconds_since_creation != null ? `${Math.floor(sn.seconds_since_creation / 60)}m` : '—'}</td>
                              <td>${fmtNum(sn.price_usd, 8)}</td>
                              <td>${fmtNum(sn.liquidity_usd, 0)}</td>
                              <td>${fmtNum(sn.volume_1m, 0)}</td>
                              <td>${fmtNum(sn.volume_5m, 0)}</td>
                              <td>{sn.buys_1m ?? '—'}</td>
                              <td>{sn.sells_1m ?? '—'}</td>
                              <td>{fmtNum(sn.buy_sell_ratio_1m, 2)}</td>
                              <td>{fmtNum(sn.top_holder_pct, 1)}</td>
                              <td>{sn.holder_count ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="pair-scores-detail-notes">Snapshot IDs: {selectedScore.snapshot_ids}</p>
                  )}
                </>
              )}
              {selectedScore.notes && (
                <>
                  <div className="pair-scores-detail-section">Notes</div>
                  <p className="pair-scores-detail-notes">{selectedScore.notes}</p>
                </>
              )}
            </div>
            <div className="pair-scores-detail-buttons">
              <button type="button" onClick={() => setSelectedScore(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {loadError && (
        <div className="pair-scores-error">
          {loadError}
          <button onClick={() => fetchScores(true)}>Retry</button>
        </div>
      )}

      {loading ? (
        <div className="pair-scores-loading">Loading pair scores…</div>
      ) : (
        <>
          <div className="pair-scores-table-wrapper">
            <table className="pair-scores-table">
              <thead>
                <tr>
                  <th title="Unique score record ID">ID</th>
                  <th title="BASE/QUOTE">Pair</th>
                  <th title="Decentralized exchange where the pair is listed (e.g. pumpfun, pumpswap)">DEX</th>
                  <th title="When this pair was scored (Unix timestamp)">Scored</th>
                  <th title="Policy version used for this scoring run">Policy</th>
                  <th title="Whether the pair passed all policy filters (1 = yes, 0 = no)">Eligible</th>
                  <th title="Reason the pair was rejected, if not eligible">Reject</th>
                  <th title="Trading signal: NO_TRADE, WATCH, TRADE_CANDIDATE, or PRIORITY_TRADE">Signal</th>
                  <th title="Confidence level of the score (LOW, MEDIUM, HIGH)">Confidence</th>
                  <th title="Open detailed score breakdown (features, contributions, snapshots)">Actions</th>
                </tr>
              </thead>
              <tbody>
                {scores.map((s) => (
                  <tr
                    key={s.id}
                    className={newScoreIds.has(s.id) ? 'pair-scores-row-new' : undefined}
                  >
                    <td>{s.id}</td>
                    <td className="pair-addr" title={s.pair_address}>
                      <span className="pair-scores-pair-cell">
                        <PairAddressCell
                          address={s.base_symbol && s.quote_symbol ? `${s.base_symbol}/${s.quote_symbol}` : s.pair_address}
                          href={`https://dexscreener.com/${chain}/${s.pair_address}`}
                          copyValue={s.pair_address}
                        />
                        <button
                          type="button"
                          className="pair-scores-filter-pair-btn"
                          onClick={() => {
                            setPairAddressFilter(s.pair_address);
                            setPage(0);
                          }}
                          title="Filter scores to this pair only"
                          aria-label="Filter scores to this pair only"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                          </svg>
                        </button>
                      </span>
                    </td>
                    <td>{s.dex ?? '—'}</td>
                    <td>{formatTimestamp(s.scored_at)}</td>
                    <td>{s.policy_version}</td>
                    <td>{s.eligible === 1 ? 'Yes' : 'No'}</td>
                    <td className="reject-cell" title={s.reject_reason ?? undefined}>
                      {s.reject_reason
                        ? s.reject_reason.length > 25
                          ? s.reject_reason.slice(0, 25) + '…'
                          : s.reject_reason
                        : '—'}
                    </td>
                    <td className={signalClass(s.signal)}>{s.signal ?? '—'}</td>
                    <td>{s.confidence_level ?? '—'}</td>
                    <td>
                      <button
                        type="button"
                        className="pair-scores-view-btn"
                        onClick={() => setSelectedScore(s)}
                      >
                        View Details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pair-scores-pagination">
            <button
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </button>
            <span>Page {page + 1}</span>
            <button
              disabled={scores.length < limit}
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
