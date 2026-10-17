import { useState, useEffect, useCallback, useRef } from 'react';
import { useMcpClient } from '../hooks/useMcpClient';
import { PairAddressCell } from './PairAddressCell';
import './PairsTab.css';

export interface Pair {
  id: number;
  pair_address: string;
  chain: string;
  dex: string;
  base_token_address: string;
  quote_token_address: string;
  base_symbol: string;
  quote_symbol: string;
  pair_created_at: number | null;
  creator_wallet: string | null;
  first_seen_at: number;
  tracking_tier?: string;
  method?: string | null;
  source?: string | null;
}

/** Sections for “Eligible for snapshots” help dialog (same rules as workers — PumpSwap). */
const ELIGIBLE_SNAPSHOTS_FILTER_SECTIONS: { title: string; points: string[] }[] = [
  {
    title: 'Overview',
    points: [
      'This count matches PumpSwap pairs the chain snapshots worker, vault swap worker, and scoring worker all treat as in-scope.',
    ],
  },
  {
    title: '1. DEX',
    points: ['Only pairs with dex = pumpswap.'],
  },
  {
    title: '2. Tier or open trade',
    points: [
      'Tracking tier must be ultra_early or active, or the pair has an open trade (a trade_decisions row with no exit_recorded_at).',
    ],
  },
  {
    title: '3. Open trade',
    points: [
      'If there is an open trade, the pair stays eligible regardless of age and LP rules below (snapshots are still needed for pricing).',
    ],
  },
  {
    title: '4. Pair age (when there is no open trade)',
    points: [
      'pair_created_at must fall within max_pair_age_seconds of at least one active policy that allows pumpswap in allowed_dexes.',
      'If a policy leaves max pair age unset, an unbounded window is used for that policy.',
    ],
  },
  {
    title: '5. LP lock (when there is no open trade)',
    points: [
      'No snapshot yet: the pair is eligible once so the worker can record lp_locked from chain.',
      'Otherwise: latest pair_snapshots.lp_locked must be 1, or at least one of those “covering” active policies has Require LP lock off (require_lp_lock = 0).',
      'If every covering policy requires LP lock and the latest snapshot shows liquidity not locked, the pair is excluded.',
    ],
  },
];

export function PairsTab() {
  const { callTool, error, connected } = useMcpClient();
  const [pairs, setPairs] = useState<Pair[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [newPairAddresses, setNewPairAddresses] = useState<Set<string>>(new Set());
  const [newPairCount, setNewPairCount] = useState(0);
  const [selectedPair, setSelectedPair] = useState<Pair | null>(null);
  const [lookupAddress, setLookupAddress] = useState('');
  const [dexFilter, setDexFilter] = useState<string>('');
  const [trackingTierFilter, setTrackingTierFilter] = useState<string>('');
  const [showEligibleForSnapshotsOnly, setShowEligibleForSnapshotsOnly] = useState(false);
  const [sortBy, setSortBy] = useState<'first_seen' | 'age'>('first_seen');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [idSortOrder, setIdSortOrder] = useState<'asc' | 'desc' | null>(null);
  const [detailSnapshots, setDetailSnapshots] = useState<Record<string, unknown>[]>([]);
  const [detailScores, setDetailScores] = useState<Record<string, unknown>[]>([]);
  const [detailDecisions, setDetailDecisions] = useState<Record<string, unknown>[]>([]);
  const [detailTrades, setDetailTrades] = useState<Record<string, unknown>[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [eligibleForSnapshotCount, setEligibleForSnapshotCount] = useState<number | null>(null);
  const [eligibleSnapshotsHelpOpen, setEligibleSnapshotsHelpOpen] = useState(false);
  const prevPairAddressesRef = useRef<Set<string>>(new Set());
  const limit = 50;
  const detailLimit = 25;

  const fetchPairs = useCallback(
    async (showLoading = true) => {
      if (!connected) return;
      if (showLoading) setLoading(true);
      setLoadError(null);
      try {
        const params: {
          limit: number;
          offset: number;
          pair_address?: string;
          dex?: string;
          tracking_tier?: 'ultra_early' | 'active' | 'dormant';
          sort_by?: 'first_seen' | 'age';
          order?: 'asc' | 'desc';
          eligible_for_snapshots?: boolean;
        } = {
          limit,
          offset: page * limit,
          sort_by: sortBy,
          order: sortOrder,
        };
        if (lookupAddress.trim()) params.pair_address = lookupAddress.trim();
        if (dexFilter.trim()) params.dex = dexFilter.trim();
        if (trackingTierFilter && ['ultra_early', 'active', 'dormant'].includes(trackingTierFilter)) {
          params.tracking_tier = trackingTierFilter as 'ultra_early' | 'active' | 'dormant';
        }
        if (showEligibleForSnapshotsOnly) params.eligible_for_snapshots = true;
        const result = await callTool('list_pairs', params);
        const raw = Array.isArray(result) ? result : [];
        const nextPairs = raw.map((p: Record<string, unknown>) => ({
          ...p,
          tracking_tier: p.tracking_tier ?? 'ultra_early',
          method: p.method ?? null,
          source: p.source ?? null,
        })) as Pair[];
        setPairs(nextPairs);

        if (!showLoading && nextPairs.length > 0) {
          const nextAddrs = new Set(nextPairs.map((p: Pair) => p.pair_address));
          const prevAddrs = prevPairAddressesRef.current;
          const added = nextPairs
            .filter((p: Pair) => !prevAddrs.has(p.pair_address))
            .map((p: Pair) => p.pair_address);
          if (added.length > 0) {
            setNewPairAddresses(new Set(added));
            setNewPairCount(added.length);
          }
          prevPairAddressesRef.current = nextAddrs;
        } else if (nextPairs.length > 0) {
          prevPairAddressesRef.current = new Set(nextPairs.map((p: Pair) => p.pair_address));
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
        setPairs([]);
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [callTool, connected, page, lookupAddress, dexFilter, trackingTierFilter, showEligibleForSnapshotsOnly, sortBy, sortOrder]
  );

  useEffect(() => {
    fetchPairs(true);
  }, [fetchPairs]);

  const handleLookup = () => {
    setPage(0);
    fetchPairs(true);
  };

  const clearLookup = () => {
    setLookupAddress('');
    setPage(0);
  };

  useEffect(() => {
    const interval = setInterval(() => fetchPairs(false), 30_000);
    return () => clearInterval(interval);
  }, [fetchPairs]);

  const fetchEligibleSnapshotCount = useCallback(async () => {
    if (!connected || !callTool) return;
    try {
      const out = await callTool('get_eligible_for_snapshot_count', {}) as { count?: number };
      setEligibleForSnapshotCount(typeof out?.count === 'number' ? out.count : null);
    } catch {
      setEligibleForSnapshotCount(null);
    }
  }, [connected, callTool]);

  useEffect(() => {
    fetchEligibleSnapshotCount();
  }, [fetchEligibleSnapshotCount]);

  useEffect(() => {
    const interval = setInterval(fetchEligibleSnapshotCount, 30_000);
    return () => clearInterval(interval);
  }, [fetchEligibleSnapshotCount]);

  useEffect(() => {
    if (!eligibleSnapshotsHelpOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setEligibleSnapshotsHelpOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [eligibleSnapshotsHelpOpen]);

  useEffect(() => {
    if (newPairCount === 0) return;
    const t = setTimeout(() => {
      setNewPairAddresses(new Set());
      setNewPairCount(0);
    }, 4000);
    return () => clearTimeout(t);
  }, [newPairCount]);

  useEffect(() => {
    if (!selectedPair || !connected) {
      setDetailSnapshots([]);
      setDetailScores([]);
      setDetailDecisions([]);
      setDetailTrades([]);
      setDetailError(null);
      return;
    }
    const addr = selectedPair.pair_address;
    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);
    Promise.all([
      callTool('list_snapshots', { limit: detailLimit, offset: 0, pair_address: addr }),
      callTool('list_pair_scores', { limit: detailLimit, offset: 0, pair_address: addr }),
      callTool('list_trade_decisions', { limit: detailLimit, offset: 0, pair_address: addr }),
      callTool('list_trades', { limit: detailLimit, offset: 0, pair_address: addr }),
    ])
      .then(([snap, scores, dec, trades]) => {
        if (cancelled) return;
        setDetailSnapshots(Array.isArray(snap) ? snap : []);
        setDetailScores(Array.isArray(scores) ? scores : []);
        setDetailDecisions(Array.isArray(dec) ? dec : []);
        setDetailTrades(Array.isArray(trades) ? trades : []);
      })
      .catch((err) => {
        if (!cancelled) setDetailError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedPair?.pair_address, connected, callTool, detailLimit]);

  const formatTimestamp = (ts: number | null) => {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleString();
  };

  const formatAge = (createdAt: number | null, firstSeenAt: number) => {
    const ts = createdAt ?? firstSeenAt;
    const sec = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (sec >= 86400) return `${Math.floor(sec / 86400)}d ${h % 24}h`;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  };

  return (
    <div className="pairs-tab">
      <header className="pairs-header">
        <h2>Pairs</h2>
        <div className="pairs-status">
          {eligibleForSnapshotCount != null && (
            <button
              type="button"
              className="pairs-eligible-count-btn"
              onClick={() => setEligibleSnapshotsHelpOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={eligibleSnapshotsHelpOpen}
            >
              {eligibleForSnapshotCount} eligible for snapshots
            </button>
          )}
          {error && <span className="status-error">MCP: {error}</span>}
          {connected && !error && (
            <span className="status-ok">Connected to MCP</span>
          )}
        </div>
      </header>

      <div className="pairs-filters">
        <div className="pairs-filters-card" role="toolbar" aria-label="Pairs list filters">
          <div className="pairs-filters-search">
            <input
              type="text"
              className="pairs-lookup-input"
              placeholder="Address…"
              value={lookupAddress}
              onChange={(e) => setLookupAddress(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleLookup()}
              aria-label="Filter by pair address"
            />
            <button type="button" className="pairs-lookup-btn" onClick={handleLookup}>
              Go
            </button>
            {lookupAddress.trim() && (
              <button type="button" className="pairs-lookup-clear" onClick={clearLookup}>
                ×
              </button>
            )}
          </div>
          <span className="pairs-filters-divider" aria-hidden />
          <label className="pairs-filter-inline">
            <span className="pairs-filter-label">DEX</span>
            <select
              value={dexFilter}
              onChange={(e) => {
                setDexFilter(e.target.value);
                setPage(0);
              }}
              className="pairs-filter-select"
            >
              <option value="">All</option>
              <option value="raydium">Raydium</option>
              <option value="orca">Orca</option>
              <option value="pumpswap">PumpSwap</option>
              <option value="pumpfun">Pump.fun</option>
            </select>
          </label>
          <label className="pairs-filter-inline">
            <span className="pairs-filter-label">Tier</span>
            <select
              value={trackingTierFilter}
              onChange={(e) => {
                setTrackingTierFilter(e.target.value);
                setPage(0);
              }}
              className="pairs-filter-select"
            >
              <option value="">All</option>
              <option value="ultra_early">Ultra early</option>
              <option value="active">Active</option>
              <option value="dormant">Dormant</option>
            </select>
          </label>
          <label
            className={`pairs-eligible-toggle${showEligibleForSnapshotsOnly ? ' pairs-eligible-toggle--on' : ''}`}
          >
            <input
              type="checkbox"
              checked={showEligibleForSnapshotsOnly}
              onChange={(e) => {
                setShowEligibleForSnapshotsOnly(e.target.checked);
                setPage(0);
              }}
            />
            <span>Show eligible</span>
          </label>
          <span className="pairs-filters-divider" aria-hidden />
          <label className="pairs-filter-inline">
            <span className="pairs-filter-label">Sort</span>
            <select
              value={sortBy}
              onChange={(e) => {
                setSortBy(e.target.value as 'first_seen' | 'age');
                setPage(0);
              }}
              className="pairs-filter-select"
            >
              <option value="first_seen">First seen</option>
              <option value="age">Age</option>
            </select>
          </label>
          <label className="pairs-filter-inline">
            <span className="pairs-filter-label">Order</span>
            <select
              value={sortOrder}
              onChange={(e) => {
                setSortOrder(e.target.value as 'asc' | 'desc');
                setPage(0);
              }}
              className="pairs-filter-select"
            >
              <option value="desc">Newest</option>
              <option value="asc">Oldest</option>
            </select>
          </label>
        </div>
      </div>

      {loadError && (
        <div className="pairs-error">
          {loadError}
          <button onClick={() => fetchPairs(true)}>Retry</button>
        </div>
      )}

      {newPairCount > 0 && (
        <div className="pairs-new-indicator">
          {newPairCount} new pair{newPairCount !== 1 ? 's' : ''}
        </div>
      )}

      {loading ? (
        <div className="pairs-loading">Loading pairs…</div>
      ) : (
        <>
          <div className="pairs-table-wrapper">
            <table className="pairs-table">
              <thead>
                <tr>
                  <th
                    className="pairs-th-sortable"
                    title="Database primary key (row id) for this pair — click to sort"
                  >
                    <button
                      type="button"
                      className="pairs-sort-trigger"
                      onClick={() => setIdSortOrder((prev) => (prev === null ? 'desc' : prev === 'desc' ? 'asc' : 'desc'))}
                      aria-label={idSortOrder == null ? 'Sort by ID' : `Sort by ID ${idSortOrder === 'desc' ? 'descending' : 'ascending'}`}
                    >
                      ID
                      <span className="pairs-sort-icons" aria-hidden>
                        <span className={idSortOrder === 'desc' ? 'pairs-sort-active' : undefined}>▼</span>
                        <span className={idSortOrder === 'asc' ? 'pairs-sort-active' : undefined}>▲</span>
                      </span>
                    </button>
                  </th>
                  <th title="BASE/QUOTE">Pair</th>
                  <th>Chain</th>
                  <th>DEX</th>
                  <th>Method</th>
                  <th>Source</th>
                  <th>Tracking Tier</th>
                  <th title="Time since pair was created">Age</th>
                  <th>Created</th>
                  <th>First Seen</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {(idSortOrder == null
                  ? pairs
                  : [...pairs].sort((a, b) =>
                      idSortOrder === 'desc' ? b.id - a.id : a.id - b.id
                    )
                ).map((p) => (
                  <tr
                    key={p.pair_address}
                    className={newPairAddresses.has(p.pair_address) ? 'pairs-row-new' : undefined}
                  >
                    <td>{p.id}</td>
                    <td className="pair-addr" title={p.pair_address}>
                      <PairAddressCell
                        address={p.base_symbol && p.quote_symbol ? `${p.base_symbol}/${p.quote_symbol}` : p.pair_address}
                        href={`https://dexscreener.com/${p.chain}/${p.pair_address}`}
                        copyValue={p.pair_address}
                      />
                    </td>
                    <td>{p.chain}</td>
                    <td>{p.dex}</td>
                    <td>{p.method || '—'}</td>
                    <td>{p.source || '—'}</td>
                    <td>{p.tracking_tier || '—'}</td>
                    <td
                      title={formatTimestamp(p.pair_created_at ?? p.first_seen_at)}
                    >
                      {formatAge(p.pair_created_at, p.first_seen_at)}
                    </td>
                    <td>{formatTimestamp(p.pair_created_at)}</td>
                    <td>{formatTimestamp(p.first_seen_at)}</td>
                    <td>
                      <button
                        type="button"
                        className="pairs-view-btn"
                        onClick={() => setSelectedPair(p)}
                      >
                        View Details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selectedPair && (
            <div
              className="pairs-modal-overlay"
              onClick={() => setSelectedPair(null)}
            >
              <div
                className="pairs-modal pairs-detail-modal"
                onClick={(e) => e.stopPropagation()}
              >
                <h3>Pair: {selectedPair.base_symbol && selectedPair.quote_symbol ? `${selectedPair.base_symbol}/${selectedPair.quote_symbol}` : selectedPair.pair_address}</h3>
                <div className="pairs-detail">
                  <div className="pairs-detail-section">Identifiers</div>
                  <div className="pairs-detail-grid">
                    <div className="pairs-detail-row">
                      <span className="detail-label">ID</span>
                      <span className="detail-value">{selectedPair.id}</span>
                    </div>
                    <div className="pairs-detail-row">
                      <span className="detail-label">Pair address</span>
                      <span className="detail-value">
                        <PairAddressCell
                          address={selectedPair.pair_address}
                          href={`https://dexscreener.com/${selectedPair.chain}/${selectedPair.pair_address}`}
                        />
                      </span>
                    </div>
                    <div className="pairs-detail-row">
                      <span className="detail-label">Chain</span>
                      <span className="detail-value">{selectedPair.chain}</span>
                    </div>
                    <div className="pairs-detail-row">
                      <span className="detail-label">DEX</span>
                      <span className="detail-value">{selectedPair.dex}</span>
                    </div>
                    <div className="pairs-detail-row">
                      <span className="detail-label">Method</span>
                      <span className="detail-value">{selectedPair.method || '—'}</span>
                    </div>
                    <div className="pairs-detail-row">
                      <span className="detail-label">Source</span>
                      <span className="detail-value">{selectedPair.source || '—'}</span>
                    </div>
                    <div className="pairs-detail-row">
                      <span className="detail-label">Tracking tier</span>
                      <span className="detail-value">{selectedPair.tracking_tier || '—'}</span>
                    </div>
                  </div>
                  <div className="pairs-detail-section">Tokens</div>
                  <div className="pairs-detail-grid">
                    <div className="pairs-detail-row">
                      <span className="detail-label">Base symbol</span>
                      <span className="detail-value">{selectedPair.base_symbol}</span>
                    </div>
                    <div className="pairs-detail-row">
                      <span className="detail-label">Quote symbol</span>
                      <span className="detail-value">{selectedPair.quote_symbol}</span>
                    </div>
                    <div className="pairs-detail-row">
                      <span className="detail-label">Base token address</span>
                      <span className="detail-value pairs-detail-addr">{selectedPair.base_token_address}</span>
                    </div>
                    <div className="pairs-detail-row">
                      <span className="detail-label">Quote token address</span>
                      <span className="detail-value pairs-detail-addr">{selectedPair.quote_token_address}</span>
                    </div>
                  </div>
                  <div className="pairs-detail-section">Timestamps</div>
                  <div className="pairs-detail-grid">
                    <div className="pairs-detail-row">
                      <span className="detail-label">Pair created at</span>
                      <span className="detail-value">{formatTimestamp(selectedPair.pair_created_at)}</span>
                    </div>
                    <div className="pairs-detail-row">
                      <span className="detail-label">First seen at</span>
                      <span className="detail-value">{formatTimestamp(selectedPair.first_seen_at)}</span>
                    </div>
                  </div>
                  <div className="pairs-detail-section">Creator</div>
                  <div className="pairs-detail-grid">
                    <div className="pairs-detail-row">
                      <span className="detail-label">Creator wallet</span>
                      <span className="detail-value pairs-detail-addr">{selectedPair.creator_wallet || '—'}</span>
                    </div>
                  </div>

                  {detailError && (
                    <div className="pairs-detail-error">{detailError}</div>
                  )}

                  <div className="pairs-detail-section">Snapshots</div>
                  {detailLoading ? (
                    <div className="pairs-detail-loading">Loading…</div>
                  ) : (
                    <div className="pairs-detail-table-wrap">
                      <table className="pairs-detail-table">
                        <thead>
                          <tr>
                            <th>ID</th>
                            <th>Time</th>
                            <th>Source</th>
                            <th>Method</th>
                            <th>Price USD</th>
                            <th>Liquidity</th>
                            <th>Volume 1m</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detailSnapshots.length === 0 ? (
                            <tr><td colSpan={7}>No snapshots</td></tr>
                          ) : (
                            detailSnapshots.map((s: Record<string, unknown>) => (
                              <tr key={String(s.snapshot_id)}>
                                <td>{String(s.snapshot_id ?? '—')}</td>
                                <td>{formatTimestamp(s.timestamp as number)}</td>
                                <td>{s.source != null ? String(s.source) : '—'}</td>
                                <td>{s.method != null ? String(s.method) : '—'}</td>
                                <td>{s.price_usd != null ? Number(s.price_usd).toLocaleString(undefined, { maximumFractionDigits: 6 }) : '—'}</td>
                                <td>{s.liquidity_usd != null ? Number(s.liquidity_usd).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}</td>
                                <td>{s.volume_1m != null ? Number(s.volume_1m).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div className="pairs-detail-section">Scores</div>
                  {detailLoading ? (
                    <div className="pairs-detail-loading">Loading…</div>
                  ) : (
                    <div className="pairs-detail-table-wrap">
                      <table className="pairs-detail-table">
                        <thead>
                          <tr>
                            <th>Scored at</th>
                            <th>Policy</th>
                            <th>Signal</th>
                            <th>Score</th>
                            <th>Eligible</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detailScores.length === 0 ? (
                            <tr><td colSpan={5}>No scores</td></tr>
                          ) : (
                            detailScores.map((s: Record<string, unknown>) => (
                              <tr key={String(s.id ?? s.scored_at)}>
                                <td>{formatTimestamp(s.scored_at as number)}</td>
                                <td className="pairs-detail-mono">{String(s.policy_version ?? '—')}</td>
                                <td>{String(s.signal ?? '—')}</td>
                                <td>{s.total_score != null ? Number(s.total_score).toFixed(2) : '—'}</td>
                                <td>{s.eligible ? 'Yes' : 'No'}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div className="pairs-detail-section">Decisions</div>
                  {detailLoading ? (
                    <div className="pairs-detail-loading">Loading…</div>
                  ) : (
                    <div className="pairs-detail-table-wrap">
                      <table className="pairs-detail-table">
                        <thead>
                          <tr>
                            <th>ID</th>
                            <th>Policy</th>
                            <th>Signal</th>
                            <th>Entry $</th>
                            <th>Size $</th>
                            <th>Executed</th>
                            <th>Closed</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detailDecisions.length === 0 ? (
                            <tr><td colSpan={7}>No decisions</td></tr>
                          ) : (
                            detailDecisions.map((d: Record<string, unknown>) => (
                              <tr key={String(d.trade_id)}>
                                <td>{String(d.trade_id ?? '—')}</td>
                                <td className="pairs-detail-mono">{String(d.policy_version ?? '—')}</td>
                                <td>{String(d.signal ?? '—')}</td>
                                <td>{d.entry_price != null ? Number(d.entry_price).toFixed(4) : '—'}</td>
                                <td>{d.position_size_usd != null ? Number(d.position_size_usd).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—'}</td>
                                <td>{formatTimestamp(d.executed_at as number)}</td>
                                <td>{d.exit_recorded_at ? 'Yes' : 'No'}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <div className="pairs-detail-section">Trades</div>
                  {detailLoading ? (
                    <div className="pairs-detail-loading">Loading…</div>
                  ) : (
                    <div className="pairs-detail-table-wrap">
                      <table className="pairs-detail-table">
                        <thead>
                          <tr>
                            <th>ID</th>
                            <th>Policy</th>
                            <th>Entry</th>
                            <th>Exit</th>
                            <th>PnL %</th>
                            <th>Reason</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detailTrades.length === 0 ? (
                            <tr><td colSpan={6}>No trades</td></tr>
                          ) : (
                            detailTrades.map((t: Record<string, unknown>) => (
                              <tr key={String(t.trade_id)}>
                                <td>{String(t.trade_id ?? '—')}</td>
                                <td className="pairs-detail-mono">{String(t.policy_version ?? '—')}</td>
                                <td>{formatTimestamp(t.entry_time as number)}</td>
                                <td>{formatTimestamp(t.exit_time as number)}</td>
                                <td className={typeof t.pnl_pct === 'number' && t.pnl_pct < 0 ? 'pairs-detail-negative' : 'pairs-detail-positive'}>
                                  {t.pnl_pct != null ? `${Number(t.pnl_pct).toFixed(2)}%` : '—'}
                                </td>
                                <td>{String(t.exit_reason ?? '—')}</td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
                <div className="pairs-detail-buttons">
                  <button type="button" onClick={() => setSelectedPair(null)}>
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="pairs-pagination">
            <button
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </button>
            <span>Page {page + 1}</span>
            <button
              disabled={pairs.length < limit}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}

      {eligibleSnapshotsHelpOpen && (
        <div
          className="pairs-modal-overlay"
          role="presentation"
          onClick={() => setEligibleSnapshotsHelpOpen(false)}
        >
          <div
            className="pairs-modal pairs-eligible-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pairs-eligible-dialog-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="pairs-eligible-dialog-title">Eligible for snapshots</h3>
            <div className="pairs-eligible-dialog-body">
              <p className="pairs-eligible-dialog-lead">
                All of these rules apply together. Workers use the same SQL filter.
              </p>
              {ELIGIBLE_SNAPSHOTS_FILTER_SECTIONS.map((section) => (
                <section key={section.title} className="pairs-eligible-dialog-section">
                  <h4>{section.title}</h4>
                  <ul>
                    {section.points.map((pt, i) => (
                      <li key={`${section.title}-${i}`}>{pt}</li>
                    ))}
                  </ul>
                </section>
              ))}
              <p className="pairs-eligible-dialog-hint">Click outside or press Escape to close.</p>
              <div className="pairs-eligible-dialog-actions">
                <button type="button" onClick={() => setEligibleSnapshotsHelpOpen(false)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
