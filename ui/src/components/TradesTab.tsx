import { useState, useEffect, useCallback, useRef } from 'react';
import { useMcpClient } from '../hooks/useMcpClient';
import { PairAddressCell } from './PairAddressCell';
import './TradesTab.css';

export interface Trade {
  trade_id: number;
  pair_address: string;
  policy_version?: string | null;
  entry_dex?: string | null;
  execution_mode?: string | null;
  base_symbol?: string | null;
  quote_symbol?: string | null;
  entry_snapshot_id: number | null;
  entry_score_id: number | null;
  exit_snapshot_id: number | null;
  entry_time: number;
  exit_time: number;
  entry_price: number;
  exit_price: number;
  position_size_usd: number;
  actual_usd_bought?: number | null;
  actual_usd_sold?: number | null;
  actual_exit_price?: number | null;
  sol_received?: number | null;
  sol_price_used?: number | null;
  sol_price_at_entry?: number | null;
  slippage_assumed_pct: number | null;
  exit_reason: string | null;
  pnl_pct: number | null;
  tx_signature?: string | null;
  execution_status?: string | null;
  actual_entry_price?: number | null;
  slippage_bps_realized?: number | null;
  execution_latency_ms?: number | null;
  entry_slippage_bps_used?: number | null;
  exit_slippage_bps_used?: number | null;
  tokens_received?: number | null;
  tokens_sold?: number | null;
  fee_lamports?: number | null;
  exit_tx_signature?: string | null;
  account_id?: string | null;
  account_address?: string | null;
  /** From pair_snapshots at entry (buy). */
  entry_market_cap?: number | null;
  /** From pair_snapshots at exit (sell). */
  exit_market_cap?: number | null;
}

export function TradesTab() {
  const { callTool, error, connected } = useMcpClient();
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [selectedTrade, setSelectedTrade] = useState<Trade | null>(null);
  const [newTradeIds, setNewTradeIds] = useState<Set<number>>(new Set());
  const prevTradeIdsRef = useRef<Set<number>>(new Set());
  const [policyFilter, setPolicyFilter] = useState<string>('');
  const [dexFilter, setDexFilter] = useState<string>('');
  const [modeFilter, setModeFilter] = useState<string>('');
  const [pairFilter, setPairFilter] = useState<string>('');
  const [policyOptions, setPolicyOptions] = useState<{ policy_version: string }[]>([]);
  const limit = 50;

  const fetchTrades = useCallback(
    async (showLoading = true) => {
      if (!connected) return;
      if (showLoading) setLoading(true);
      setLoadError(null);
      try {
        const params: { limit: number; offset: number; policy_version?: string; dex?: string; execution_mode?: 'paper' | 'live'; pair_address?: string } = {
          limit,
          offset: page * limit,
        };
        if (policyFilter.trim()) params.policy_version = policyFilter.trim();
        if (dexFilter.trim()) params.dex = dexFilter.trim();
        if (modeFilter === 'paper' || modeFilter === 'live') params.execution_mode = modeFilter;
        if (pairFilter.trim()) params.pair_address = pairFilter.trim();
        const result = await callTool('list_trades', params);
        const nextTrades = Array.isArray(result) ? result : [];
        setTrades(nextTrades);

        if (nextTrades.length > 0) {
          const nextIds = new Set(nextTrades.map((t: Trade) => t.trade_id));
          const prevIds = prevTradeIdsRef.current;
          if (prevIds.size > 0) {
            const added = nextTrades.filter((t: Trade) => !prevIds.has(t.trade_id)).map((t: Trade) => t.trade_id);
            if (added.length > 0) {
              setNewTradeIds(new Set(added));
            }
          }
          prevTradeIdsRef.current = nextIds;
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
        setTrades([]);
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [callTool, connected, page, policyFilter, dexFilter, modeFilter, pairFilter]
  );

  const fetchPolicies = useCallback(async () => {
    if (!connected) return;
    try {
      const result = await callTool('list_policies', { limit: 200, offset: 0 });
      const list = Array.isArray(result) ? result : [];
      setPolicyOptions(list.map((p: { policy_version?: string }) => ({ policy_version: p.policy_version ?? '' })));
    } catch {
      setPolicyOptions([]);
    }
  }, [callTool, connected]);

  useEffect(() => {
    fetchPolicies();
  }, [fetchPolicies]);

  useEffect(() => {
    fetchTrades(true);
  }, [fetchTrades]);

  useEffect(() => {
    const interval = setInterval(() => fetchTrades(false), 8_000);
    return () => clearInterval(interval);
  }, [fetchTrades]);

  useEffect(() => {
    if (newTradeIds.size === 0) return;
    const t = setTimeout(() => setNewTradeIds(new Set()), 4_000);
    return () => clearTimeout(t);
  }, [newTradeIds.size]);

  const formatTimestamp = (ts: number | null) =>
    ts != null ? new Date(ts * 1000).toLocaleString() : '—';

  const fmtNum = (n: number | null, decimals = 2) =>
    n != null ? n.toLocaleString(undefined, { maximumFractionDigits: decimals }) : '—';

  const fmtPct = (n: number | null) =>
    n != null ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : '—';

  const chain = 'solana';

  const fmtHold = (entryTime: number, exitTime: number) => {
    const sec = exitTime - entryTime;
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  };

  const hasPairFilter = pairFilter.trim().length > 0;

  const FilterIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  );
  const ClearFilterIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );

  return (
    <div className="trades-tab">
      <header className="trades-header">
        <h2>Trades</h2>
        <div className="trades-status">
          {error && <span className="status-error">MCP: {error}</span>}
          {connected && !error && (
            <span className="status-ok">Connected to MCP</span>
          )}
        </div>
      </header>

      <div className="trades-filters">
        <label className="trades-filter-label">
          <span>Policy</span>
          <select
            value={policyFilter}
            onChange={(e) => {
              setPolicyFilter(e.target.value);
              setPage(0);
            }}
            className="trades-filter-select"
          >
            <option value="">All</option>
            {policyOptions.map((p) => (
              <option key={p.policy_version} value={p.policy_version}>
                {p.policy_version}
              </option>
            ))}
          </select>
        </label>
        <label className="trades-filter-label">
          <span>DEX</span>
          <select
            value={dexFilter}
            onChange={(e) => {
              setDexFilter(e.target.value);
              setPage(0);
            }}
            className="trades-filter-select"
          >
            <option value="">All</option>
            <option value="raydium">Raydium</option>
            <option value="orca">Orca</option>
            <option value="pumpswap">PumpSwap</option>
            <option value="pumpfun">Pump.fun</option>
          </select>
        </label>
        <label className="trades-filter-label">
          <span>Mode</span>
          <select
            value={modeFilter}
            onChange={(e) => {
              setModeFilter(e.target.value);
              setPage(0);
            }}
            className="trades-filter-select"
          >
            <option value="">All</option>
            <option value="paper">Paper</option>
            <option value="live">Live</option>
          </select>
        </label>
        <label className="trades-filter-label">
          <span>Pair</span>
          <span className="trades-pair-filter-wrap">
            <input
              type="text"
              value={pairFilter}
              onChange={(e) => {
                setPairFilter(e.target.value);
                setPage(0);
              }}
              placeholder="Pair address"
              className="trades-filter-input"
            />
            {hasPairFilter && (
              <button
                type="button"
                className="trades-pair-clear-btn"
                onClick={() => {
                  setPairFilter('');
                  setPage(0);
                }}
                title="Clear pair filter"
                aria-label="Clear pair filter"
              >
                <ClearFilterIcon />
              </button>
            )}
          </span>
        </label>
      </div>

      {loadError && (
        <div className="trades-error">
          {loadError}
          <button onClick={() => fetchTrades(true)}>Retry</button>
        </div>
      )}

      {loading ? (
        <div className="trades-loading">Loading trades…</div>
      ) : (
        <>
          {selectedTrade && (
            <div
              className="trades-modal-overlay"
              onClick={() => setSelectedTrade(null)}
            >
              <div
                className="trades-detail-modal"
                onClick={(e) => e.stopPropagation()}
              >
                <h3>
                  Trade #{selectedTrade.trade_id} —{' '}
                  {selectedTrade.base_symbol && selectedTrade.quote_symbol
                    ? `${selectedTrade.base_symbol}/${selectedTrade.quote_symbol}`
                    : selectedTrade.pair_address.slice(0, 12) + '…'}
                </h3>
                <div className="trades-detail">
                  <div className="trades-detail-grid">
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">Pair</span>
                      <span className="trades-detail-value" title={selectedTrade.pair_address}>
                        <a
                          href={
                            selectedTrade.account_address
                              ? `https://dexscreener.com/solana/${selectedTrade.pair_address}?maker=${selectedTrade.account_address}`
                              : `https://dexscreener.com/solana/${selectedTrade.pair_address}`
                          }
                          target="_blank"
                          rel="noopener noreferrer"
                          className="trades-detail-pair-link"
                        >
                          {selectedTrade.base_symbol && selectedTrade.quote_symbol
                            ? `${selectedTrade.base_symbol}/${selectedTrade.quote_symbol}`
                            : selectedTrade.pair_address}
                        </a>
                      </span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">Policy version</span>
                      <span className="trades-detail-value">{selectedTrade.policy_version ?? '—'}</span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">DEX</span>
                      <span className="trades-detail-value">{selectedTrade.entry_dex ?? '—'}</span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">Mode</span>
                      <span className="trades-detail-value">{selectedTrade.execution_mode ?? '—'}</span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">Entry time</span>
                      <span className="trades-detail-value">{formatTimestamp(selectedTrade.entry_time)}</span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">Exit time</span>
                      <span className="trades-detail-value">{formatTimestamp(selectedTrade.exit_time)}</span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">Entry price</span>
                      <span className="trades-detail-value">${fmtNum(selectedTrade.entry_price, 8)}</span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">Exit price</span>
                      <span className="trades-detail-value">${fmtNum(selectedTrade.exit_price, 8)}</span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">Market cap when bought</span>
                      <span className="trades-detail-value">
                        {selectedTrade.entry_market_cap != null
                          ? `$${fmtNum(selectedTrade.entry_market_cap, 0)}`
                          : '—'}
                      </span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">Market cap when sold</span>
                      <span className="trades-detail-value">
                        {selectedTrade.exit_market_cap != null
                          ? `$${fmtNum(selectedTrade.exit_market_cap, 0)}`
                          : '—'}
                      </span>
                    </div>
                    {selectedTrade.actual_entry_price != null && (
                      <div className="trades-detail-row">
                        <span className="trades-detail-label">Actual entry price</span>
                        <span className="trades-detail-value">${fmtNum(selectedTrade.actual_entry_price, 8)}</span>
                      </div>
                    )}
                    {selectedTrade.actual_exit_price != null && (
                      <div className="trades-detail-row">
                        <span className="trades-detail-label">Actual exit price</span>
                        <span className="trades-detail-value">${fmtNum(selectedTrade.actual_exit_price, 8)}</span>
                      </div>
                    )}
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">Position size (USD)</span>
                      <span className="trades-detail-value">${fmtNum(selectedTrade.position_size_usd, 2)}</span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">Actual USD bought</span>
                      <span className="trades-detail-value">${fmtNum(selectedTrade.actual_usd_bought, 2)}</span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">Actual USD sold</span>
                      <span className="trades-detail-value">${fmtNum(selectedTrade.actual_usd_sold, 2)}</span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">SOL price at entry</span>
                      <span className="trades-detail-value">
                        {selectedTrade.sol_price_at_entry != null ? `$${fmtNum(selectedTrade.sol_price_at_entry, 4)}` : '—'}
                      </span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">SOL price at exit</span>
                      <span className="trades-detail-value">
                        {selectedTrade.sol_price_used != null ? `$${fmtNum(selectedTrade.sol_price_used, 4)}` : '—'}
                      </span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">SOL spent</span>
                      <span className="trades-detail-value">
                        {selectedTrade.actual_usd_bought != null &&
                        selectedTrade.sol_price_at_entry != null &&
                        selectedTrade.sol_price_at_entry > 0
                          ? fmtNum(selectedTrade.actual_usd_bought / selectedTrade.sol_price_at_entry, 8)
                          : '—'}
                      </span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">SOL received</span>
                      <span className="trades-detail-value">
                        {selectedTrade.sol_received != null ? fmtNum(selectedTrade.sol_received, 8) : '—'}
                      </span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">Tokens received</span>
                      <span className="trades-detail-value">
                        {selectedTrade.tokens_received != null ? fmtNum(selectedTrade.tokens_received, 8) : '—'}
                      </span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">Tokens spent</span>
                      <span className="trades-detail-value">
                        {selectedTrade.tokens_sold != null ? fmtNum(selectedTrade.tokens_sold, 8) : '—'}
                      </span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">Fee (exit tx)</span>
                      <span className="trades-detail-value">
                        {selectedTrade.fee_lamports != null ? (
                          <>
                            {fmtNum(selectedTrade.fee_lamports / 1e9, 8)} SOL
                            {selectedTrade.sol_price_used != null && selectedTrade.sol_price_used > 0 && (
                              <> (${fmtNum((selectedTrade.fee_lamports / 1e9) * selectedTrade.sol_price_used, 4)})</>
                            )}
                          </>
                        ) : '—'}
                      </span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">Slippage (buy) used</span>
                      <span className="trades-detail-value">
                        {selectedTrade.entry_slippage_bps_used != null
                          ? `${(selectedTrade.entry_slippage_bps_used / 100).toFixed(2)}% (${selectedTrade.entry_slippage_bps_used} bps)`
                          : '—'}
                      </span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">Slippage (sell) used</span>
                      <span className="trades-detail-value">
                        {selectedTrade.exit_slippage_bps_used != null
                          ? `${(selectedTrade.exit_slippage_bps_used / 100).toFixed(2)}% (${selectedTrade.exit_slippage_bps_used} bps)`
                          : '—'}
                      </span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">Exit reason</span>
                      <span className="trades-detail-value">{selectedTrade.exit_reason ?? '—'}</span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">PnL %</span>
                      <span
                        className={
                          selectedTrade.pnl_pct != null
                            ? selectedTrade.pnl_pct >= 0
                              ? 'trades-detail-value positive'
                              : 'trades-detail-value negative'
                            : 'trades-detail-value'
                        }
                      >
                        {fmtPct(selectedTrade.pnl_pct)}
                      </span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">Entry snapshot ID</span>
                      <span className="trades-detail-value">{selectedTrade.entry_snapshot_id ?? '—'}</span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">Entry score ID</span>
                      <span className="trades-detail-value">{selectedTrade.entry_score_id ?? '—'}</span>
                    </div>
                    <div className="trades-detail-row">
                      <span className="trades-detail-label">Exit snapshot ID</span>
                      <span className="trades-detail-value">{selectedTrade.exit_snapshot_id ?? '—'}</span>
                    </div>
                  </div>

                  {(selectedTrade.tx_signature != null ||
                    selectedTrade.execution_status != null ||
                    selectedTrade.actual_entry_price != null ||
                    selectedTrade.execution_latency_ms != null ||
                    selectedTrade.exit_tx_signature != null) && (
                    <>
                      <h4 className="trades-detail-section">Transaction information</h4>
                      <div className="trades-detail-grid">
                        {selectedTrade.tx_signature && (
                          <div className="trades-detail-row">
                            <span className="trades-detail-label">Entry tx</span>
                            <span className="trades-detail-value">
                              <a
                                href={`https://solscan.io/tx/${selectedTrade.tx_signature}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="trades-tx-link"
                              >
                                {selectedTrade.tx_signature.slice(0, 8)}…{selectedTrade.tx_signature.slice(-8)}
                              </a>
                            </span>
                          </div>
                        )}
                        {selectedTrade.exit_tx_signature && (
                          <div className="trades-detail-row">
                            <span className="trades-detail-label">Exit tx</span>
                            <span className="trades-detail-value">
                              <a
                                href={`https://solscan.io/tx/${selectedTrade.exit_tx_signature}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="trades-tx-link"
                              >
                                {selectedTrade.exit_tx_signature.slice(0, 8)}…{selectedTrade.exit_tx_signature.slice(-8)}
                              </a>
                            </span>
                          </div>
                        )}
                        {selectedTrade.execution_status != null && selectedTrade.execution_status !== '' && (
                          <div className="trades-detail-row">
                            <span className="trades-detail-label">Execution status</span>
                            <span className={`trades-exec-badge trades-exec-${String(selectedTrade.execution_status).toLowerCase().replace(/_/g, '-')}`}>
                              {selectedTrade.execution_status}
                            </span>
                          </div>
                        )}
                        {selectedTrade.execution_latency_ms != null && (
                          <div className="trades-detail-row">
                            <span className="trades-detail-label">Execution latency</span>
                            <span className="trades-detail-value">{selectedTrade.execution_latency_ms} ms</span>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
                <div className="trades-detail-buttons">
                  <button type="button" onClick={() => setSelectedTrade(null)}>
                    Close
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="trades-table-wrapper">
              <table className="trades-table">
                <thead>
                  <tr>
                    <th title="Unique trade record ID">ID</th>
                    <th title="BASE/QUOTE">Pair</th>
                    <th title="Policy version used for this trade">Policy</th>
                    <th title="DEX where the trade was entered">DEX</th>
                    <th title="Execution mode: paper or live">Mode</th>
                    <th title="When the position was opened (entry time)">Entry</th>
                    <th title="When the position was closed (exit time)">Exit</th>
                    <th title="Time from entry to exit">Hold</th>
                    <th title="Actual USD spent on buy">Bought $</th>
                    <th title="Actual USD value received on sell">Sold $</th>
                    <th title="Why the trade closed: STOP_LOSS, TAKE_PROFIT, TIME_STOP, or reset">Exit Reason</th>
                    <th title="Realized profit or loss as a percentage of entry">PnL %</th>
                    <th title="View full trade details">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t) => (
                    <tr
                      key={t.trade_id}
                      className={newTradeIds.has(t.trade_id) ? 'trades-row-new' : undefined}
                    >
                      <td className="trades-id-cell">
                        {newTradeIds.has(t.trade_id) && (
                          <span className="trades-new-badge" aria-hidden>New</span>
                        )}
                        {t.trade_id}
                      </td>
                      <td className="pair-addr" title={t.pair_address}>
                        <span className="trades-pair-cell">
                          <PairAddressCell
                            address={t.base_symbol && t.quote_symbol ? `${t.base_symbol}/${t.quote_symbol}` : t.pair_address}
                            href={
                              t.account_address?.trim()
                                ? `https://dexscreener.com/${chain}/${t.pair_address}?maker=${t.account_address}`
                                : `https://dexscreener.com/${chain}/${t.pair_address}`
                            }
                            copyValue={t.pair_address}
                          />
                          {!hasPairFilter && (
                            <button
                              type="button"
                              className="trades-pair-filter-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                setPairFilter(t.pair_address);
                                setPage(0);
                              }}
                              title="Filter by this pair"
                              aria-label="Filter by this pair"
                            >
                              <FilterIcon />
                            </button>
                          )}
                        </span>
                      </td>
                      <td>{t.policy_version ?? '—'}</td>
                      <td>{t.entry_dex ?? '—'}</td>
                      <td>{t.execution_mode ?? '—'}</td>
                      <td>{formatTimestamp(t.entry_time)}</td>
                      <td>{formatTimestamp(t.exit_time)}</td>
                      <td>{fmtHold(t.entry_time, t.exit_time)}</td>
                      <td>
                        {t.tx_signature?.trim() ? (
                          <a
                            href={`https://solscan.io/tx/${t.tx_signature}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="trades-tx-link"
                            title="View buy tx on Solscan"
                          >
                            ${fmtNum(t.actual_usd_bought, 2)}
                          </a>
                        ) : (
                          `$${fmtNum(t.actual_usd_bought, 2)}`
                        )}
                      </td>
                      <td>
                        {t.exit_tx_signature?.trim() ? (
                          <a
                            href={`https://solscan.io/tx/${t.exit_tx_signature}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="trades-tx-link"
                            title="View sell tx on Solscan"
                          >
                            ${fmtNum(t.actual_usd_sold, 2)}
                          </a>
                        ) : (
                          `$${fmtNum(t.actual_usd_sold, 2)}`
                        )}
                      </td>
                      <td>{t.exit_reason ?? '—'}</td>
                      <td
                        className={
                          t.pnl_pct != null
                            ? t.pnl_pct >= 0
                              ? 'positive'
                              : 'negative'
                            : ''
                        }
                      >
                        {fmtPct(t.pnl_pct)}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="trades-detail-btn"
                          onClick={() => setSelectedTrade(t)}
                        >
                          View details
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          <div className="trades-pagination">
            <button
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </button>
            <span>Page {page + 1}</span>
            <button
              disabled={trades.length < limit}
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
