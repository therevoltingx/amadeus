import { useState, useEffect, useCallback } from 'react';
import { useMcpClient } from '../hooks/useMcpClient';
import './AnalyticsTab.css';

/** Hourly bucket from get_policy_stats_timeseries MCP tool (policy_stats_hourly). */
interface PolicyStatsTimeseriesRow {
  bucket_start: number;
  policy_version: string;
  scores_above_priority: number;
  trades_opened: number;
  wins: number;
  losses: number;
  skips_token_cooldown: number;
  skips_policy_cooldown: number;
  skips_max_trades_per_hour: number;
  skips_entry_filter: number;
  skips_score_below_threshold: number;
  avg_trade_score: number | null;
  avg_blocked_trade_score: number | null;
}

interface PolicyStatRow {
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

const TIMESERIES_RANGES = [
  { label: 'Last 6 hours', hours: 6 },
  { label: 'Last 12 hours', hours: 12 },
  { label: 'Last 24 hours', hours: 24 },
  { label: 'Last 72 hours', hours: 72 },
] as const;

const CHART_HEIGHT = 180;
const CHART_PAD = { top: 8, right: 8, bottom: 24, left: 40 };

function TimeseriesChartOpportunity({ data }: { data: PolicyStatsTimeseriesRow[] }) {
  const maxScore = Math.max(1, ...data.map((d) => d.scores_above_priority));
  const maxTrades = Math.max(1, ...data.map((d) => d.trades_opened));
  const width = Math.max(300, data.length * 24);
  const innerW = width - CHART_PAD.left - CHART_PAD.right;
  const innerH = CHART_HEIGHT - CHART_PAD.top - CHART_PAD.bottom;
  const scaleY = (v: number, maxV: number) =>
    CHART_PAD.top + innerH - (v / maxV) * innerH;
  const scaleX = (i: number) =>
    CHART_PAD.left + (i / Math.max(1, data.length - 1)) * innerW;
  const linePoints = data
    .map((d, i) => `${scaleX(i)},${scaleY(d.scores_above_priority, maxScore)}`)
    .join(' ');
  return (
    <div className="analytics-chart-svg-wrap">
      <svg width={width} height={CHART_HEIGHT} className="analytics-chart-svg">
        <line
          x1={CHART_PAD.left}
          y1={CHART_PAD.top + innerH}
          x2={CHART_PAD.left + innerW}
          y2={CHART_PAD.top + innerH}
          stroke="var(--chart-axis, #475569)"
          strokeWidth="1"
        />
        <polyline
          fill="none"
          stroke="var(--chart-line-1, #3b82f6)"
          strokeWidth="2"
          points={linePoints}
        />
        {data.map((d, i) => (
          <rect
            key={d.bucket_start}
            x={scaleX(i) - (innerW / Math.max(1, data.length)) / 2 + 2}
            y={scaleY(d.trades_opened, maxTrades)}
            width={Math.max(2, innerW / data.length - 4)}
            height={CHART_PAD.top + innerH - scaleY(d.trades_opened, maxTrades)}
            fill="var(--chart-bar, #64748b)"
            opacity={0.8}
          />
        ))}
      </svg>
      <div className="analytics-chart-legend">
        <span className="analytics-chart-legend-line">— Opportunities (priority)</span>
        <span className="analytics-chart-legend-bar">■ Trades opened</span>
      </div>
    </div>
  );
}

function TimeseriesChartSkips({ data }: { data: PolicyStatsTimeseriesRow[] }) {
  const totalMax = Math.max(
    1,
    ...data.map(
      (d) =>
        d.skips_token_cooldown +
        d.skips_policy_cooldown +
        d.skips_max_trades_per_hour +
        d.skips_entry_filter +
        d.skips_score_below_threshold
    )
  );
  const width = Math.max(300, data.length * 24);
  const innerW = width - CHART_PAD.left - CHART_PAD.right;
  const innerH = CHART_HEIGHT - CHART_PAD.top - CHART_PAD.bottom;
  const barW = Math.max(2, innerW / data.length - 2);
  const segs = [
    { key: 'token', v: (d: PolicyStatsTimeseriesRow) => d.skips_token_cooldown, c: '#f59e0b' },
    { key: 'policy', v: (d: PolicyStatsTimeseriesRow) => d.skips_policy_cooldown, c: '#8b5cf6' },
    { key: 'max', v: (d: PolicyStatsTimeseriesRow) => d.skips_max_trades_per_hour, c: '#ec4899' },
    { key: 'entry', v: (d: PolicyStatsTimeseriesRow) => d.skips_entry_filter, c: '#06b6d4' },
    { key: 'score', v: (d: PolicyStatsTimeseriesRow) => d.skips_score_below_threshold, c: '#64748b' },
  ];
  return (
    <div className="analytics-chart-svg-wrap">
      <svg width={width} height={CHART_HEIGHT} className="analytics-chart-svg">
        <line
          x1={CHART_PAD.left}
          y1={CHART_PAD.top + innerH}
          x2={CHART_PAD.left + innerW}
          y2={CHART_PAD.top + innerH}
          stroke="var(--chart-axis, #475569)"
          strokeWidth="1"
        />
        {data.map((d, i) => {
          const x = CHART_PAD.left + (i + 0.5) * (innerW / data.length) - barW / 2;
          let y = CHART_PAD.top + innerH;
          return segs.map(({ key, v, c }) => {
            const val = v(d);
            const h = (val / totalMax) * innerH;
            y -= h;
            return (
              <rect
                key={`${d.bucket_start}-${key}`}
                x={x}
                y={y}
                width={barW}
                height={Math.max(0, h)}
                fill={c}
              />
            );
          });
        })}
      </svg>
      <div className="analytics-chart-legend analytics-chart-legend-stack">
        <span style={{ color: '#f59e0b' }}>Token cooldown</span>
        <span style={{ color: '#8b5cf6' }}>Policy cooldown</span>
        <span style={{ color: '#ec4899' }}>Max trades/hr</span>
        <span style={{ color: '#06b6d4' }}>Entry filter</span>
        <span style={{ color: '#64748b' }}>Score below</span>
      </div>
    </div>
  );
}

function TimeseriesChartOutcomes({ data }: { data: PolicyStatsTimeseriesRow[] }) {
  const maxV = Math.max(1, ...data.map((d) => d.wins + d.losses));
  const width = Math.max(300, data.length * 24);
  const innerW = width - CHART_PAD.left - CHART_PAD.right;
  const innerH = CHART_HEIGHT - CHART_PAD.top - CHART_PAD.bottom;
  const barW = Math.max(2, (innerW / data.length) * 0.4);
  const gap = (innerW / data.length - barW * 2) / 2;
  return (
    <div className="analytics-chart-svg-wrap">
      <svg width={width} height={CHART_HEIGHT} className="analytics-chart-svg">
        <line
          x1={CHART_PAD.left}
          y1={CHART_PAD.top + innerH}
          x2={CHART_PAD.left + innerW}
          y2={CHART_PAD.top + innerH}
          stroke="var(--chart-axis, #475569)"
          strokeWidth="1"
        />
        {data.map((d, i) => {
          const x0 = CHART_PAD.left + (i / data.length) * innerW + gap;
          const yWin = CHART_PAD.top + innerH - (d.wins / maxV) * innerH;
          const yLoss = CHART_PAD.top + innerH - (d.losses / maxV) * innerH;
          return (
            <g key={d.bucket_start}>
              <rect
                x={x0}
                y={yWin}
                width={barW}
                height={Math.max(0, (d.wins / maxV) * innerH)}
                fill="var(--color-success, #22c55e)"
              />
              <rect
                x={x0 + barW}
                y={yLoss}
                width={barW}
                height={Math.max(0, (d.losses / maxV) * innerH)}
                fill="var(--color-error, #ef4444)"
              />
            </g>
          );
        })}
      </svg>
      <div className="analytics-chart-legend">
        <span style={{ color: 'var(--color-success)' }}>■ Wins</span>
        <span style={{ color: 'var(--color-error)' }}>■ Losses</span>
      </div>
    </div>
  );
}

function TimeseriesChartWinRate({ data }: { data: PolicyStatsTimeseriesRow[] }) {
  const WINDOW = 4;
  const winRates: number[] = data.map((_d, i) => {
    let w = 0;
    let t = 0;
    for (let j = Math.max(0, i - WINDOW); j <= Math.min(data.length - 1, i + WINDOW); j++) {
      w += data[j].wins;
      t += data[j].wins + data[j].losses;
    }
    return t > 0 ? (w / t) * 100 : 0;
  });
  const maxPct = 100;
  const width = Math.max(300, data.length * 24);
  const innerW = width - CHART_PAD.left - CHART_PAD.right;
  const innerH = CHART_HEIGHT - CHART_PAD.top - CHART_PAD.bottom;
  const scaleY = (pct: number) => CHART_PAD.top + innerH - (pct / maxPct) * innerH;
  const scaleX = (i: number) =>
    CHART_PAD.left + (i / Math.max(1, data.length - 1)) * innerW;
  const linePoints = winRates.map((pct, i) => `${scaleX(i)},${scaleY(pct)}`).join(' ');
  return (
    <div className="analytics-chart-svg-wrap">
      <svg width={width} height={CHART_HEIGHT} className="analytics-chart-svg">
        <line
          x1={CHART_PAD.left}
          y1={CHART_PAD.top + innerH}
          x2={CHART_PAD.left + innerW}
          y2={CHART_PAD.top + innerH}
          stroke="var(--chart-axis, #475569)"
          strokeWidth="1"
        />
        <line
          x1={CHART_PAD.left}
          y1={scaleY(50)}
          x2={CHART_PAD.left + innerW}
          y2={scaleY(50)}
          stroke="var(--chart-axis, #475569)"
          strokeDasharray="4"
          opacity={0.6}
        />
        <polyline
          fill="none"
          stroke="var(--chart-line-1, #3b82f6)"
          strokeWidth="2"
          points={linePoints}
        />
      </svg>
      <div className="analytics-chart-legend">
        <span>Rolling win % (5-bucket)</span>
      </div>
    </div>
  );
}

function TimeseriesChartQuality({ data }: { data: PolicyStatsTimeseriesRow[] }) {
  const allScores = data.flatMap((d) => [
    d.avg_trade_score,
    d.avg_blocked_trade_score,
  ].filter((x): x is number => x != null && Number.isFinite(x)));
  const maxScore = Math.max(1, ...allScores, 100);
  const minScore = Math.min(0, ...allScores);
  const width = Math.max(300, data.length * 24);
  const innerW = width - CHART_PAD.left - CHART_PAD.right;
  const innerH = CHART_HEIGHT - CHART_PAD.top - CHART_PAD.bottom;
  const scaleY = (v: number) =>
    CHART_PAD.top + innerH - ((v - minScore) / (maxScore - minScore || 1)) * innerH;
  const scaleX = (i: number) =>
    CHART_PAD.left + (i / Math.max(1, data.length - 1)) * innerW;
  const lineExec = data
    .map((d, i) => (d.avg_trade_score != null ? `${scaleX(i)},${scaleY(d.avg_trade_score)}` : null))
    .filter(Boolean) as string[];
  const lineBlocked = data
    .map((d, i) =>
      d.avg_blocked_trade_score != null
        ? `${scaleX(i)},${scaleY(d.avg_blocked_trade_score)}`
        : null
    )
    .filter(Boolean) as string[];
  return (
    <div className="analytics-chart-svg-wrap">
      <svg width={width} height={CHART_HEIGHT} className="analytics-chart-svg">
        <line
          x1={CHART_PAD.left}
          y1={CHART_PAD.top + innerH}
          x2={CHART_PAD.left + innerW}
          y2={CHART_PAD.top + innerH}
          stroke="var(--chart-axis, #475569)"
          strokeWidth="1"
        />
        {lineExec.length > 1 && (
          <polyline
            fill="none"
            stroke="var(--color-success, #22c55e)"
            strokeWidth="2"
            points={lineExec.join(' ')}
          />
        )}
        {lineBlocked.length > 1 && (
          <polyline
            fill="none"
            stroke="var(--color-error, #ef4444)"
            strokeWidth="2"
            strokeDasharray="6"
            points={lineBlocked.join(' ')}
          />
        )}
      </svg>
      <div className="analytics-chart-legend">
        <span style={{ color: 'var(--color-success)' }}>— Executed trade score</span>
        <span style={{ color: 'var(--color-error)' }}>— Blocked trade score</span>
      </div>
    </div>
  );
}

export function AnalyticsTab() {
  const { callTool, error, connected } = useMcpClient();
  const [policyStats, setPolicyStats] = useState<PolicyStatRow[]>([]);
  const [selectedPolicyVersion, setSelectedPolicyVersion] = useState<string>('');
  const [timeseriesRangeIndex, setTimeseriesRangeIndex] = useState(2);
  const [timeseriesData, setTimeseriesData] = useState<PolicyStatsTimeseriesRow[]>([]);
  const [timeseriesLoading, setTimeseriesLoading] = useState(false);

  const fetchPolicyStats = useCallback(async () => {
    try {
      const out = await callTool('analytics_get_policy_stats', {});
      setPolicyStats(Array.isArray(out) ? out : []);
    } catch {
      setPolicyStats([]);
    }
  }, [callTool]);

  useEffect(() => {
    if (!connected) return;
    fetchPolicyStats();
  }, [connected, fetchPolicyStats]);

  useEffect(() => {
    if (policyStats.length > 0 && !selectedPolicyVersion) {
      setSelectedPolicyVersion(policyStats[0].policy_version);
    }
  }, [policyStats, selectedPolicyVersion]);

  const fetchTimeseries = useCallback(
    async (policy_version: string, rangeHours: number) => {
      setTimeseriesLoading(true);
      try {
        const now = Math.floor(Date.now() / 1000);
        const from = now - rangeHours * 3600;
        const to = now;
        const data = (await callTool('get_policy_stats_timeseries', {
          policy_version,
          from,
          to,
        })) as PolicyStatsTimeseriesRow[];
        setTimeseriesData(Array.isArray(data) ? data : []);
      } catch {
        setTimeseriesData([]);
      } finally {
        setTimeseriesLoading(false);
      }
    },
    [callTool]
  );

  useEffect(() => {
    const policy = selectedPolicyVersion || policyStats[0]?.policy_version;
    if (!policy) {
      setTimeseriesData([]);
      return;
    }
    const rangeHours = TIMESERIES_RANGES[timeseriesRangeIndex]?.hours ?? 24;
    fetchTimeseries(policy, rangeHours);
  }, [selectedPolicyVersion, policyStats, timeseriesRangeIndex, fetchTimeseries]);

  const policyOptions = policyStats.map((r) => r.policy_version);

  return (
    <div className="analytics-tab">
      <header className="analytics-header">
        <h2>Analytics</h2>
        <div className="analytics-status">
          {error && <span className="status-error">MCP: {error}</span>}
          {connected && !error && <span className="status-ok">Connected to MCP</span>}
        </div>
      </header>

      <section className="analytics-section">
        <h3>Policy Performance Over Time</h3>
        <div className="analytics-controls">
          <label className="analytics-policy-label">
            Policy:{' '}
            <select
              value={selectedPolicyVersion}
              onChange={(e) => setSelectedPolicyVersion(e.target.value)}
              className="analytics-policy-select"
              disabled={policyOptions.length === 0}
            >
              {policyOptions.length === 0 && (
                <option value="">— No policies —</option>
              )}
              {policyOptions.map((pv) => (
                <option key={pv} value={pv}>
                  {pv}
                </option>
              ))}
            </select>
          </label>
          <div className="analytics-range">
            {TIMESERIES_RANGES.map((r, i) => (
              <button
                key={r.hours}
                type="button"
                className={timeseriesRangeIndex === i ? 'active' : ''}
                onClick={() => setTimeseriesRangeIndex(i)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {timeseriesLoading && (
          <div className="analytics-loading">Loading time-series…</div>
        )}

        {!timeseriesLoading && timeseriesData.length === 0 && (
          <div className="analytics-empty">Not enough historical data yet.</div>
        )}

        {!timeseriesLoading && timeseriesData.length > 0 && (
          <div className="analytics-charts">
            <div className="analytics-chart-block" title="High-confidence opportunities vs actual trades executed.">
              <h4>Opportunity vs Execution</h4>
              <p className="analytics-chart-tooltip">High-confidence opportunities vs actual trades executed.</p>
              <TimeseriesChartOpportunity data={timeseriesData} />
            </div>
            <div className="analytics-chart-block" title="Reasons trades were skipped during this period.">
              <h4>Skip Pressure Breakdown</h4>
              <p className="analytics-chart-tooltip">Reasons trades were skipped during this period.</p>
              <TimeseriesChartSkips data={timeseriesData} />
            </div>
            <div className="analytics-chart-block" title="Completed trades by outcome.">
              <h4>Trade Outcomes</h4>
              <p className="analytics-chart-tooltip">Completed trades by outcome.</p>
              <TimeseriesChartOutcomes data={timeseriesData} />
            </div>
            <div className="analytics-chart-block" title="Rolling win rate over time.">
              <h4>Win Rate (Smoothed)</h4>
              <p className="analytics-chart-tooltip">Rolling win rate over time.</p>
              <TimeseriesChartWinRate data={timeseriesData} />
            </div>
            <div className="analytics-chart-block" title="Average confidence of executed vs skipped trades.">
              <h4>Trade Quality</h4>
              <p className="analytics-chart-tooltip">Average confidence of executed vs skipped trades.</p>
              <TimeseriesChartQuality data={timeseriesData} />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
