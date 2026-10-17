import { useState, useEffect, useCallback } from 'react';
import { useMcpClient } from '../hooks/useMcpClient';
import { CHAIN_OPTIONS } from '../lib/chains';
import './AccountTab.css';

export interface AccountRow {
  account_id: string;
  mode: string;
  chain: string;
  name?: string | null;
  /** Set for live Solana account: public address derived from env SOLANA_PRIVATE_KEY. */
  address?: string | null;
  starting_equity: number;
  current_equity: number;
  available_balance: number;
  balance_native?: number | null;
  balance_native_usd?: number | null;
  balance_last_updated?: number | null;
  max_daily_drawdown_pct: number | null;
  max_total_open_trades: number | null;
  max_total_risk_pct: number;
  trading_enabled: number;
  is_active: number;
  created_at: number;
  updated_at: number;
}

const STALE_BALANCE_SEC = 5 * 60; // 5 minutes

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

/** Format SOL with up to 4 decimals, trim trailing zeros. Never show lamports. */
function formatSol(sol: number): string {
  const s = sol.toFixed(4);
  const trimmed = s.replace(/\.?0+$/, '');
  return trimmed;
}

function formatRelativeTime(ts: number): string {
  const sec = Math.floor(Date.now() / 1000) - ts;
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

export interface AccountSettings {
  account_id: string;
  mode: string;
  chain?: string | null;
  name?: string | null;
  starting_equity: number;
  current_equity: number;
  available_balance: number;
  max_daily_drawdown_pct: number | null;
  max_total_open_trades: number | null;
  max_total_risk_pct: number | null;
  trading_enabled: number;
  is_active?: number;
  created_at?: number;
  updated_at?: number;
}

export function AccountTab() {
  const { callTool, error, connected } = useMcpClient();
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [config, setConfig] = useState<{
    live_trading_enabled?: boolean;
    live_trading_options?: {
      live_trading_enabled: boolean;
      live_execution_dry_run: boolean;
      solana_rpc_configured: boolean;
      solana_signer_configured: boolean;
    };
  } | null>(null);
  const [paperAccount, setPaperAccount] = useState<AccountSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [editModalAccount, setEditModalAccount] = useState<AccountRow | null>(null);
  const [editMaxDailyDrawdownPct, setEditMaxDailyDrawdownPct] = useState('');
  const [editMaxTotalOpenTrades, setEditMaxTotalOpenTrades] = useState('');
  const [editMaxTotalRiskPct, setEditMaxTotalRiskPct] = useState('');
  const [editTradingEnabled, setEditTradingEnabled] = useState(true);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [togglingActiveId, setTogglingActiveId] = useState<string | null>(null);
  const [copiedAddressId, setCopiedAddressId] = useState<string | null>(null);

  const copyAddress = useCallback((accountId: string, address: string) => {
    void navigator.clipboard.writeText(address).then(() => {
      setCopiedAddressId(accountId);
      setTimeout(() => setCopiedAddressId(null), 2000);
    });
  }, []);

  const fetchAccounts = useCallback(async (showLoading = true) => {
    if (!connected) return;
    if (showLoading) setLoading(true);
    setLoadError(null);
    try {
      const result = await callTool('list_accounts', {});
      const list = Array.isArray(result) ? result : [];
      setAccounts(list as AccountRow[]);
    } catch (err) {
      if (showLoading) {
        setLoadError(err instanceof Error ? err.message : String(err));
        setAccounts([]);
      }
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [callTool, connected]);

  const fetchConfig = useCallback(async () => {
    if (!connected) return;
    try {
      const result = (await callTool('get_config', {})) as typeof config;
      setConfig(result ?? null);
    } catch {
      setConfig(null);
    }
  }, [callTool, connected]);

  const fetchPaperAccount = useCallback(async () => {
    if (!connected) return;
    try {
      const result = await callTool('get_paper_account', {});
      const data = result && typeof result === 'object' && 'account_id' in result ? (result as AccountSettings) : null;
      setPaperAccount(data);
    } catch {
      setPaperAccount(null);
    }
  }, [callTool, connected]);

  useEffect(() => {
    fetchAccounts();
    fetchConfig();
    fetchPaperAccount();
  }, [fetchAccounts, fetchConfig, fetchPaperAccount]);

  useEffect(() => {
    const interval = setInterval(() => void fetchAccounts(false), 30_000);
    return () => clearInterval(interval);
  }, [fetchAccounts]);

  const openEditModal = useCallback((row: AccountRow) => {
    setEditModalAccount(row);
    setEditMaxDailyDrawdownPct(row.max_daily_drawdown_pct != null ? String(row.max_daily_drawdown_pct) : '');
    setEditMaxTotalOpenTrades(row.max_total_open_trades != null ? String(row.max_total_open_trades) : '');
    setEditMaxTotalRiskPct(row.max_total_risk_pct != null ? String(row.max_total_risk_pct) : '');
    setEditTradingEnabled(row.trading_enabled === 1);
    setEditError(null);
  }, []);

  const handleEditSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!connected || !editModalAccount || editSubmitting) return;
      setEditError(null);
      setEditSubmitting(true);
      try {
        await callTool('update_account_settings', {
          account_id: editModalAccount.account_id,
          max_daily_drawdown_pct: editMaxDailyDrawdownPct.trim() === '' ? null : Number(editMaxDailyDrawdownPct),
          max_total_open_trades: editMaxTotalOpenTrades.trim() === '' ? null : Math.floor(Number(editMaxTotalOpenTrades)),
          max_total_risk_pct: editMaxTotalRiskPct.trim() === '' ? null : Number(editMaxTotalRiskPct),
          trading_enabled: editTradingEnabled,
        });
        await fetchAccounts();
        if (editModalAccount.mode === 'paper') await fetchPaperAccount();
        setEditModalAccount(null);
      } catch (err) {
        setEditError(err instanceof Error ? err.message : String(err));
      } finally {
        setEditSubmitting(false);
      }
    },
    [
      callTool,
      connected,
      editModalAccount,
      editSubmitting,
      editMaxDailyDrawdownPct,
      editMaxTotalOpenTrades,
      editMaxTotalRiskPct,
      editTradingEnabled,
      fetchAccounts,
      fetchPaperAccount,
    ]
  );

  const handleResetPaperAccount = useCallback(async () => {
    if (!connected || resetting) return;
    if (!window.confirm('Close all open paper trades and reset balance to starting equity?')) return;
    setResetting(true);
    try {
      await callTool('reset_paper_account', {});
      await fetchPaperAccount();
      await fetchAccounts();
    } catch (err) {
      console.error('Reset paper account failed:', err);
    } finally {
      setResetting(false);
    }
  }, [callTool, connected, resetting, fetchPaperAccount, fetchAccounts]);

  const handleToggleActive = useCallback(
    async (row: AccountRow) => {
      if (!connected || togglingActiveId) return;
      const nextActive = row.is_active !== 1;
      if (nextActive && row.mode === 'live' && !config?.live_trading_enabled) {
        const ok = window.confirm(
          'Live trading is globally disabled (LIVE_TRADING_ENABLED is not true). Enable it in the environment before activating live accounts. Activate this account anyway?'
        );
        if (!ok) return;
      }
      setTogglingActiveId(row.account_id);
      try {
        await callTool('update_account_settings', { account_id: row.account_id, is_active: nextActive });
        await fetchAccounts();
        if (paperAccount?.account_id === row.account_id) await fetchPaperAccount();
      } finally {
        setTogglingActiveId(null);
      }
    },
    [callTool, connected, togglingActiveId, config?.live_trading_enabled, fetchAccounts, fetchPaperAccount, paperAccount?.account_id]
  );

  const fmtMoney = (n: number | null | undefined) =>
    n != null ? `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';

  const chainLabel = (c: string) => CHAIN_OPTIONS.find((o) => o.value === c)?.label ?? c;

  return (
    <div className="account-tab">
      <header className="account-header">
        <h2>Accounts</h2>
        <div className="account-status">
          {error && <span className="status-error">MCP: {error}</span>}
          {connected && !error && <span className="status-ok">Connected to MCP</span>}
        </div>
      </header>

      {toastMessage && (
        <div className="account-toast" role="status">
          {toastMessage}
        </div>
      )}

      <p className="account-warning">
        Account-level limits are checked before any policy runs. New live accounts start inactive.
      </p>

      {loadError && (
        <div className="account-error">
          {loadError}
          <button onClick={fetchAccounts}>Retry</button>
        </div>
      )}

      {loading ? (
        <div className="account-loading">Loading accounts…</div>
      ) : (
        <>
          <section className="account-list-section">
            <div className="account-list-header">
              <h3>All accounts</h3>
            </div>
            <div className="account-table-wrap">
              <table className="account-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Mode</th>
                    <th>Chain</th>
                    <th>Balance</th>
                    <th>Active</th>
                    <th>Max risk %</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.length === 0 ? (
                    <tr>
                      <td colSpan={7}>No accounts. Ensure the paper and solana-wallet accounts are seeded.</td>
                    </tr>
                  ) : (
                    accounts.map((row) => {
                      const isStale =
                        row.mode === 'live' &&
                        row.chain === 'solana' &&
                        row.balance_last_updated != null &&
                        Math.floor(Date.now() / 1000) - row.balance_last_updated > STALE_BALANCE_SEC;
                      return (
                        <tr key={row.account_id}>
                          <td>
                            {row.chain === 'solana' && row.mode === 'live' && row.address ? (
                              <span className="account-name-with-copy">
                                <a
                                  href={`https://solscan.io/account/${row.address}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="account-name-link"
                                >
                                  {row.name || row.account_id}
                                </a>
                                <button
                                  type="button"
                                  className="account-copy-address-btn"
                                  onClick={() => copyAddress(row.account_id, row.address!)}
                                  title="Copy address"
                                  aria-label="Copy address"
                                >
                                  {copiedAddressId === row.account_id ? <CheckIcon /> : <CopyIcon />}
                                </button>
                              </span>
                            ) : (
                              row.name || row.account_id
                            )}
                          </td>
                          <td>
                            <span className={`account-badge account-badge-mode ${row.mode === 'live' ? 'live' : 'paper'}`}>
                              {row.mode === 'live' ? 'LIVE' : 'PAPER'}
                            </span>
                          </td>
                          <td>
                            <span className="account-badge account-badge-chain">
                              {row.chain !== 'paper' ? chainLabel(row.chain) : '—'}
                            </span>
                          </td>
                          <td className="account-balance-cell">
                            {row.mode === 'paper' ? (
                              fmtMoney(row.current_equity)
                            ) : row.chain === 'solana' ? (
                              <>
                                {row.balance_native == null ? (
                                  <span className="account-balance-fetching">Fetching…</span>
                                ) : (
                                  <>
                                    <span className="account-balance-native">{formatSol(row.balance_native)} SOL</span>
                                    {row.balance_native_usd != null && (
                                      <span className="account-balance-usd"> ({fmtMoney(row.balance_native_usd)})</span>
                                    )}
                                  </>
                                )}
                                {row.balance_last_updated != null && (
                                  <div className="account-balance-updated">
                                    Updated: {formatRelativeTime(row.balance_last_updated)}
                                    {isStale && <span className="account-balance-stale" title="Balance older than 5 minutes"> ⚠️ stale</span>}
                                  </div>
                                )}
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td>
                            <button
                              type="button"
                              className={`account-toggle-active ${row.is_active ? 'active' : 'inactive'}`}
                              onClick={() => handleToggleActive(row)}
                              disabled={togglingActiveId === row.account_id}
                              title={row.is_active ? 'Deactivate' : 'Activate'}
                            >
                              {togglingActiveId === row.account_id ? '…' : row.is_active ? 'On' : 'Off'}
                            </button>
                          </td>
                          <td>{row.max_total_risk_pct != null ? `${row.max_total_risk_pct}%` : '—'}</td>
                          <td>
                            <button
                              type="button"
                              className="account-edit-btn"
                              onClick={() => openEditModal(row)}
                              disabled={!connected}
                              title="Edit risk limits"
                            >
                              Edit
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {paperAccount && (
            <section className="account-settings">
              <div className="account-readonly">
                <h3>Paper account (read-only)</h3>
                <div className="account-badges">
                  <span className="account-badge account-badge-mode paper">PAPER</span>
                </div>
                <div className="account-grid">
                  <div className="account-row">
                    <span className="account-label">Starting equity</span>
                    <span className="account-value">{fmtMoney(paperAccount.starting_equity)}</span>
                  </div>
                  <div className="account-row">
                    <span className="account-label">Current equity</span>
                    <span className="account-value">{fmtMoney(paperAccount.current_equity)}</span>
                  </div>
                  <div className="account-reset-wrap">
                    <button
                      type="button"
                      className="account-reset-btn"
                      onClick={handleResetPaperAccount}
                      disabled={!connected || resetting}
                    >
                      {resetting ? 'Resetting…' : 'Reset paper account'}
                    </button>
                  </div>
                </div>
              </div>
            </section>
          )}

          {config?.live_trading_options && (
            <section className="account-live-options">
              <h3>Global options for live trading</h3>
              <div className="account-live-options-grid">
                <div className="account-live-option">
                  <span className="account-live-option-label">Live trading enabled</span>
                  <span className={`account-live-option-value ${config.live_trading_options.live_trading_enabled ? 'ok' : 'muted'}`}>
                    {config.live_trading_options.live_trading_enabled ? 'Yes' : 'No'}
                  </span>
                  <span className="account-live-option-hint">LIVE_TRADING_ENABLED</span>
                </div>
                <div className="account-live-option">
                  <span className="account-live-option-label">Dry run (simulate only)</span>
                  <span className={`account-live-option-value ${config.live_trading_options.live_execution_dry_run ? 'warn' : 'muted'}`}>
                    {config.live_trading_options.live_execution_dry_run ? 'Yes' : 'No'}
                  </span>
                  <span className="account-live-option-hint">LIVE_EXECUTION_DRY_RUN</span>
                </div>
                <div className="account-live-option">
                  <span className="account-live-option-label">Solana RPC</span>
                  <span className={`account-live-option-value ${config.live_trading_options.solana_rpc_configured ? 'ok' : 'muted'}`}>
                    {config.live_trading_options.solana_rpc_configured ? 'Configured' : 'Not set'}
                  </span>
                  <span className="account-live-option-hint">HELIUS_RPC_URL</span>
                </div>
                <div className="account-live-option">
                  <span className="account-live-option-label">Solana signer</span>
                  <span className={`account-live-option-value ${config.live_trading_options.solana_signer_configured ? 'ok' : 'muted'}`}>
                    {config.live_trading_options.solana_signer_configured ? 'Configured' : 'Not set'}
                  </span>
                  <span className="account-live-option-hint">SOLANA_PRIVATE_KEY</span>
                </div>
              </div>
            </section>
          )}
        </>
      )}

      {editModalAccount && (
        <div className="account-modal-backdrop" onClick={() => !editSubmitting && setEditModalAccount(null)}>
          <div className="account-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Edit account — {editModalAccount.name || editModalAccount.account_id}</h3>
            <form onSubmit={handleEditSubmit} className="account-modal-form">
              {editError && <div className="account-modal-error">{editError}</div>}
              <div className="account-form-row">
                <label htmlFor="edit-max_daily_drawdown_pct">Max daily drawdown %</label>
                <input
                  id="edit-max_daily_drawdown_pct"
                  type="number"
                  step="0.1"
                  min="0"
                  max="100"
                  placeholder="e.g. 15"
                  value={editMaxDailyDrawdownPct}
                  onChange={(e) => setEditMaxDailyDrawdownPct(e.target.value)}
                />
              </div>
              <div className="account-form-row">
                <label htmlFor="edit-max_total_open_trades">Max total open trades</label>
                <input
                  id="edit-max_total_open_trades"
                  type="number"
                  min="0"
                  step="1"
                  placeholder="e.g. 20"
                  value={editMaxTotalOpenTrades}
                  onChange={(e) => setEditMaxTotalOpenTrades(e.target.value)}
                />
              </div>
              <div className="account-form-row">
                <label htmlFor="edit-max_total_risk_pct">Max total risk % (portfolio heat)</label>
                <input
                  id="edit-max_total_risk_pct"
                  type="number"
                  step="0.1"
                  min="0"
                  max="100"
                  placeholder="e.g. 15"
                  value={editMaxTotalRiskPct}
                  onChange={(e) => setEditMaxTotalRiskPct(e.target.value)}
                />
                <span className="account-field-hint">Sum of open-trade risk must stay below this % of equity.</span>
              </div>
              <div className="account-form-row account-form-check">
                <label>
                  <input type="checkbox" checked={editTradingEnabled} onChange={(e) => setEditTradingEnabled(e.target.checked)} />
                  {' '}Trading enabled (kill switch for this account)
                </label>
              </div>
              <div className="account-modal-actions">
                <button type="button" className="account-modal-cancel" onClick={() => !editSubmitting && setEditModalAccount(null)} disabled={editSubmitting}>
                  Cancel
                </button>
                <button type="submit" className="account-modal-submit" disabled={!connected || editSubmitting}>
                  {editSubmitting ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
