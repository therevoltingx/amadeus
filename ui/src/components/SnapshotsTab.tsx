import { useState, useEffect, useCallback, useRef } from 'react';
import { useMcpClient } from '../hooks/useMcpClient';
import { PairAddressCell } from './PairAddressCell';
import './SnapshotsTab.css';

export interface Snapshot {
  snapshot_id: number;
  pair_address: string;
  chain: string;
  dex: string;
  snapshot_reason?: string | null;
  method?: string | null;
  source?: string | null;
  base_symbol?: string | null;
  quote_symbol?: string | null;
  tracking_tier?: string | null;
  timestamp: number;
  seconds_since_creation: number | null;
  price_usd: number | null;
  price_change_1m: number | null;
  price_change_5m: number | null;
  market_cap: number | null;
  fdv: number | null;
  liquidity_usd: number | null;
  liquidity_change_1m: number | null;
  lp_locked: number | null;
  lp_lock_duration: number | null;
  volume_1m: number | null;
  volume_5m: number | null;
  volume_15m: number | null;
  buy_volume_1m?: number | null;
  buy_volume_5m?: number | null;
  buy_volume_15m?: number | null;
  sell_volume_1m?: number | null;
  sell_volume_5m?: number | null;
  sell_volume_15m?: number | null;
  total_volume: number | null;
  buys_1m: number | null;
  sells_1m: number | null;
  transactions_1m?: number | null;
  velocity_score_1m?: number | null;
  buy_sell_ratio_1m: number | null;
  buy_pressure_1m?: number | null;
  sell_pressure_1m?: number | null;
  total_buys: number | null;
  total_sells: number | null;
  total_transactions: number | null;
  buy_sell_ratio: number | null;
  volume_acceleration_1m: number | null;
  has_mint_authority: number | null;
  has_freeze_authority: number | null;
  can_remove_liquidity: number | null;
  honeypot_flag: number | null;
  top_holder_pct: number | null;
  top_5_holder_pct: number | null;
  holder_count: number | null;
  wallet_concentration_score: number | null;
}

export function SnapshotsTab() {
  const { callTool, error, connected } = useMcpClient();
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [dexFilter, setDexFilter] = useState<string>('');
  const [pairAddressFilter, setPairAddressFilter] = useState<string>('');
  const [newSnapshotIds, setNewSnapshotIds] = useState<Set<number>>(new Set());
  const [newSnapshotCount, setNewSnapshotCount] = useState(0);
  const [selectedSnapshot, setSelectedSnapshot] = useState<Snapshot | null>(null);
  const prevSnapshotIdsRef = useRef<Set<number>>(new Set());
  const limit = 50;

  const fetchSnapshots = useCallback(
    async (showLoading = true) => {
      if (!connected) return;
      if (showLoading) setLoading(true);
      setLoadError(null);
      try {
        const result = await callTool('list_snapshots', {
          limit,
          offset: page * limit,
          dex: dexFilter || undefined,
          pair_address: pairAddressFilter.trim() || undefined,
        });
        const nextSnapshots = Array.isArray(result) ? result : [];
        setSnapshots(nextSnapshots);

        if (!showLoading && nextSnapshots.length > 0) {
          const nextIds = new Set(nextSnapshots.map((s: Snapshot) => s.snapshot_id));
          const prevIds = prevSnapshotIdsRef.current;
          const added = nextSnapshots
            .filter((s: Snapshot) => !prevIds.has(s.snapshot_id))
            .map((s: Snapshot) => s.snapshot_id);
          if (added.length > 0) {
            setNewSnapshotIds(new Set(added));
            setNewSnapshotCount(added.length);
          }
          prevSnapshotIdsRef.current = nextIds;
        } else if (nextSnapshots.length > 0) {
          prevSnapshotIdsRef.current = new Set(nextSnapshots.map((s: Snapshot) => s.snapshot_id));
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
        setSnapshots([]);
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [callTool, connected, page, dexFilter, pairAddressFilter]
  );

  useEffect(() => {
    fetchSnapshots(true);
  }, [fetchSnapshots]);

  useEffect(() => {
    const interval = setInterval(() => fetchSnapshots(false), 30_000);
    return () => clearInterval(interval);
  }, [fetchSnapshots]);

  useEffect(() => {
    if (newSnapshotCount === 0) return;
    const t = setTimeout(() => {
      setNewSnapshotIds(new Set());
      setNewSnapshotCount(0);
    }, 4000);
    return () => clearTimeout(t);
  }, [newSnapshotCount]);

  const formatTimestamp = (ts: number) =>
    new Date(ts * 1000).toLocaleString();

  const fmtNum = (n: number | null, decimals = 2) =>
    n != null ? n.toLocaleString(undefined, { maximumFractionDigits: decimals }) : '—';

  const fmtPct = (n: number | null) =>
    n != null ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—';

  const fmtAge = (sec: number | null) => {
    if (sec == null) return '—';
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  };

  const fmtBool = (v: number | null | undefined) =>
    v === 1 ? 'Yes' : v === 0 ? 'No' : '—';

  return (
    <div className="snapshots-tab">
      <header className="snapshots-header">
        <h2>Recent Snapshots</h2>
        <div className="snapshots-controls">
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
          <span className="snapshots-pair-filter-wrap">
            <input
              type="text"
              value={pairAddressFilter}
              onChange={(e) => {
                setPairAddressFilter(e.target.value);
                setPage(0);
              }}
              placeholder="Pair address…"
              title="Filter by pair address (prefix match)"
              className="snapshots-pair-filter"
            />
            {pairAddressFilter.trim() !== '' && (
              <button
                type="button"
                className="snapshots-pair-clear-btn"
                onClick={() => {
                  setPairAddressFilter('');
                  setPage(0);
                }}
                title="Clear pair filter"
                aria-label="Clear pair filter"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </span>
          <div className="snapshots-status">
            {error && <span className="status-error">MCP: {error}</span>}
            {connected && !error && (
              <span className="status-ok">Connected to MCP</span>
            )}
          </div>
        </div>
      </header>

      {loadError && (
        <div className="snapshots-error">
          {loadError}
          <button onClick={() => fetchSnapshots(true)}>Retry</button>
        </div>
      )}

      {newSnapshotCount > 0 && (
        <div className="snapshots-new-indicator">
          {newSnapshotCount} new snapshot{newSnapshotCount !== 1 ? 's' : ''}
        </div>
      )}

      {loading ? (
        <div className="snapshots-loading">Loading snapshots…</div>
      ) : (
        <>
          <div className="snapshots-table-wrapper">
            <table className="snapshots-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th title="BASE/QUOTE">Pair</th>
                  <th>DEX</th>
                  <th>Age</th>
                  <th>MCap</th>
                  <th>Price</th>
                  <th>Price Δ1m</th>
                  <th>Total vol</th>
                  <th title="Liquidity change over 1m">Vol Δ1m</th>
                  <th>Total buys</th>
                  <th>Total sells</th>
                  <th title="Number of unique token holders">Holders</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {snapshots.map((s) => (
                  <tr
                    key={s.snapshot_id}
                    className={newSnapshotIds.has(s.snapshot_id) ? 'snapshots-row-new' : undefined}
                  >
                    <td>{formatTimestamp(s.timestamp)}</td>
                    <td className="pair-addr" title={s.pair_address}>
                      <span className="snapshots-pair-cell">
                        <PairAddressCell
                          address={s.base_symbol && s.quote_symbol ? `${s.base_symbol}/${s.quote_symbol}` : s.pair_address}
                          href={`https://dexscreener.com/${s.chain}/${s.pair_address}`}
                          copyValue={s.pair_address}
                        />
                        <button
                          type="button"
                          className="snapshots-filter-pair-btn"
                          onClick={() => {
                            setPairAddressFilter(s.pair_address);
                            setPage(0);
                          }}
                          title="Filter to this pair only"
                          aria-label="Filter to this pair only"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                          </svg>
                        </button>
                      </span>
                    </td>
                    <td>{s.dex || '—'}</td>
                    <td>{fmtAge(s.seconds_since_creation)}</td>
                    <td>${fmtNum(s.market_cap, 0)}</td>
                    <td>${fmtNum(s.price_usd, 8)}</td>
                    <td className={s.price_change_1m != null && s.price_change_1m >= 0 ? 'positive' : 'negative'}>
                      {fmtPct(s.price_change_1m)}
                    </td>
                    <td>${fmtNum(s.total_volume, 0)}</td>
                    <td className={s.liquidity_change_1m != null && s.liquidity_change_1m >= 0 ? 'positive' : 'negative'}>
                      {fmtPct(s.liquidity_change_1m)}
                    </td>
                    <td>{fmtNum(s.total_buys, 0)}</td>
                    <td>{fmtNum(s.total_sells, 0)}</td>
                    <td>{fmtNum(s.holder_count, 0)}</td>
                    <td>
                      <button
                        type="button"
                        className="snapshots-view-btn"
                        onClick={() => setSelectedSnapshot(s)}
                      >
                        View Details
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selectedSnapshot && (
            <div
              className="snapshots-modal-overlay"
              onClick={() => setSelectedSnapshot(null)}
            >
              <div
                className="snapshots-modal snapshots-detail-modal"
                onClick={(e) => e.stopPropagation()}
              >
                <h3>Snapshot #{selectedSnapshot.snapshot_id}</h3>
                <div className="snapshots-detail">
                  <div className="snapshots-detail-section">Metadata</div>
                  <div className="snapshots-detail-grid">
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Pair</span>
                      <span className="detail-value">
                        <PairAddressCell
                          address={selectedSnapshot.base_symbol && selectedSnapshot.quote_symbol ? `${selectedSnapshot.base_symbol}/${selectedSnapshot.quote_symbol}` : selectedSnapshot.pair_address}
                          href={`https://dexscreener.com/${selectedSnapshot.chain}/${selectedSnapshot.pair_address}`}
                          copyValue={selectedSnapshot.pair_address}
                        />
                      </span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Base token</span>
                      <span className="detail-value">{selectedSnapshot.base_symbol ?? '—'}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Quote token</span>
                      <span className="detail-value">{selectedSnapshot.quote_symbol ?? '—'}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">DEX</span>
                      <span className="detail-value">{selectedSnapshot.dex || '—'}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Pair tracking tier</span>
                      <span className="detail-value">{selectedSnapshot.tracking_tier ?? '—'}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Snapshot reason</span>
                      <span className="detail-value">{selectedSnapshot.snapshot_reason ?? '—'}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Timestamp</span>
                      <span className="detail-value">{formatTimestamp(selectedSnapshot.timestamp)}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Age (sec)</span>
                      <span className="detail-value">
                        {selectedSnapshot.seconds_since_creation != null
                          ? `${selectedSnapshot.seconds_since_creation}s`
                          : '—'}
                      </span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Method</span>
                      <span className="detail-value">{selectedSnapshot.method ?? '—'}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Source</span>
                      <span className="detail-value">{selectedSnapshot.source ?? '—'}</span>
                    </div>
                  </div>
                  <div className="snapshots-detail-section">Price & market</div>
                  <div className="snapshots-detail-grid">
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Price $</span>
                      <span className="detail-value">${fmtNum(selectedSnapshot.price_usd, 8)}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Price Δ 1m</span>
                      <span className={`detail-value ${selectedSnapshot.price_change_1m != null && selectedSnapshot.price_change_1m >= 0 ? 'positive' : 'negative'}`}>
                        {fmtPct(selectedSnapshot.price_change_1m)}
                      </span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Price Δ 5m</span>
                      <span className={`detail-value ${selectedSnapshot.price_change_5m != null && selectedSnapshot.price_change_5m >= 0 ? 'positive' : 'negative'}`}>
                        {fmtPct(selectedSnapshot.price_change_5m)}
                      </span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Market cap $</span>
                      <span className="detail-value">${fmtNum(selectedSnapshot.market_cap, 0)}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">FDV $</span>
                      <span className="detail-value">${fmtNum(selectedSnapshot.fdv, 0)}</span>
                    </div>
                  </div>
                  <div className="snapshots-detail-section">Liquidity</div>
                  <div className="snapshots-detail-grid">
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Liquidity $</span>
                      <span className="detail-value">${fmtNum(selectedSnapshot.liquidity_usd, 0)}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Liquidity Δ 1m</span>
                      <span className="detail-value">{fmtPct(selectedSnapshot.liquidity_change_1m)}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">LP locked</span>
                      <span className="detail-value">{fmtBool(selectedSnapshot.lp_locked)}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">LP lock duration</span>
                      <span className="detail-value">{selectedSnapshot.lp_lock_duration != null ? `${selectedSnapshot.lp_lock_duration}s` : '—'}</span>
                    </div>
                  </div>
                  <div className="snapshots-detail-section">Volume & activity</div>
                  <div className="snapshots-detail-grid">
                    <div className="snapshots-detail-subsection">Volume</div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Volume 1m $</span>
                      <span className="detail-value">${fmtNum(selectedSnapshot.volume_1m, 0)}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Volume 5m $</span>
                      <span className="detail-value">${fmtNum(selectedSnapshot.volume_5m, 0)}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Volume 15m $</span>
                      <span className="detail-value">${fmtNum(selectedSnapshot.volume_15m, 0)}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Buy volume 1m $</span>
                      <span className="detail-value">${fmtNum(selectedSnapshot.buy_volume_1m, 0)}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Buy volume 5m $</span>
                      <span className="detail-value">${fmtNum(selectedSnapshot.buy_volume_5m, 0)}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Buy volume 15m $</span>
                      <span className="detail-value">${fmtNum(selectedSnapshot.buy_volume_15m, 0)}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Sell volume 1m $</span>
                      <span className="detail-value">${fmtNum(selectedSnapshot.sell_volume_1m, 0)}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Sell volume 5m $</span>
                      <span className="detail-value">${fmtNum(selectedSnapshot.sell_volume_5m, 0)}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Sell volume 15m $</span>
                      <span className="detail-value">${fmtNum(selectedSnapshot.sell_volume_15m, 0)}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Total volume $</span>
                      <span className="detail-value">${fmtNum(selectedSnapshot.total_volume, 0)}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Volume acceleration 1m</span>
                      <span className="detail-value">{fmtNum(selectedSnapshot.volume_acceleration_1m, 4)}</span>
                    </div>
                    <div className="snapshots-detail-subsection">Trade counts</div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Transactions 1m</span>
                      <span className="detail-value">
                        {fmtNum(
                          selectedSnapshot.transactions_1m ??
                          (selectedSnapshot.buys_1m != null && selectedSnapshot.sells_1m != null
                            ? selectedSnapshot.buys_1m + selectedSnapshot.sells_1m
                            : null),
                          0
                        )}
                      </span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Velocity score 1m</span>
                      <span className="detail-value">
                        {selectedSnapshot.velocity_score_1m != null && Number.isFinite(selectedSnapshot.velocity_score_1m)
                          ? selectedSnapshot.velocity_score_1m.toFixed(2)
                          : '—'}
                      </span>
                    </div>
                    <div className="snapshots-detail-row snapshots-detail-row-split">
                      <div>
                        <span className="detail-label">Buys 1m</span>
                        <span className="detail-value">{fmtNum(selectedSnapshot.buys_1m, 0)}</span>
                      </div>
                      <div>
                        <span className="detail-label">Sells 1m</span>
                        <span className="detail-value">{fmtNum(selectedSnapshot.sells_1m, 0)}</span>
                      </div>
                    </div>
                    <div className="snapshots-detail-row snapshots-detail-row-split">
                      <div>
                        <span className="detail-label">Total buys</span>
                        <span className="detail-value">{fmtNum(selectedSnapshot.total_buys, 0)}</span>
                      </div>
                      <div>
                        <span className="detail-label">Total sells</span>
                        <span className="detail-value">{fmtNum(selectedSnapshot.total_sells, 0)}</span>
                      </div>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Total transactions (Txs)</span>
                      <span className="detail-value">
                        {fmtNum(
                          selectedSnapshot.total_transactions ??
                          (selectedSnapshot.total_buys != null && selectedSnapshot.total_sells != null
                            ? selectedSnapshot.total_buys + selectedSnapshot.total_sells
                            : null),
                          0
                        )}
                      </span>
                    </div>
                    <div className="snapshots-detail-subsection">Buy/sell ratios</div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Buy pressure 1m</span>
                      <span className="detail-value">
                        {selectedSnapshot.buy_pressure_1m != null && Number.isFinite(selectedSnapshot.buy_pressure_1m)
                          ? `${(selectedSnapshot.buy_pressure_1m * 100).toFixed(1)}%`
                          : '—'}
                      </span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Sell pressure 1m</span>
                      <span className="detail-value">
                        {selectedSnapshot.sell_pressure_1m != null && Number.isFinite(selectedSnapshot.sell_pressure_1m)
                          ? `${(selectedSnapshot.sell_pressure_1m * 100).toFixed(1)}%`
                          : '—'}
                      </span>
                    </div>
                    <div className="snapshots-detail-row snapshots-detail-row-split">
                      <div>
                        <span className="detail-label">1m</span>
                        <span className="detail-value">{fmtNum(selectedSnapshot.buy_sell_ratio_1m, 2)}</span>
                      </div>
                      <div>
                        <span className="detail-label">Total</span>
                        <span className="detail-value">{fmtNum(selectedSnapshot.buy_sell_ratio, 2)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="snapshots-detail-section">Token / LP flags</div>
                  <div className="snapshots-detail-grid">
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Has mint authority</span>
                      <span className="detail-value">{fmtBool(selectedSnapshot.has_mint_authority)}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Has freeze authority</span>
                      <span className="detail-value">{fmtBool(selectedSnapshot.has_freeze_authority)}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Can remove liquidity</span>
                      <span className="detail-value">{fmtBool(selectedSnapshot.can_remove_liquidity)}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Honeypot flag</span>
                      <span className="detail-value">{fmtBool(selectedSnapshot.honeypot_flag)}</span>
                    </div>
                  </div>
                  <div className="snapshots-detail-section">Holders</div>
                  <div className="snapshots-detail-grid">
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Top holder %</span>
                      <span className="detail-value">{selectedSnapshot.top_holder_pct != null ? `${selectedSnapshot.top_holder_pct.toFixed(2)}%` : '—'}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Top 5 holders %</span>
                      <span className="detail-value">{selectedSnapshot.top_5_holder_pct != null ? `${selectedSnapshot.top_5_holder_pct.toFixed(2)}%` : '—'}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Holder count</span>
                      <span className="detail-value">{fmtNum(selectedSnapshot.holder_count, 0)}</span>
                    </div>
                    <div className="snapshots-detail-row">
                      <span className="detail-label">Wallet concentration</span>
                      <span className="detail-value">{fmtNum(selectedSnapshot.wallet_concentration_score, 2)}</span>
                    </div>
                  </div>
                </div>
                <div className="snapshots-detail-buttons">
                  <button type="button" onClick={() => setSelectedSnapshot(null)}>
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="snapshots-pagination">
            <button
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </button>
            <span>Page {page + 1}</span>
            <button
              disabled={snapshots.length < limit}
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
