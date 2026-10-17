import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useMcpClient } from '../hooks/useMcpClient';
import { PairAddressCell } from './PairAddressCell';
import './TradeDecisionsTab.css';

export interface TradeDecision {
  trade_id: number;
  pair_address: string;
  token_mint: string | null;
  entry_dex: string | null;
  base_symbol?: string | null;
  quote_symbol?: string | null;
  policy_version: string;
  market_mode: string;
  signal: string;
  entry_price: number;
  position_size_usd: number;
  executed_at: number;
  reason: string | null;
  execution_mode: string;
  entry_snapshot_id: number | null;
  exit_recorded_at: number | null;
  /** Market cap from pair_snapshots at entry (buy). */
  entry_market_cap?: number | null;
  consecutive_volume_collapse_count?: number | null;
  last_volume_ratio?: number | null;
  risk_pct_at_entry?: number | null;
  score_size_multiplier?: number | null;
  /** SOL price at buy (entry) */
  sol_price_at_entry?: number | null;
  /** Transaction details (live only) */
  tx_signature?: string | null;
  execution_status?: string | null;
  /** Error message when execution failed (e.g. LIVE_FAILED, PENDING_CONFIRMATION) */
  execution_error?: string | null;
  actual_entry_price?: number | null;
  actual_position_size_usd?: number | null;
  slippage_bps_realized?: number | null;
  execution_latency_ms?: number | null;
  account_address?: string | null;
}

export function TradeDecisionsTab() {
  const { callTool, error, connected } = useMcpClient();
  const [decisions, setDecisions] = useState<TradeDecision[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [openOnly, setOpenOnly] = useState(true);
  const [pairFilter, setPairFilter] = useState('');
  const [newDecisionIds, setNewDecisionIds] = useState<Set<number>>(new Set());
  const [detailsDecision, setDetailsDecision] = useState<TradeDecision | null>(null);
  const [exitingTradeId, setExitingTradeId] = useState<number | null>(null);
  const [exitConfirmId, setExitConfirmId] = useState<number | null>(null);
  const [exitResult, setExitResult] = useState<{ trade_id: number; success: boolean; message: string } | null>(null);
  const prevDecisionIdsRef = useRef<Set<number>>(new Set());
  const limit = 50;

  const fetchDecisions = useCallback(
    async (showLoading = true) => {
      if (!connected) return;
      if (showLoading) setLoading(true);
      setLoadError(null);
      try {
        const result = await callTool('list_trade_decisions', {
          limit,
          offset: page * limit,
          open_only: openOnly ? true : undefined,
          pair_address: pairFilter.trim() || undefined,
        });
        const nextDecisions = Array.isArray(result) ? result : [];
        setDecisions(nextDecisions);

        if (nextDecisions.length > 0) {
          const nextIds = new Set(nextDecisions.map((d: TradeDecision) => d.trade_id));
          const prevIds = prevDecisionIdsRef.current;
          if (prevIds.size > 0) {
            const added = nextDecisions
              .filter((d: TradeDecision) => !prevIds.has(d.trade_id))
              .map((d: TradeDecision) => d.trade_id);
            if (added.length > 0) {
              setNewDecisionIds(new Set(added));
            }
          }
          prevDecisionIdsRef.current = nextIds;
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
        setDecisions([]);
      } finally {
        if (showLoading) setLoading(false);
      }
    },
    [callTool, connected, page, openOnly, pairFilter]
  );

  const handleForceExit = useCallback(
    async (tradeId: number) => {
      if (!connected || exitingTradeId != null) return;
      setExitConfirmId(null);
      setExitingTradeId(tradeId);
      setExitResult(null);
      try {
        const result = await callTool('force_exit_trade', { trade_id: tradeId }) as { success?: boolean; error?: string; tx_signature?: string; actual_usd_sold?: number };
        if (result?.success) {
          const usd = result.actual_usd_sold != null ? ` — received $${result.actual_usd_sold.toFixed(2)}` : '';
          setExitResult({ trade_id: tradeId, success: true, message: `Trade ${tradeId} exited${usd}` });
        } else {
          setExitResult({ trade_id: tradeId, success: false, message: result?.error ?? 'Exit failed' });
        }
        void fetchDecisions(false);
      } catch (err) {
        setExitResult({ trade_id: tradeId, success: false, message: err instanceof Error ? err.message : String(err) });
      } finally {
        setExitingTradeId(null);
      }
    },
    [callTool, connected, exitingTradeId, fetchDecisions]
  );

  useEffect(() => {
    if (exitResult == null) return;
    const t = setTimeout(() => setExitResult(null), 6_000);
    return () => clearTimeout(t);
  }, [exitResult]);

  useEffect(() => {
    fetchDecisions(true);
  }, [fetchDecisions]);

  useEffect(() => {
    const interval = setInterval(() => fetchDecisions(false), 8_000);
    return () => clearInterval(interval);
  }, [fetchDecisions]);

  useEffect(() => {
    if (newDecisionIds.size === 0) return;
    const t = setTimeout(() => setNewDecisionIds(new Set()), 4_000);
    return () => clearTimeout(t);
  }, [newDecisionIds.size]);

  const formatTimestamp = (ts: number | null) =>
    ts != null ? new Date(ts * 1000).toLocaleString() : '—';

  const fmtNum = (n: number | null, decimals = 2) =>
    n != null ? n.toLocaleString(undefined, { maximumFractionDigits: decimals }) : '—';

  const chain = 'solana';

  return (
    <div className="trade-decisions-tab">
      <header className="trade-decisions-header">
        <h2>Trade Decisions</h2>
        <div className="trade-decisions-controls">
          <label className="trade-decisions-filter">
            <input
              type="checkbox"
              checked={openOnly}
              onChange={(e) => {
                setOpenOnly(e.target.checked);
                setPage(0);
              }}
            />
            Open only
          </label>
          <label className="trade-decisions-filter">
            <span>Pair</span>
            <input
              type="text"
              value={pairFilter}
              onChange={(e) => {
                setPairFilter(e.target.value);
                setPage(0);
              }}
              placeholder="Pair address"
              className="trade-decisions-pair-input"
            />
          </label>
          <div className="trade-decisions-status">
            {error && <span className="status-error">MCP: {error}</span>}
            {connected && !error && (
              <span className="status-ok">Connected to MCP</span>
            )}
          </div>
        </div>
      </header>

      {exitResult && (
        <div className={`trade-decisions-toast ${exitResult.success ? 'toast-success' : 'toast-error'}`} role="status">
          {exitResult.message}
        </div>
      )}

      {loadError && (
        <div className="trade-decisions-error">
          {loadError}
          <button onClick={() => fetchDecisions(true)}>Retry</button>
        </div>
      )}

      {loading ? (
        <div className="trade-decisions-loading">Loading trade decisions…</div>
      ) : (
        <>
          <div className="trade-decisions-table-wrapper">
            <table className="trade-decisions-table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th title="BASE/QUOTE">Pair</th>
                  <th>Policy</th>
                  <th title="Market cap from entry snapshot at time of buy">Mkt cap @ buy</th>
                  <th>Market</th>
                  <th>Mode</th>
                  <th>Signal</th>
                  <th>Entry $</th>
                  <th>Size $</th>
                  <th title="Actual position size from execution (live only)">Actual size $</th>
                  <th>Executed</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {decisions.map((d) => (
                  <React.Fragment key={d.trade_id}>
                    <tr
                      className={[
                        d.exit_recorded_at == null ? 'trade-decisions-row-open' : '',
                        newDecisionIds.has(d.trade_id) ? 'trade-decisions-row-new' : '',
                      ].filter(Boolean).join(' ') || undefined}
                    >
                      <td className="trade-decisions-id-cell">
                        {newDecisionIds.has(d.trade_id) && (
                          <span className="trade-decisions-new-badge" aria-hidden>New</span>
                        )}
                        {d.trade_id}
                      </td>
                      <td className="pair-addr" title={d.pair_address}>
                        <span className="trade-decisions-pair-cell">
                          <PairAddressCell
                            address={d.base_symbol && d.quote_symbol ? `${d.base_symbol}/${d.quote_symbol}` : d.pair_address}
                            href={
                              d.account_address?.trim()
                                ? `https://dexscreener.com/${chain}/${d.pair_address}?maker=${d.account_address}`
                                : `https://dexscreener.com/${chain}/${d.pair_address}`
                            }
                            copyValue={d.pair_address}
                          />
                          <button
                            type="button"
                            className="trade-decisions-filter-pair-btn"
                            onClick={() => {
                              setPairFilter(d.pair_address);
                              setPage(0);
                            }}
                            title="Filter decisions to this pair only"
                            aria-label="Filter decisions to this pair only"
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                            </svg>
                          </button>
                        </span>
                      </td>
                      <td>{d.policy_version}</td>
                      <td className="trade-decisions-mkt-cap-cell">
                        {d.entry_market_cap != null ? `$${fmtNum(d.entry_market_cap, 0)}` : '—'}
                      </td>
                      <td>{d.market_mode}</td>
                      <td>{d.execution_mode}</td>
                      <td>{d.signal}</td>
                      <td>${fmtNum(d.entry_price, 8)}</td>
                      <td>${fmtNum(d.position_size_usd, 0)}</td>
                      <td>
                        {d.tx_signature?.trim() ? (
                          <a
                            href={`https://solscan.io/tx/${d.tx_signature}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="trade-decisions-tx-link"
                            title="View entry tx on Solscan"
                          >
                            {d.actual_position_size_usd != null ? `$${fmtNum(d.actual_position_size_usd, 2)}` : '—'}
                          </a>
                        ) : (
                          d.actual_position_size_usd != null ? `$${fmtNum(d.actual_position_size_usd, 2)}` : '—'
                        )}
                      </td>
                      <td>{formatTimestamp(d.executed_at)}</td>
                      <td>
                        {d.exit_recorded_at == null ? (
                          <span className="status-open">Open</span>
                        ) : (
                          <span className="status-closed">Closed</span>
                        )}
                      </td>
                      <td className="trade-decisions-actions-cell">
                        <button
                          type="button"
                          className="trade-decisions-details-btn"
                          onClick={() => setDetailsDecision(d)}
                        >
                          View Details
                        </button>
                        {d.exit_recorded_at == null && (
                          exitConfirmId === d.trade_id ? (
                            <span className="trade-decisions-confirm-group">
                              <button
                                type="button"
                                className="trade-decisions-exit-confirm-btn"
                                onClick={() => void handleForceExit(d.trade_id)}
                                disabled={exitingTradeId != null}
                              >
                                Confirm
                              </button>
                              <button
                                type="button"
                                className="trade-decisions-exit-cancel-btn"
                                onClick={() => setExitConfirmId(null)}
                                disabled={exitingTradeId != null}
                              >
                                Cancel
                              </button>
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="trade-decisions-exit-btn"
                              onClick={() => setExitConfirmId(d.trade_id)}
                              disabled={exitingTradeId != null}
                              title="Immediately sell tokens and close this position"
                            >
                              {exitingTradeId === d.trade_id ? 'Exiting…' : 'Exit'}
                            </button>
                          )
                        )}
                      </td>
                    </tr>
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <div className="trade-decisions-pagination">
            <button
              disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Previous
            </button>
            <span>Page {page + 1}</span>
            <button
              disabled={decisions.length < limit}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        </>
      )}

      {detailsDecision != null && (
        <div
          className="trade-decisions-modal-overlay"
          onClick={() => setDetailsDecision(null)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="trade-decisions-modal-title"
        >
          <div
            className="trade-decisions-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="trade-decisions-modal-header">
              <h3 id="trade-decisions-modal-title">Decision #{detailsDecision.trade_id} details</h3>
              <button
                type="button"
                className="trade-decisions-modal-close"
                onClick={() => setDetailsDecision(null)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="trade-decisions-modal-body">
              <dl className="trade-decisions-details-dl">
                <dt>trade_id</dt><dd>{detailsDecision.trade_id}</dd>
                <dt>pair_address</dt><dd className="trade-decisions-details-monospace">{detailsDecision.pair_address}</dd>
                <dt>token_mint</dt><dd className="trade-decisions-details-monospace">{detailsDecision.token_mint ?? '—'}</dd>
                <dt>entry_dex</dt><dd>{detailsDecision.entry_dex ?? '—'}</dd>
                <dt>base_symbol / quote_symbol</dt><dd>{[detailsDecision.base_symbol, detailsDecision.quote_symbol].filter(Boolean).join(' / ') || '—'}</dd>
                <dt>policy_version</dt><dd>{detailsDecision.policy_version}</dd>
                <dt>market_mode</dt><dd>{detailsDecision.market_mode}</dd>
                <dt>signal</dt><dd>{detailsDecision.signal}</dd>
                <dt>entry_price</dt><dd>${fmtNum(detailsDecision.entry_price, 8)}</dd>
                <dt>position_size_usd</dt><dd>${fmtNum(detailsDecision.position_size_usd, 2)}</dd>
                <dt>SOL price at buy</dt><dd>{detailsDecision.sol_price_at_entry != null ? `$${fmtNum(detailsDecision.sol_price_at_entry, 4)}` : '—'}</dd>
                <dt>SOL spent</dt><dd>{detailsDecision.position_size_usd != null && detailsDecision.sol_price_at_entry != null && detailsDecision.sol_price_at_entry > 0 ? fmtNum(detailsDecision.position_size_usd / detailsDecision.sol_price_at_entry, 8) : '—'}</dd>
                <dt>executed_at</dt><dd>{formatTimestamp(detailsDecision.executed_at)}</dd>
                <dt>reason</dt><dd>{detailsDecision.reason ?? '—'}</dd>
                <dt>execution_mode</dt><dd>{detailsDecision.execution_mode}</dd>
                <dt>entry_snapshot_id</dt><dd>{detailsDecision.entry_snapshot_id ?? '—'}</dd>
                <dt>Market cap at buy</dt>
                <dd>
                  {detailsDecision.entry_market_cap != null
                    ? `$${fmtNum(detailsDecision.entry_market_cap, 0)}`
                    : '—'}
                </dd>
                <dt>exit_recorded_at</dt><dd>{formatTimestamp(detailsDecision.exit_recorded_at)}</dd>
                <dt>consecutive_volume_collapse_count</dt><dd>{detailsDecision.consecutive_volume_collapse_count ?? '—'}</dd>
                <dt>last_volume_ratio</dt><dd>{detailsDecision.last_volume_ratio != null ? fmtNum(detailsDecision.last_volume_ratio, 4) : '—'}</dd>
                <dt>risk_pct_at_entry</dt><dd>{detailsDecision.risk_pct_at_entry != null ? `${fmtNum(detailsDecision.risk_pct_at_entry, 2)}%` : '—'}</dd>
                <dt>score_size_multiplier</dt><dd>{detailsDecision.score_size_multiplier != null ? fmtNum(detailsDecision.score_size_multiplier, 4) : '—'}</dd>
              </dl>
              {(detailsDecision.tx_signature != null ||
                detailsDecision.execution_status != null ||
                detailsDecision.execution_error != null ||
                detailsDecision.actual_entry_price != null ||
                detailsDecision.actual_position_size_usd != null ||
                detailsDecision.slippage_bps_realized != null ||
                detailsDecision.execution_latency_ms != null) && (
                <>
                  <h4 className="trade-decisions-details-section">Transaction details</h4>
                  <dl className="trade-decisions-details-dl">
                    <dt>tx_signature</dt>
                    <dd className="trade-decisions-details-monospace">
                      {detailsDecision.tx_signature ? (
                        <a
                          href={`https://solscan.io/tx/${detailsDecision.tx_signature}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="trade-decisions-tx-link"
                        >
                          {detailsDecision.tx_signature.slice(0, 8)}…{detailsDecision.tx_signature.slice(-8)}
                        </a>
                      ) : (
                        '—'
                      )}
                    </dd>
                    <dt>execution_status</dt><dd>{detailsDecision.execution_status ?? '—'}</dd>
                    {detailsDecision.execution_error != null && detailsDecision.execution_error.trim() !== '' && (
                      <>
                        <dt>execution_error</dt>
                        <dd className="trade-decisions-details-execution-error" title={detailsDecision.execution_error}>
                          {detailsDecision.execution_error}
                        </dd>
                      </>
                    )}
                    <dt>actual_entry_price</dt><dd>{detailsDecision.actual_entry_price != null ? `$${fmtNum(detailsDecision.actual_entry_price, 8)}` : '—'}</dd>
                    <dt>actual_position_size_usd</dt><dd>{detailsDecision.actual_position_size_usd != null ? `$${fmtNum(detailsDecision.actual_position_size_usd, 2)}` : '—'}</dd>
                    <dt>slippage_bps_realized</dt><dd>{detailsDecision.slippage_bps_realized != null ? detailsDecision.slippage_bps_realized : '—'}</dd>
                    <dt>execution_latency_ms</dt><dd>{detailsDecision.execution_latency_ms != null ? detailsDecision.execution_latency_ms : '—'}</dd>
                  </dl>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
