import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react';
import { useMcpClient } from '../hooks/useMcpClient';
import { TokenMintCell } from './TokenMintCell';
import './StatsTab.css';

export interface GlobalStats {
  paper_balance: number;
  pnl_today: number;
  pnl_total: number;
  max_drawdown_today_pct: number;
  trades_today: number;
  active_trades: number;
  active_policies: number;
  exit_reason_breakdown: { TAKE_PROFIT: number; STOP_LOSS: number; TIME_STOP: number; OTHER: number };
}

export interface PolicyStatRow {
  policy_version: string;
  status: string;
  trades: number;
  win_rate_pct: number;
  avg_pnl_pct: number;
  total_pnl: number;
  avg_hold_seconds: number;
  take_profit_pct: number;
  stop_loss_pct: number;
  time_stop_pct: number;
}

export interface PolicyDetailStats {
  policy_version: string;
  trades_last_24h: number;
  trades_total: number;
  win_rate_pct: number;
  avg_rr: number | null;
  avg_hold_seconds: number | null;
  max_consecutive_losses: number;
  exit_breakdown: Record<string, number>;
}

export interface PolicyTokenStatRow {
  token_mint: string;
  trades: number;
  net_pnl: number;
  win_rate_pct: number;
  avg_hold_seconds: number;
  last_trade_at: number;
}

export interface AnalyticsTradeRow {
  trade_id: string;
  timestamp: number;
  policy_version: string;
  token_mint: string;
  entry_price: number;
  exit_price: number;
  pnl_pct: number;
  exit_reason: string;
  execution_mode: 'paper' | 'live';
  hold_seconds: number;
}

export type PolicyDetailSubTab = 'overview' | 'trades' | 'tokens' | 'rejections' | 'entry_filters';

export interface EntryFilterBreakdownStat {
  count: number;
  pct_of_entry_filter_rejections: number;
  avg_distance_from_threshold: number | null;
}

export interface PolicyEntryFilterStatsRow {
  policy_version: string;
  total_entry_filter_rejections: number;
  breakdown: Record<string, EntryFilterBreakdownStat>;
}

export interface RejectionReasonStat {
  count: number;
  pct_of_rejections: number;
  pct_of_all_decisions: number;
}

export interface PolicyRejectionStatsRow {
  policy_version: string;
  total_rejections: number;
  total_entries: number;
  total_decisions: number;
  rejection_breakdown: Record<string, RejectionReasonStat>;
}

const PAPER_DEFAULT = 'paper-default';

export interface AccountOption {
  account_id: string;
  mode: string;
  name?: string | null;
  /** Wallet address (e.g. Solana public key) when available; used for DexScreener ?maker= on live. */
  address?: string | null;
}

export function StatsTab() {
  const { callTool, error, connected } = useMcpClient();
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>(() => PAPER_DEFAULT);
  const [globalStats, setGlobalStats] = useState<GlobalStats | null>(null);
  const [policyStats, setPolicyStats] = useState<PolicyStatRow[]>([]);
  const [selectedPolicyVersion, setSelectedPolicyVersion] = useState<string | null>(null);
  const [detailSubTab, setDetailSubTab] = useState<PolicyDetailSubTab>('overview');
  const [policyDetail, setPolicyDetail] = useState<PolicyDetailStats | null>(null);
  const [policyTokenStats, setPolicyTokenStats] = useState<PolicyTokenStatRow[]>([]);
  const [policyRejectionStats, setPolicyRejectionStats] = useState<PolicyRejectionStatsRow | null>(null);
  const [policyEntryFilterStats, setPolicyEntryFilterStats] = useState<PolicyEntryFilterStatsRow | null>(null);
  const [policyDetailTrades, setPolicyDetailTrades] = useState<AnalyticsTradeRow[]>([]);
  const [topTokens, setTopTokens] = useState<PolicyTokenStatRow[]>([]);
  const [selectedTokenForTrades, setSelectedTokenForTrades] = useState<string | null>(null);
  const [tokenTradesList, setTokenTradesList] = useState<AnalyticsTradeRow[]>([]);
  const [tokenTradesLoading, setTokenTradesLoading] = useState(false);
  const [tokenSymbols, setTokenSymbols] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const policyDetailSectionRef = useRef<HTMLElement | null>(null);

  const fetchAccounts = useCallback(async () => {
    try {
      const out = await callTool('list_accounts', {});
      const list = Array.isArray(out) ? out : [];
      setAccounts(list);
      setSelectedAccountId((prev) => {
        const liveFirst = list.find((a: AccountOption) => a.mode === 'live');
        // Leaderboard default: first live wallet when available and selection is still initial default
        if (liveFirst && prev === PAPER_DEFAULT) return liveFirst.account_id;
        const hasPrev = list.some((a: AccountOption) => a.account_id === prev);
        if (hasPrev) return prev;
        if (liveFirst) return liveFirst.account_id;
        return list[0]?.account_id ?? PAPER_DEFAULT;
      });
    } catch {
      setAccounts([]);
    }
  }, [callTool]);

  const fetchGlobal = useCallback(async () => {
    try {
      const out = await callTool('analytics_get_global_stats', { account_id: selectedAccountId });
      setGlobalStats(out as GlobalStats);
    } catch {
      setGlobalStats(null);
    }
  }, [callTool, selectedAccountId]);

  const fetchPolicyStats = useCallback(async () => {
    try {
      const out = await callTool('analytics_get_policy_stats', {
        include_archived: showArchived,
        include_retired: showRetired,
        account_id: selectedAccountId,
      });
      setPolicyStats(Array.isArray(out) ? out : []);
    } catch {
      setPolicyStats([]);
    }
  }, [callTool, showArchived, showRetired, selectedAccountId]);

  const fetchTopTokens = useCallback(async () => {
    try {
      const out = await callTool('analytics_get_top_tokens', { limit: 20, account_id: selectedAccountId });
      setTopTokens(Array.isArray(out) ? out : []);
    } catch {
      setTopTokens([]);
    }
  }, [callTool, selectedAccountId]);

  const fetchTokenTrades = useCallback(
    async (token_mint: string) => {
      setTokenTradesLoading(true);
      try {
        const out = await callTool('analytics_get_trades', {
          token_mint,
          limit: 100,
          account_id: selectedAccountId,
        });
        setTokenTradesList(Array.isArray(out) ? out : []);
      } catch {
        setTokenTradesList([]);
      } finally {
        setTokenTradesLoading(false);
      }
    },
    [callTool, selectedAccountId]
  );

  useEffect(() => {
    if (!selectedTokenForTrades) {
      setTokenTradesList([]);
      return;
    }
    fetchTokenTrades(selectedTokenForTrades);
  }, [selectedTokenForTrades, fetchTokenTrades]);

  const fetchPolicyDetail = useCallback(
    async (policy_version: string) => {
      try {
        const out = await callTool('analytics_get_policy_detail', {
          policy_version,
          account_id: selectedAccountId,
        });
        setPolicyDetail(out as PolicyDetailStats);
      } catch {
        setPolicyDetail(null);
      }
    },
    [callTool, selectedAccountId]
  );

  const fetchPolicyTokenStats = useCallback(
    async (policy_version: string) => {
      try {
        const out = await callTool('analytics_get_policy_token_stats', {
          policy_version,
          account_id: selectedAccountId,
        });
        setPolicyTokenStats(Array.isArray(out) ? out : []);
      } catch {
        setPolicyTokenStats([]);
      }
    },
    [callTool, selectedAccountId]
  );

  useEffect(() => {
    if (!connected) return;
    fetchAccounts();
  }, [connected, fetchAccounts]);

  useEffect(() => {
    if (!connected || !selectedAccountId) return;
    setLoading(true);
    setLoadError(null);
    Promise.all([fetchGlobal(), fetchPolicyStats(), fetchTopTokens()])
      .then(() => setLoading(false))
      .catch((err) => {
        setLoadError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [connected, selectedAccountId, fetchGlobal, fetchPolicyStats, fetchTopTokens]);

  useEffect(() => {
    if (!selectedPolicyVersion) setDetailSubTab('overview');
  }, [selectedPolicyVersion]);

  const fetchPolicyRejectionStats = useCallback(
    async (policy_version: string) => {
      try {
        const out = await callTool('analytics_get_policy_rejection_stats', {
          policy_version,
          since_seconds: 86400,
          account_id: selectedAccountId,
        });
        const arr = Array.isArray(out) ? out : [];
        let row = arr.find((r: PolicyRejectionStatsRow) => r.policy_version === policy_version) ?? null;
        if (!row && policy_version) {
          row = {
            policy_version: policy_version,
            total_rejections: 0,
            total_entries: 0,
            total_decisions: 0,
            rejection_breakdown: {},
          } as PolicyRejectionStatsRow;
        }
        setPolicyRejectionStats(row);
      } catch {
        setPolicyRejectionStats(null);
      }
    },
    [callTool, selectedAccountId]
  );

  const fetchPolicyEntryFilterStats = useCallback(
    async (policy_version: string) => {
      try {
        const out = await callTool('analytics_get_policy_entry_filter_rejections', {
          policy_version,
          since_seconds: 86400,
          account_id: selectedAccountId,
        });
        const arr = Array.isArray(out) ? out : [];
        let row = arr.find((r: PolicyEntryFilterStatsRow) => r.policy_version === policy_version) ?? null;
        if (!row && policy_version) {
          row = {
            policy_version: policy_version,
            total_entry_filter_rejections: 0,
            breakdown: {},
          } as PolicyEntryFilterStatsRow;
        }
        setPolicyEntryFilterStats(row);
      } catch {
        setPolicyEntryFilterStats(null);
      }
    },
    [callTool, selectedAccountId]
  );

  const fetchPolicyDetailTrades = useCallback(
    async (policy_version: string) => {
      try {
        const out = await callTool('analytics_get_trades', {
          policy_version,
          limit: 50,
          account_id: selectedAccountId,
        });
        setPolicyDetailTrades(Array.isArray(out) ? out : []);
      } catch {
        setPolicyDetailTrades([]);
      }
    },
    [callTool, selectedAccountId]
  );

  useEffect(() => {
    if (!connected || !selectedPolicyVersion) return;
    fetchPolicyDetail(selectedPolicyVersion);
    fetchPolicyTokenStats(selectedPolicyVersion);
  }, [connected, selectedPolicyVersion, fetchPolicyDetail, fetchPolicyTokenStats]);

  // Smooth scroll to policy detail section when a policy is selected
  useEffect(() => {
    if (selectedPolicyVersion && policyDetailSectionRef.current) {
      policyDetailSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [selectedPolicyVersion]);

  useEffect(() => {
    if (!connected || !selectedPolicyVersion) return;
    if (detailSubTab === 'rejections') fetchPolicyRejectionStats(selectedPolicyVersion);
    if (detailSubTab === 'trades') fetchPolicyDetailTrades(selectedPolicyVersion);
    if (detailSubTab === 'entry_filters') fetchPolicyEntryFilterStats(selectedPolicyVersion);
  }, [connected, selectedPolicyVersion, detailSubTab, fetchPolicyRejectionStats, fetchPolicyDetailTrades, fetchPolicyEntryFilterStats]);

  useEffect(() => {
    if (!connected) return;
    const mints = new Set<string>();
    policyTokenStats.forEach((t) => t.token_mint && mints.add(t.token_mint));
    policyDetailTrades.forEach((t) => t.token_mint && mints.add(t.token_mint));
    topTokens.forEach((t) => t.token_mint && mints.add(t.token_mint));
    if (mints.size === 0) return;
    callTool('get_token_symbols', { mints: Array.from(mints) })
      .then((out) => setTokenSymbols((prev) => ({ ...prev, ...(out as Record<string, string>) })))
      .catch(() => {});
  }, [connected, callTool, policyTokenStats, policyDetailTrades, topTokens]);

  const fmtMoney = (n: number) =>
    `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const fmtPct = (n: number, signed = false) =>
    signed ? `${n >= 0 ? '+' : ''}${n.toFixed(2)}%` : `${n.toFixed(1)}%`;
  const fmtNum = (n: number | null | undefined, decimals = 0) =>
    n != null ? n.toLocaleString(undefined, { maximumFractionDigits: decimals }) : '—';
  const fmtTime = (s: number) => {
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${(s / 3600).toFixed(1)}h`;
  };
  const fmtTimestamp = (ts: number) =>
    new Date(ts * 1000).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });

  function reasonClass(reason: string): 'structural' | 'signal' | 'safety' {
    const structural = [
      'TOKEN_REENTRY_COOLDOWN',
      'MAX_TRADES_PER_TOKEN',
      'COOLDOWN_AFTER_LOSS',
      'MAX_OPEN_TRADES',
      'POLICY_MAX_TRADES_PER_HOUR',
    ];
    const safety = ['RUG_DETECTED', 'HOLDER_CONCENTRATION', 'PAIR_TOO_OLD'];
    if (structural.includes(reason)) return 'structural';
    if (safety.includes(reason)) return 'safety';
    return 'signal';
  }

  function entryFilterReasonClass(reason: string): 'structural' | 'market' | 'safety' {
    const structural = ['PAIR_TOO_OLD'];
    const safety = ['MAX_TOP_HOLDER_PCT', 'MIN_HOLDER_COUNT', 'DEX_NOT_ALLOWED'];
    if (structural.includes(reason)) return 'structural';
    if (safety.includes(reason)) return 'safety';
    return 'market';
  }

  function entryFilterHints(stats: PolicyEntryFilterStatsRow): ReactNode {
    const breakdown = stats.breakdown ?? {};
    const entries = Object.entries(breakdown).filter(
      ([, v]) => v && typeof v === 'object' && v.count > 0
    );
    if (entries.length === 0) return null;
    const top = entries.reduce((a, b) => (b[1].count > a[1].count ? b : a));
    const topReason = top[0];
    const hints: string[] = [];
    if (topReason === 'PAIR_TOO_OLD')
      hints.push('PAIR_TOO_OLD dominates → Policy is extremely early-biased.');
    if (topReason === 'MIN_VOLUME_5M' || topReason === 'MIN_VOLUME_1M')
      hints.push('MIN_VOLUME dominates → Market is cold or threshold is high.');
    if (topReason === 'MIN_PRICE_CHANGE_1M_PCT')
      hints.push('MIN_PRICE_CHANGE_1M_PCT dominates → Few pairs meet the 1m momentum bar or snapshot data is sparse.');
    if (topReason === 'MAX_TOP_HOLDER_PCT')
      hints.push('MAX_TOP_HOLDER_PCT dominates → Safety working, but possibly conservative.');
    if (hints.length === 0) return null;
    return (
      <div className="stats-hints-list">
        <h4>Insights</h4>
        <ul>
          {hints.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      </div>
    );
  }

  function rejectionHints(stats: PolicyRejectionStatsRow): ReactNode {
    const breakdown = stats.rejection_breakdown;
    const entries = Object.entries(breakdown).filter(([, v]) => v.count > 0);
    if (entries.length === 0) return null;
    const top = entries.reduce((a, b) => (b[1].count > a[1].count ? b : a));
    const topReason = top[0];
    const hints: string[] = [];
    if (topReason === 'LOW_SCORE')
      hints.push('LOW_SCORE dominates → Policy too strict or market cold.');
    if (topReason === 'TOKEN_REENTRY_COOLDOWN')
      hints.push(
        'TOKEN_REENTRY_COOLDOWN dominates → Policy finding opportunities but execution constrained.'
      );
    if (topReason === 'MAX_TRADES_PER_TOKEN')
      hints.push(
        'MAX_TRADES_PER_TOKEN dominates → Hot token regime, consider diversification.'
      );
    if (topReason === 'RUG_DETECTED')
      hints.push('RUG_DETECTED frequent → Entry filters working correctly.');
    if (hints.length === 0) return null;
    return (
      <div className="stats-hints-list">
        <h4>Insights</h4>
        <ul>
          {hints.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      </div>
    );
  }

  const exitBreakdownTotal = globalStats
    ? Object.values(globalStats.exit_reason_breakdown).reduce((a, b) => a + b, 0)
    : 0;

  const accountLabel = (a: AccountOption) =>
    a.name?.trim() ? `${a.name} (${a.account_id})` : `${a.account_id} (${a.mode})`;

  return (
    <div className="stats-tab">
      <header className="stats-header">
        <h2>Leaderboard</h2>
        <div className="stats-wallet-row">
          <label htmlFor="stats-account-select" className="stats-wallet-label">
            Wallet
          </label>
          <select
            id="stats-account-select"
            className="stats-wallet-select"
            value={selectedAccountId}
            onChange={(e) => setSelectedAccountId(e.target.value)}
            aria-label="Select wallet for analytics"
          >
            {accounts.length === 0 ? (
              <option value={selectedAccountId}>{selectedAccountId}</option>
            ) : (
              accounts.map((a) => (
                <option key={a.account_id} value={a.account_id}>
                  {accountLabel(a)}
                </option>
              ))
            )}
          </select>
        </div>
        <div className="stats-status">
          {error && <span className="status-error">MCP: {error}</span>}
          {connected && !error && <span className="status-ok">Connected to MCP</span>}
        </div>
      </header>

      {loadError && (
        <div className="stats-error">
          {loadError}
          <button type="button" onClick={() => window.location.reload()}>
            Retry
          </button>
        </div>
      )}

      {loading ? (
        <div className="stats-loading">Loading stats…</div>
      ) : (
        <>
          {/* Global overview */}
          <section className="stats-section">
            <h3>Global Overview</h3>
            <div className="stats-cards">
              <div className="stats-card">
                <span className="stats-card-label">
                  {accounts.find((a) => a.account_id === selectedAccountId)?.mode === 'live' ? 'Balance' : 'Paper Balance'}
                </span>
                <span className="stats-card-value">{globalStats ? fmtMoney(globalStats.paper_balance) : '—'}</span>
              </div>
              <div className="stats-card">
                <span className="stats-card-label">PnL Today</span>
                <span
                  className={`stats-card-value ${
                    globalStats
                      ? globalStats.pnl_today > 0
                        ? 'positive'
                        : globalStats.pnl_today < 0
                          ? 'negative'
                          : ''
                      : ''
                  }`}
                >
                  {globalStats ? fmtMoney(globalStats.pnl_today) : '—'}
                </span>
              </div>
              <div className="stats-card">
                <span className="stats-card-label">PnL All-Time</span>
                <span
                  className={`stats-card-value ${
                    globalStats
                      ? globalStats.pnl_total > 0
                        ? 'positive'
                        : globalStats.pnl_total < 0
                          ? 'negative'
                          : ''
                      : ''
                  }`}
                >
                  {globalStats ? fmtMoney(globalStats.pnl_total) : '—'}
                </span>
              </div>
              <div className="stats-card">
                <span className="stats-card-label">Trades Today</span>
                <span className="stats-card-value">{globalStats ? globalStats.trades_today : '—'}</span>
              </div>
              <div className="stats-card">
                <span className="stats-card-label">Active Trades</span>
                <span className="stats-card-value">{globalStats ? globalStats.active_trades : '—'}</span>
              </div>
              <div className="stats-card">
                <span className="stats-card-label">Active Policies</span>
                <span className="stats-card-value">{globalStats ? globalStats.active_policies : '—'}</span>
              </div>
            </div>
            {globalStats && exitBreakdownTotal > 0 && (
              <div className="stats-exit-mix">
                <span className="stats-exit-label">Exit reason mix:</span>
                <span>TP {globalStats.exit_reason_breakdown.TAKE_PROFIT}</span>
                <span>SL {globalStats.exit_reason_breakdown.STOP_LOSS}</span>
                <span>Time {globalStats.exit_reason_breakdown.TIME_STOP}</span>
                <span>Other {globalStats.exit_reason_breakdown.OTHER}</span>
              </div>
            )}
          </section>

          {/* Policy performance table */}
          <section className="stats-section">
            <h3>Policy Performance</h3>
            <p className="stats-section-hint">
              Click a policy row to open detail: Overview, Trades, Tokens, Rejections.
            </p>
            <div className="stats-leaderboard-options">
              <label className="stats-leaderboard-option">
                <input
                  type="checkbox"
                  checked={showRetired}
                  onChange={(e) => setShowRetired(e.target.checked)}
                />
                {' '}Show retired
              </label>
              <label className="stats-leaderboard-option">
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(e) => setShowArchived(e.target.checked)}
                />
                {' '}Show archived
              </label>
            </div>
            <div className="stats-table-wrapper">
              <table className="stats-table policy-stats-table">
                <thead>
                  <tr>
                    <th>Policy</th>
                    <th>Trades</th>
                    <th>Win %</th>
                    <th>Avg PnL</th>
                    <th>Total PnL</th>
                    <th>Avg Hold</th>
                    <th>TP %</th>
                    <th>SL %</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {policyStats.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="stats-empty">
                        No policy stats yet.
                      </td>
                    </tr>
                  ) : (
                    [...policyStats]
                      .sort((a, b) => (b.win_rate_pct ?? 0) - (a.win_rate_pct ?? 0))
                      .map((r) => (
                      <tr
                        key={r.policy_version}
                        className={`stats-policy-row ${selectedPolicyVersion === r.policy_version ? 'selected' : ''} ${
                          r.total_pnl > 0 ? 'row-profitable' : r.total_pnl < 0 ? 'row-losing' : 'row-flat'
                        }`}
                        onClick={() => setSelectedPolicyVersion(r.policy_version)}
                      >
                        <td className="stats-policy-version">{r.policy_version}</td>
                        <td>{fmtNum(r.trades, 0)}</td>
                        <td>{fmtPct(r.win_rate_pct)}</td>
                        <td className={r.avg_pnl_pct >= 0 ? 'positive' : 'negative'}>
                          {fmtPct(r.avg_pnl_pct, true)}
                        </td>
                        <td className={r.total_pnl > 0 ? 'positive' : r.total_pnl < 0 ? 'negative' : ''}>
                          {fmtMoney(r.total_pnl)}
                        </td>
                        <td>{fmtTime(r.avg_hold_seconds)}</td>
                        <td>{fmtPct(r.take_profit_pct)}</td>
                        <td>{fmtPct(r.stop_loss_pct)}</td>
                        <td>
                          <span className={`stats-status-badge status-${r.status}`}>{r.status}</span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Policy detail (when a row is selected) — appears right after Policy Performance */}
          {selectedPolicyVersion && (
            <section ref={policyDetailSectionRef} className="stats-section stats-policy-detail">
              <h3>
                Policy: {selectedPolicyVersion}
                <button
                  type="button"
                  className="stats-detail-close"
                  onClick={() => setSelectedPolicyVersion(null)}
                  aria-label="Close"
                >
                  ×
                </button>
              </h3>
              <div className="stats-detail-tabs">
                {(['overview', 'trades', 'tokens', 'rejections', 'entry_filters'] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    className={`stats-detail-tab ${detailSubTab === tab ? 'active' : ''}`}
                    onClick={() => setDetailSubTab(tab)}
                  >
                    {tab === 'entry_filters' ? 'Entry Filters' : tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </button>
                ))}
              </div>

              {detailSubTab === 'overview' && policyDetail && (
                <>
                  <div className="stats-cards stats-detail-cards">
                    <div className="stats-card">
                      <span className="stats-card-label">Trades (24h / total)</span>
                      <span className="stats-card-value">
                        {policyDetail.trades_last_24h} / {policyDetail.trades_total}
                      </span>
                    </div>
                    <div className="stats-card">
                      <span className="stats-card-label">Win rate</span>
                      <span className="stats-card-value">{fmtPct(policyDetail.win_rate_pct)}</span>
                    </div>
                    <div className="stats-card">
                      <span className="stats-card-label">Avg R:R</span>
                      <span className="stats-card-value">
                        {policyDetail.avg_rr != null ? policyDetail.avg_rr.toFixed(2) : '—'}
                      </span>
                    </div>
                    <div className="stats-card">
                      <span className="stats-card-label">Avg hold</span>
                      <span className="stats-card-value">
                        {policyDetail.avg_hold_seconds != null
                          ? fmtTime(policyDetail.avg_hold_seconds)
                          : '—'}
                      </span>
                    </div>
                    <div className="stats-card">
                      <span className="stats-card-label">Max consecutive losses</span>
                      <span className="stats-card-value">{policyDetail.max_consecutive_losses}</span>
                    </div>
                  </div>
                  {Object.keys(policyDetail.exit_breakdown).length > 0 && (
                    <div className="stats-exit-breakdown">
                      <h4>Exit breakdown</h4>
                      <div className="stats-exit-bars">
                        {Object.entries(policyDetail.exit_breakdown).map(([reason, count]) => (
                          <div key={reason} className="stats-exit-bar-row">
                            <span className="stats-exit-bar-label">{reason}</span>
                            <div className="stats-exit-bar-wrap">
                              <div
                                className="stats-exit-bar"
                                style={{
                                  width: `${
                                    policyDetail.trades_total > 0
                                      ? (count / policyDetail.trades_total) * 100
                                      : 0
                                  }%`,
                                }}
                              />
                            </div>
                            <span className="stats-exit-bar-count">{count}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}

              {detailSubTab === 'trades' && (
                <>
                  <h4>Trades (this policy)</h4>
                  <div className="stats-table-wrapper">
                    <table className="stats-table">
                      <thead>
                        <tr>
                          <th>Time</th>
                          <th>Token</th>
                          <th>Entry</th>
                          <th>Exit</th>
                          <th>PnL %</th>
                          <th>Exit reason</th>
                          <th>Hold</th>
                        </tr>
                      </thead>
                      <tbody>
                        {policyDetailTrades.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="stats-empty">
                              No trades for this policy.
                            </td>
                          </tr>
                        ) : (
                          policyDetailTrades.map((t) => (
                            <tr key={t.trade_id}>
                              <td>{fmtTimestamp(t.timestamp)}</td>
                              <td>
                                {t.token_mint ? (
                                  <TokenMintCell mint={t.token_mint} symbol={tokenSymbols[t.token_mint]} linkTo="dexscreener" />
                                ) : (
                                  '—'
                                )}
                              </td>
                              <td>{t.entry_price.toFixed(6)}</td>
                              <td>{t.exit_price.toFixed(6)}</td>
                              <td className={t.pnl_pct >= 0 ? 'positive' : 'negative'}>
                                {fmtPct(t.pnl_pct, true)}
                              </td>
                              <td>{t.exit_reason}</td>
                              <td>{fmtTime(t.hold_seconds)}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {detailSubTab === 'tokens' && (
                <>
                  <h4>Token exposure</h4>
                  <div className="stats-table-wrapper">
                    <table className="stats-table">
                      <thead>
                        <tr>
                          <th>Token</th>
                          <th>Trades</th>
                          <th>Net PnL</th>
                          <th>Win %</th>
                          <th>Avg Hold</th>
                          <th>Last Trade</th>
                        </tr>
                      </thead>
                      <tbody>
                        {policyTokenStats.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="stats-empty">
                              No token exposure for this policy.
                            </td>
                          </tr>
                        ) : (
                          policyTokenStats.map((t) => (
                            <tr
                              key={t.token_mint || 'empty'}
                              className={
                                t.trades >= 3 && t.net_pnl < 0 ? 'stats-token-danger' : ''
                              }
                            >
                              <td>
                                {t.token_mint ? (
                                  <TokenMintCell mint={t.token_mint} symbol={tokenSymbols[t.token_mint]} linkTo="dexscreener" />
                                ) : (
                                  '—'
                                )}
                              </td>
                              <td>{t.trades}</td>
                              <td className={t.net_pnl >= 0 ? 'positive' : 'negative'}>
                                {fmtMoney(t.net_pnl)}
                              </td>
                              <td>{fmtPct(t.win_rate_pct)}</td>
                              <td>{fmtTime(t.avg_hold_seconds)}</td>
                              <td>{t.last_trade_at ? fmtTimestamp(t.last_trade_at) : '—'}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {detailSubTab === 'rejections' && (
                <>
                  <h4>Rejection summary (24h)</h4>
                  {policyRejectionStats && (
                    <>
                      <div className="stats-cards stats-detail-cards">
                        <div className="stats-card">
                          <span className="stats-card-label">Total rejections</span>
                          <span className="stats-card-value">{policyRejectionStats.total_rejections}</span>
                        </div>
                        <div className="stats-card">
                          <span className="stats-card-label">% of decisions rejected</span>
                          <span className="stats-card-value">
                            {policyRejectionStats.total_decisions === 0
                              ? '—'
                              : fmtPct(
                                  (policyRejectionStats.total_rejections /
                                    policyRejectionStats.total_decisions) *
                                    100
                                )}
                          </span>
                        </div>
                        <div className="stats-card">
                          <span className="stats-card-label">Top rejection reason</span>
                          <span className="stats-card-value">
                            {(() => {
                              const breakdown = policyRejectionStats.rejection_breakdown ?? {};
                              const entries = Object.entries(breakdown).filter(
                                ([, v]) => v && typeof v === 'object' && v.count > 0
                              );
                              if (entries.length === 0) return '—';
                              const top = entries.reduce((a, b) =>
                                (b[1].count > a[1].count ? b : a)
                              );
                              return top[0];
                            })()}
                          </span>
                        </div>
                      </div>
                      <h4>Rejection breakdown</h4>
                      <div className="stats-table-wrapper">
                        <table className="stats-table stats-rejection-table">
                          <thead>
                            <tr>
                              <th>Reason</th>
                              <th>Count</th>
                              <th>% of Rejections</th>
                              <th>% of All Decisions</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(policyRejectionStats.rejection_breakdown)
                              .filter(([, v]) => v.count > 0)
                              .sort((a, b) => b[1].count - a[1].count)
                              .map(([reason, v]) => (
                                <tr
                                  key={reason}
                                  className={`stats-rejection-row reason-${reasonClass(reason)}`}
                                >
                                  <td className="stats-rejection-reason">{reason}</td>
                                  <td>{v.count}</td>
                                  <td>{fmtPct(v.pct_of_rejections)}</td>
                                  <td>{fmtPct(v.pct_of_all_decisions)}</td>
                                </tr>
                              ))}
                            {Object.values(policyRejectionStats.rejection_breakdown).every(
                              (v) => v.count === 0
                            ) && (
                              <tr>
                                <td colSpan={4} className="stats-empty">
                                  No rejections in the last 24h.
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                      <div className="stats-rejection-hints">
                        {rejectionHints(policyRejectionStats)}
                      </div>
                    </>
                  )}
                  {!policyRejectionStats && (
                    <div className="stats-empty">Loading rejection stats…</div>
                  )}
                </>
              )}

              {detailSubTab === 'entry_filters' && (
                <>
                  <h4>Entry filter rejection summary (24h)</h4>
                  {policyEntryFilterStats && (
                    <>
                      <div className="stats-cards stats-detail-cards">
                        <div className="stats-card">
                          <span className="stats-card-label">Entry filter rejections</span>
                          <span className="stats-card-value">
                            {policyEntryFilterStats.total_entry_filter_rejections}
                          </span>
                        </div>
                        <div className="stats-card">
                          <span className="stats-card-label">Top rejecting filter</span>
                          <span className="stats-card-value">
                            {(() => {
                              const breakdown = policyEntryFilterStats.breakdown ?? {};
                              const entries = Object.entries(breakdown).filter(
                                ([, v]) => v && typeof v === 'object' && v.count > 0
                              );
                              if (entries.length === 0) return '—';
                              const top = entries.reduce((a, b) =>
                                (b[1].count > a[1].count ? b : a)
                              );
                              return top[0];
                            })()}
                          </span>
                        </div>
                      </div>
                      <h4>Entry filter breakdown</h4>
                      <div className="stats-table-wrapper">
                        <table className="stats-table stats-rejection-table">
                          <thead>
                            <tr>
                              <th>Filter</th>
                              <th>Reject Count</th>
                              <th>% of Entry Rejects</th>
                              <th>Avg Miss</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(policyEntryFilterStats.breakdown ?? {})
                              .filter(([, v]) => v && v.count > 0)
                              .sort((a, b) => b[1].count - a[1].count)
                              .map(([reason, v]) => (
                                <tr
                                  key={reason}
                                  className={`stats-rejection-row reason-${entryFilterReasonClass(reason)}`}
                                >
                                  <td className="stats-rejection-reason">{reason}</td>
                                  <td>{v.count}</td>
                                  <td>{fmtPct(v.pct_of_entry_filter_rejections)}</td>
                                  <td>
                                    {v.avg_distance_from_threshold != null
                                      ? `${v.avg_distance_from_threshold >= 0 ? '+' : ''}${(v.avg_distance_from_threshold * 100).toFixed(1)}%`
                                      : '—'}
                                  </td>
                                </tr>
                              ))}
                            {Object.values(policyEntryFilterStats.breakdown ?? {}).every(
                              (v) => !v || v.count === 0
                            ) && (
                              <tr>
                                <td colSpan={4} className="stats-empty">
                                  No entry filter rejections in the last 24h.
                                </td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                      <div className="stats-rejection-hints">
                        {entryFilterHints(policyEntryFilterStats)}
                      </div>
                    </>
                  )}
                  {!policyEntryFilterStats && (
                    <div className="stats-empty">Loading entry filter stats…</div>
                  )}
                </>
              )}
            </section>
          )}

          {/* Top performing tokens (scoped to selected wallet) */}
          <section className="stats-section">
            <h3>Top performing tokens</h3>
            <p className="stats-section-hint">
              By net PnL for the selected wallet.
              {accounts.length > 0 && (
                <> Showing: <strong>{accountLabel(accounts.find((a) => a.account_id === selectedAccountId) ?? { account_id: selectedAccountId, mode: '' })}</strong></>
              )}
            </p>
            <div className="stats-table-wrapper">
              <table className="stats-table">
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Trades</th>
                    <th>Net PnL</th>
                    <th>Win %</th>
                    <th>Avg Hold</th>
                    <th>Last trade</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {topTokens.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="stats-empty">
                        No token data yet.
                      </td>
                    </tr>
                  ) : (
                    (() => {
                      const sel = accounts.find((a) => a.account_id === selectedAccountId);
                      const liveMaker =
                        sel?.mode === 'live' && sel?.address?.trim() ? sel.address.trim() : undefined;
                      return topTokens.map((t) => (
                        <tr
                          key={t.token_mint}
                          className={
                            t.trades >= 3 && t.net_pnl < 0 ? 'stats-token-danger' : ''
                          }
                        >
                          <td>
                            <TokenMintCell
                              mint={t.token_mint}
                              symbol={tokenSymbols[t.token_mint]}
                              linkTo="dexscreener"
                              makerAddress={liveMaker}
                            />
                          </td>
                        <td>{fmtNum(t.trades, 0)}</td>
                        <td className={t.net_pnl >= 0 ? 'positive' : 'negative'}>
                          {fmtMoney(t.net_pnl)}
                        </td>
                        <td>{fmtPct(t.win_rate_pct)}</td>
                        <td>{fmtTime(t.avg_hold_seconds)}</td>
                        <td>{t.last_trade_at ? fmtTimestamp(t.last_trade_at) : '—'}</td>
                        <td>
                          <button
                            type="button"
                            className="stats-view-trades-btn"
                            onClick={() => setSelectedTokenForTrades(t.token_mint)}
                          >
                            View trades
                          </button>
                        </td>
                      </tr>
                      ));
                    })()
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* Modal: trades for selected token (from top performing tokens) */}
          {selectedTokenForTrades && (
            <div
              className="stats-token-trades-overlay"
              onClick={() => setSelectedTokenForTrades(null)}
            >
              <div
                className="stats-token-trades-modal"
                onClick={(e) => e.stopPropagation()}
              >
                <h3>
                  Trades for {tokenSymbols[selectedTokenForTrades] || selectedTokenForTrades.slice(0, 8) + '…'}
                  <button
                    type="button"
                    className="stats-detail-close"
                    onClick={() => setSelectedTokenForTrades(null)}
                    aria-label="Close"
                  >
                    ×
                  </button>
                </h3>
                {tokenTradesLoading ? (
                  <div className="stats-empty">Loading trades…</div>
                ) : (
                  <div className="stats-table-wrapper">
                    <table className="stats-table">
                      <thead>
                        <tr>
                          <th>Trade ID</th>
                          <th>Mode</th>
                          <th>Time</th>
                          <th>Policy</th>
                          <th>Entry</th>
                          <th>Exit</th>
                          <th>PnL %</th>
                          <th>Exit reason</th>
                          <th>Hold</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tokenTradesList.length === 0 ? (
                          <tr>
                            <td colSpan={9} className="stats-empty">
                              No trades for this token.
                            </td>
                          </tr>
                        ) : (
                          tokenTradesList.map((t) => (
                            <tr key={t.trade_id}>
                              <td className="stats-trade-id">{t.trade_id}</td>
                              <td>
                                <span className={`stats-mode-badge stats-mode-${t.execution_mode ?? 'paper'}`}>
                                  {t.execution_mode === 'live' ? 'live' : 'paper'}
                                </span>
                              </td>
                              <td>{fmtTimestamp(t.timestamp)}</td>
                              <td className="stats-policy-version">{t.policy_version}</td>
                              <td>{t.entry_price.toFixed(6)}</td>
                              <td>{t.exit_price.toFixed(6)}</td>
                              <td className={t.pnl_pct >= 0 ? 'positive' : 'negative'}>
                                {fmtPct(t.pnl_pct, true)}
                              </td>
                              <td>{t.exit_reason}</td>
                              <td>{fmtTime(t.hold_seconds)}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

        </>
      )}
    </div>
  );
}
