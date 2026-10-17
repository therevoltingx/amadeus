
  CREATE TABLE IF NOT EXISTS pairs (
    id SERIAL PRIMARY KEY,
    pair_address TEXT NOT NULL UNIQUE,
    chain TEXT NOT NULL,
    dex TEXT NOT NULL,
    base_token_address TEXT NOT NULL,
    quote_token_address TEXT NOT NULL,
    base_symbol TEXT NOT NULL,
    quote_symbol TEXT NOT NULL,
    base_vault TEXT,
    quote_vault TEXT,
    pair_created_at BIGINT,
    creator_wallet TEXT,
    first_seen_at INTEGER NOT NULL DEFAULT (floor(extract(epoch from now()))::integer),
    tracking_tier TEXT NOT NULL DEFAULT 'ultra_early' CHECK (tracking_tier IN ('ultra_early', 'active', 'dormant')),
    last_active_at INTEGER,
    last_snapshot_at INTEGER,
    method TEXT,
    source TEXT,
    base_decimals INTEGER,
    quote_decimals INTEGER,
    base_has_mint_authority INTEGER,
    base_has_freeze_authority INTEGER,
    base_supply_raw TEXT
  );

  CREATE TABLE IF NOT EXISTS pair_snapshots (
    snapshot_id SERIAL PRIMARY KEY,
    pair_address TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    seconds_since_creation BIGINT,
    token_mint TEXT,
    snapshot_reason TEXT,
    price_usd DOUBLE PRECISION,
    price_change_1m DOUBLE PRECISION,
    price_change_5m DOUBLE PRECISION,
    market_cap DOUBLE PRECISION,
    fdv DOUBLE PRECISION,
    liquidity_usd DOUBLE PRECISION,
    liquidity_change_1m DOUBLE PRECISION,
    lp_locked INTEGER,
    lp_lock_duration INTEGER,
    volume_1m DOUBLE PRECISION,
    volume_5m DOUBLE PRECISION,
    volume_15m DOUBLE PRECISION,
    buys_1m BIGINT,
    sells_1m BIGINT,
    buy_sell_ratio_1m DOUBLE PRECISION,
    total_buys BIGINT,
    total_sells BIGINT,
    buy_sell_ratio DOUBLE PRECISION,
    volume_acceleration_1m DOUBLE PRECISION,
    has_mint_authority INTEGER,
    has_freeze_authority INTEGER,
    can_remove_liquidity INTEGER,
    honeypot_flag INTEGER,
    top_holder_pct DOUBLE PRECISION,
    top_5_holder_pct DOUBLE PRECISION,
    holder_count BIGINT,
    wallet_concentration_score DOUBLE PRECISION,
    rolling_avg_volume_5m DOUBLE PRECISION,
    rolling_avg_volume_30m DOUBLE PRECISION,
    rolling_avg_volume_1h DOUBLE PRECISION,
    rolling_volume_sample_count BIGINT,
    rolling_avg_liquidity_30m DOUBLE PRECISION,
    rolling_avg_liquidity_1h DOUBLE PRECISION,
    liquidity_change_pct_30m DOUBLE PRECISION,
    liquidity_change_pct_1h DOUBLE PRECISION,
    liquidity_sample_count BIGINT,
    method TEXT,
    source TEXT,
    total_volume DOUBLE PRECISION,
    total_transactions BIGINT,
    transactions_1m BIGINT,
    buy_pressure_1m DOUBLE PRECISION,
    sell_pressure_1m DOUBLE PRECISION,
    velocity_score_1m DOUBLE PRECISION,
    sell_volume_1m DOUBLE PRECISION,
    sell_volume_5m DOUBLE PRECISION,
    sell_volume_15m DOUBLE PRECISION,
    buy_volume_1m DOUBLE PRECISION,
    buy_volume_5m DOUBLE PRECISION,
    buy_volume_15m DOUBLE PRECISION
  );

CREATE INDEX IF NOT EXISTS idx_pair_snapshots_pair_address ON pair_snapshots(pair_address);

CREATE INDEX IF NOT EXISTS idx_pair_snapshots_timestamp ON pair_snapshots(timestamp);

CREATE INDEX IF NOT EXISTS idx_pair_snapshots_pair_timestamp ON pair_snapshots(pair_address, timestamp);

CREATE INDEX IF NOT EXISTS idx_pair_snapshots_token_mint ON pair_snapshots(token_mint);

CREATE INDEX IF NOT EXISTS idx_pair_snapshots_reason ON pair_snapshots(pair_address, snapshot_reason);

  CREATE TABLE IF NOT EXISTS pair_swap_events (
    id SERIAL PRIMARY KEY,
    pair_address TEXT NOT NULL,
    slot BIGINT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('buy', 'sell')),
    base_delta TEXT NOT NULL,
    quote_delta TEXT NOT NULL,
    created_at BIGINT NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_swaps_pair_time ON pair_swap_events(pair_address, created_at);

CREATE INDEX IF NOT EXISTS idx_swaps_pair_slot ON pair_swap_events(pair_address, slot);

  CREATE TABLE IF NOT EXISTS snapshot_cursors (
    name TEXT PRIMARY KEY,
    last_swap_id INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pair_volume_rollup (
    pair_address TEXT PRIMARY KEY,
    buy_volume_sol DOUBLE PRECISION NOT NULL DEFAULT 0,
    sell_volume_sol DOUBLE PRECISION NOT NULL DEFAULT 0,
    total_volume_sol DOUBLE PRECISION NOT NULL DEFAULT 0,
    buy_count INTEGER NOT NULL DEFAULT 0,
    sell_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS trades (
    trade_id SERIAL PRIMARY KEY,
    pair_address TEXT NOT NULL,
    token_mint TEXT,
    entry_pair_address TEXT,
    entry_dex TEXT,
    policy_version TEXT NOT NULL,
    entry_snapshot_id INTEGER,
    entry_score_id INTEGER,
    exit_snapshot_id INTEGER,
    entry_time INTEGER NOT NULL,
    exit_time INTEGER NOT NULL,
    entry_price DOUBLE PRECISION NOT NULL,
    exit_price DOUBLE PRECISION NOT NULL,
    position_size_usd DOUBLE PRECISION NOT NULL,
    slippage_assumed_pct DOUBLE PRECISION,
    exit_reason TEXT,
    pnl_pct DOUBLE PRECISION,
    max_drawdown_pct DOUBLE PRECISION,
    ai_score_at_entry DOUBLE PRECISION,
    last_volume_ratio DOUBLE PRECISION,
    risk_pct_at_entry DOUBLE PRECISION,
    score_size_multiplier DOUBLE PRECISION,
    is_forced_exit INTEGER NOT NULL DEFAULT 0,
    exit_metadata TEXT,
    exit_liquidity_usd DOUBLE PRECISION,
    snapshot_age_at_exit DOUBLE PRECISION,
    account_id TEXT,
    deployment_id TEXT,
    execution_mode TEXT,
    chain TEXT,
    tx_signature TEXT,
    execution_status TEXT,
    actual_entry_price DOUBLE PRECISION,
    slippage_bps_realized INTEGER,
    execution_latency_ms INTEGER,
    exit_tx_signature TEXT,
    actual_usd_bought DOUBLE PRECISION,
    actual_usd_sold DOUBLE PRECISION,
    sol_received DOUBLE PRECISION,
    sol_price_used DOUBLE PRECISION,
    sol_price_at_entry DOUBLE PRECISION,
    actual_exit_price DOUBLE PRECISION,
    entry_slippage_bps_used INTEGER,
    exit_slippage_bps_used INTEGER,
    tokens_received DOUBLE PRECISION,
    tokens_sold DOUBLE PRECISION,
    fee_lamports INTEGER,
    FOREIGN KEY (pair_address) REFERENCES pairs(pair_address),
    FOREIGN KEY (entry_snapshot_id) REFERENCES pair_snapshots(snapshot_id),
    FOREIGN KEY (exit_snapshot_id) REFERENCES pair_snapshots(snapshot_id)
  );

CREATE INDEX IF NOT EXISTS idx_trades_pair_address ON trades(pair_address);

CREATE INDEX IF NOT EXISTS idx_trades_entry_time ON trades(entry_time);

CREATE INDEX IF NOT EXISTS idx_trades_exit_time ON trades(exit_time);

CREATE INDEX IF NOT EXISTS idx_trades_policy_version ON trades(policy_version);

CREATE INDEX IF NOT EXISTS idx_trades_token_mint ON trades(token_mint);

CREATE INDEX IF NOT EXISTS idx_trades_account_id ON trades(account_id);

  CREATE TABLE IF NOT EXISTS policies (
    policy_id SERIAL PRIMARY KEY,
    policy_version TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'retired')),
    created_at INTEGER NOT NULL DEFAULT (floor(extract(epoch from now()))::integer),
    updated_at INTEGER,
    activated_at INTEGER,
    retired_at INTEGER,
    retired_reason TEXT,
    created_by TEXT NOT NULL CHECK (created_by IN ('agent', 'human', 'system')),
    parent_policy_version TEXT,
    notes TEXT,
    changelog TEXT,
    created_from_policy_version TEXT,
    source_recommendation_id INTEGER,
    change_reason TEXT,
    max_pair_age_seconds INTEGER,
    min_liquidity_usd DOUBLE PRECISION,
    min_volume_1m_usd DOUBLE PRECISION,
    min_price_change_1m_pct DOUBLE PRECISION,
    min_volume_5m_usd DOUBLE PRECISION,
    min_buy_sell_ratio DOUBLE PRECISION,
    min_transactions_1m INTEGER,
    min_velocity_score_1m DOUBLE PRECISION,
    min_buy_pressure_1m DOUBLE PRECISION,
    min_buy_volume_1m_usd DOUBLE PRECISION,
    min_sell_volume_1m_usd DOUBLE PRECISION,
    require_no_mint_authority INTEGER,
    require_no_freeze_authority INTEGER,
    require_lp_lock INTEGER,
    max_top_holder_pct DOUBLE PRECISION,
    min_holder_count INTEGER,
    allowed_dexes TEXT CHECK (allowed_dexes IS NULL OR allowed_dexes IN ('raydium', 'orca', 'pumpswap', 'pumpfun', 'raydium,orca', 'raydium,pumpswap', 'raydium,pumpfun', 'orca,pumpswap', 'orca,pumpfun', 'pumpswap,pumpfun', 'raydium,orca,pumpswap', 'raydium,orca,pumpfun', 'raydium,pumpswap,pumpfun', 'orca,pumpswap,pumpfun', 'raydium,orca,pumpswap,pumpfun')),
    weight_liquidity_velocity DOUBLE PRECISION,
    weight_liquidity_absolute DOUBLE PRECISION,
    weight_volume_1m DOUBLE PRECISION,
    weight_volume_5m DOUBLE PRECISION,
    weight_volume_acceleration_1m DOUBLE PRECISION,
    weight_price_volatility_5m DOUBLE PRECISION,
    weight_market_cap DOUBLE PRECISION,
    weight_buy_sell_slope_1m DOUBLE PRECISION,
    weight_velocity_score_1m DOUBLE PRECISION,
    weight_buy_pressure_1m DOUBLE PRECISION,
    weight_sell_pressure_1m DOUBLE PRECISION,
    weight_buy_volume_1m DOUBLE PRECISION,
    weight_sell_volume_1m DOUBLE PRECISION,
    weight_price_momentum_5m DOUBLE PRECISION,
    weight_holder_growth DOUBLE PRECISION,
    weight_holder_concentration_penalty DOUBLE PRECISION,
    weight_time_since_launch DOUBLE PRECISION,
    weight_pair_age_seconds DOUBLE PRECISION,
    min_trade_score DOUBLE PRECISION,
    priority_trade_score DOUBLE PRECISION,
    max_trades_per_hour INTEGER,
    max_concurrent_trades INTEGER,
    cooldown_seconds_after_loss INTEGER,
    risk_per_trade_pct DOUBLE PRECISION,
    stop_loss_pct DOUBLE PRECISION,
    take_profit_pct DOUBLE PRECISION,
    time_stop_seconds INTEGER,
    halt_on_liquidity_drop_pct DOUBLE PRECISION,
    halt_on_consecutive_losses INTEGER,
    halt_on_rug_detected INTEGER,
    allow_low_confidence_trades INTEGER,
    pair_loss_cooldown_minutes DOUBLE PRECISION,
    pair_loss_cooldown_seconds INTEGER,
    max_consecutive_losses_per_pair INTEGER,
    token_reentry_cooldown_seconds INTEGER,
    max_trades_per_token_per_hour INTEGER,
    cooldown_on_consecutive_losses INTEGER,
    cooldown_on_consecutive_losses_seconds INTEGER,
    token_reentry_cooldown_seconds_after_win INTEGER,
    volume_collapse_exit_enabled INTEGER,
    volume_collapse_ratio_threshold DOUBLE PRECISION,
    volume_collapse_consecutive_checks INTEGER,
    volume_collapse_min_samples INTEGER,
    min_token_age_seconds INTEGER,
    liquidity_trend_guard_enabled INTEGER,
    max_liquidity_drop_pct_30m DOUBLE PRECISION,
    max_liquidity_drop_pct_1h DOUBLE PRECISION,
    liquidity_trend_min_samples INTEGER,
    archived INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER,
    linked_policy_id INTEGER REFERENCES policies(policy_id),
    rug_exit_enabled INTEGER NOT NULL DEFAULT 1,
    rug_liquidity_floor_usd DOUBLE PRECISION,
    rug_snapshot_stale_seconds INTEGER,
    rug_pair_missing_threshold INTEGER DEFAULT 3,
    auto_optimize INTEGER NOT NULL DEFAULT 0
  );

CREATE INDEX IF NOT EXISTS idx_policies_status ON policies(status);

CREATE INDEX IF NOT EXISTS idx_policies_created_at ON policies(created_at);

  CREATE TABLE IF NOT EXISTS pair_scores (
    id SERIAL PRIMARY KEY,
    pair_address TEXT NOT NULL,
    chain TEXT NOT NULL DEFAULT 'solana',
    scored_at INTEGER NOT NULL,
    policy_version TEXT NOT NULL,
    eligible INTEGER NOT NULL,
    reject_reason TEXT,
    reject_stage TEXT CHECK (reject_stage IS NULL OR reject_stage IN ('hard_filter', 'feature_missing', 'manual_block')),
    total_score DOUBLE PRECISION,
    score_normalized DOUBLE PRECISION,
    signal TEXT CHECK (signal IN ('NO_TRADE', 'WATCH', 'TRADE_CANDIDATE', 'PRIORITY_TRADE')),
    confidence_level TEXT CHECK (confidence_level IN ('LOW', 'MEDIUM', 'HIGH')),
    market_mode TEXT CHECK (market_mode IS NULL OR market_mode IN ('amm', 'bonding_curve', 'hybrid', 'orderbook')),
    feature_values TEXT,
    feature_weights TEXT,
    feature_contributions TEXT,
    penalty_contributions TEXT,
    snapshot_ids TEXT,
    snapshot_window_seconds INTEGER,
    missing_feature_count INTEGER,
    missing_features TEXT,
    used_fallback_values INTEGER,
    data_quality_score DOUBLE PRECISION,
    worker_version TEXT,
    run_id TEXT,
    notes TEXT
  );

CREATE INDEX IF NOT EXISTS idx_pair_scores_pair_scored ON pair_scores(pair_address, scored_at);

CREATE INDEX IF NOT EXISTS idx_pair_scores_policy_version ON pair_scores(policy_version);

CREATE INDEX IF NOT EXISTS idx_pair_scores_signal ON pair_scores(signal);

CREATE INDEX IF NOT EXISTS idx_pair_scores_eligible ON pair_scores(eligible);

  CREATE TABLE IF NOT EXISTS trade_decisions (
    trade_id SERIAL PRIMARY KEY,
    pair_address TEXT NOT NULL,
    token_mint TEXT,
    entry_dex TEXT,
    policy_version TEXT NOT NULL,
    market_mode TEXT NOT NULL,
    signal TEXT NOT NULL CHECK (signal IN ('TRADE_CANDIDATE', 'PRIORITY_TRADE')),
    entry_price DOUBLE PRECISION NOT NULL,
    position_size_usd DOUBLE PRECISION NOT NULL,
    executed_at INTEGER NOT NULL,
    reason TEXT,
    execution_mode TEXT NOT NULL DEFAULT 'paper',
    entry_snapshot_id INTEGER,
    entry_score_id INTEGER,
    exit_recorded_at INTEGER,
    consecutive_volume_collapse_count INTEGER NOT NULL DEFAULT 0,
    last_volume_ratio DOUBLE PRECISION,
    risk_pct_at_entry DOUBLE PRECISION,
    score_size_multiplier DOUBLE PRECISION,
    pair_missing_failures INTEGER NOT NULL DEFAULT 0,
    last_snapshot_timestamp INTEGER,
    account_id TEXT,
    deployment_id TEXT,
    chain TEXT,
    tx_signature TEXT,
    execution_status TEXT,
    execution_error TEXT,
    actual_entry_price DOUBLE PRECISION,
    actual_position_size_usd DOUBLE PRECISION,
    slippage_bps_realized INTEGER,
    execution_latency_ms INTEGER,
    submit_timestamp INTEGER,
    confirmed_slot INTEGER,
    sol_price_at_entry DOUBLE PRECISION,
    entry_slippage_bps_used INTEGER,
    tokens_received DOUBLE PRECISION,
    actual_usd_bought DOUBLE PRECISION,
    FOREIGN KEY (pair_address) REFERENCES pairs(pair_address),
    FOREIGN KEY (entry_snapshot_id) REFERENCES pair_snapshots(snapshot_id)
  );

CREATE INDEX IF NOT EXISTS idx_trade_decisions_pair ON trade_decisions(pair_address);

CREATE INDEX IF NOT EXISTS idx_trade_decisions_executed ON trade_decisions(executed_at);

CREATE INDEX IF NOT EXISTS idx_trade_decisions_open ON trade_decisions(exit_recorded_at) WHERE exit_recorded_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_trade_decisions_account_id ON trade_decisions(account_id);

  CREATE TABLE IF NOT EXISTS pair_policy_stats (
    pair_address TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    last_loss_at INTEGER,
    consecutive_losses INTEGER NOT NULL DEFAULT 0,
    last_exit_reason TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (pair_address, policy_version)
  );

CREATE INDEX IF NOT EXISTS idx_pair_policy_stats_updated ON pair_policy_stats(updated_at);

  CREATE TABLE IF NOT EXISTS token_policy_stats (
    token_mint TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    last_loss_at INTEGER,
    consecutive_losses INTEGER NOT NULL DEFAULT 0,
    last_exit_reason TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (token_mint, policy_version)
  );

CREATE INDEX IF NOT EXISTS idx_token_policy_stats_updated ON token_policy_stats(updated_at);

  CREATE TABLE IF NOT EXISTS token_policy_execution (
    token_mint TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    last_exit_at INTEGER,
    last_trade_outcome TEXT,
    trades_in_window INTEGER NOT NULL DEFAULT 0,
    window_start INTEGER,
    updated_at INTEGER,
    PRIMARY KEY (token_mint, policy_version)
  );

  CREATE TABLE IF NOT EXISTS trade_decision_skips (
    id SERIAL PRIMARY KEY,
    pair_address TEXT NOT NULL,
    policy_version TEXT NOT NULL,
    token_mint TEXT,
    reason TEXT NOT NULL,
    decided_at INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_trade_decision_skips_decided ON trade_decision_skips(decided_at);

CREATE INDEX IF NOT EXISTS idx_trade_decision_skips_reason ON trade_decision_skips(reason);

  CREATE TABLE IF NOT EXISTS policy_execution_state (
    policy_version TEXT PRIMARY KEY,
    last_blocked_at INTEGER,
    policy_cooldown_until INTEGER,
    consecutive_loss_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS entry_filter_rejections (
    id SERIAL PRIMARY KEY,
    policy_version TEXT NOT NULL,
    pair_address TEXT NOT NULL,
    token_mint TEXT,
    sub_reason TEXT NOT NULL,
    observed_value DOUBLE PRECISION,
    threshold_value DOUBLE PRECISION,
    decided_at INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_entry_filter_rejections_decided ON entry_filter_rejections(decided_at);

CREATE INDEX IF NOT EXISTS idx_entry_filter_rejections_policy ON entry_filter_rejections(policy_version);

  CREATE TABLE IF NOT EXISTS policy_deployments (
    id TEXT PRIMARY KEY,
    policy_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER,
    UNIQUE(policy_id, account_id)
  );

CREATE INDEX IF NOT EXISTS idx_policy_deployments_policy ON policy_deployments(policy_id);

CREATE INDEX IF NOT EXISTS idx_policy_deployments_account ON policy_deployments(account_id);

CREATE INDEX IF NOT EXISTS idx_policy_deployments_active ON policy_deployments(is_active);

CREATE INDEX IF NOT EXISTS idx_policy_deployments_archived ON policy_deployments(archived);

  CREATE TABLE IF NOT EXISTS accounts (
    account_id TEXT PRIMARY KEY,
    mode TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
    chain TEXT,
    address TEXT,
    name TEXT,
    starting_equity DOUBLE PRECISION NOT NULL,
    current_equity DOUBLE PRECISION NOT NULL,
    available_balance DOUBLE PRECISION NOT NULL,
    max_daily_drawdown_pct DOUBLE PRECISION,
    max_total_open_trades INTEGER,
    max_total_risk_pct DOUBLE PRECISION DEFAULT 15,
    trading_enabled INTEGER NOT NULL DEFAULT 1,
    is_active INTEGER NOT NULL DEFAULT 1,
    is_default INTEGER NOT NULL DEFAULT 0,
    balance_native DOUBLE PRECISION,
    balance_last_updated INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_accounts_mode_chain ON accounts(mode, chain);

  CREATE TABLE IF NOT EXISTS policy_stats_hourly (
    bucket_start INTEGER NOT NULL,
    policy_version TEXT NOT NULL,
    scores_above_min INTEGER DEFAULT 0,
    scores_above_priority INTEGER DEFAULT 0,
    entry_filters_passed INTEGER DEFAULT 0,
    trades_opened INTEGER DEFAULT 0,
    trades_closed INTEGER DEFAULT 0,
    wins INTEGER DEFAULT 0,
    losses INTEGER DEFAULT 0,
    skips_token_cooldown INTEGER DEFAULT 0,
    skips_policy_cooldown INTEGER DEFAULT 0,
    skips_max_trades_per_hour INTEGER DEFAULT 0,
    skips_entry_filter INTEGER DEFAULT 0,
    skips_score_below_threshold INTEGER DEFAULT 0,
    sum_trade_score DOUBLE PRECISION DEFAULT 0,
    count_trade_score INTEGER DEFAULT 0,
    sum_blocked_trade_score DOUBLE PRECISION DEFAULT 0,
    count_blocked_trade_score INTEGER DEFAULT 0,
    PRIMARY KEY (bucket_start, policy_version)
  );

CREATE INDEX IF NOT EXISTS idx_policy_stats_hourly_policy ON policy_stats_hourly(policy_version);

CREATE INDEX IF NOT EXISTS idx_policy_stats_hourly_bucket ON policy_stats_hourly(bucket_start);

  CREATE TABLE IF NOT EXISTS policy_analytics_offsets (
    source_table TEXT PRIMARY KEY,
    last_processed_id INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS recommendations (
    id SERIAL PRIMARY KEY,
    policy_version TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('policy', 'account', 'global')),
    source TEXT NOT NULL CHECK (source IN ('agent', 'human', 'system')),
    source_id TEXT,
    recommendation_type TEXT NOT NULL CHECK (recommendation_type IN ('policy_variant', 'new_policy', 'warning', 'suggestion')),
    payload TEXT NOT NULL,
    confidence DOUBLE PRECISION,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')) DEFAULT 'pending',
    rationale TEXT,
    changelog TEXT,
    name TEXT,
    created_at INTEGER NOT NULL DEFAULT (floor(extract(epoch from now()))::integer),
    applied_policy_version TEXT,
    archived INTEGER NOT NULL DEFAULT 0,
    archived_at INTEGER
  );

CREATE INDEX IF NOT EXISTS idx_recommendations_policy ON recommendations(policy_version);

CREATE INDEX IF NOT EXISTS idx_recommendations_status ON recommendations(status);

CREATE INDEX IF NOT EXISTS idx_recommendations_created ON recommendations(created_at);

CREATE INDEX IF NOT EXISTS idx_recommendations_archived ON recommendations(archived);

  CREATE TABLE IF NOT EXISTS backtest_runs (
    id SERIAL PRIMARY KEY,
    label TEXT,
    source TEXT NOT NULL CHECK (source IN ('human', 'agent')),
    source_id TEXT,
    policy_version TEXT,
    policy_config TEXT,
    start_time INTEGER NOT NULL,
    end_time INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  );

CREATE INDEX IF NOT EXISTS idx_backtest_runs_status ON backtest_runs(status);

CREATE INDEX IF NOT EXISTS idx_backtest_runs_created ON backtest_runs(created_at);

  CREATE TABLE IF NOT EXISTS backtest_trades (
    id SERIAL PRIMARY KEY,
    backtest_run_id INTEGER NOT NULL,
    pair_address TEXT,
    entry_time INTEGER,
    exit_time INTEGER,
    entry_price DOUBLE PRECISION,
    exit_price DOUBLE PRECISION,
    result TEXT CHECK (result IN ('win', 'loss')),
    exit_reason TEXT,
    pnl DOUBLE PRECISION,
    hold_time_seconds INTEGER,
    last_volume_ratio DOUBLE PRECISION
  );

CREATE INDEX IF NOT EXISTS idx_backtest_trades_run ON backtest_trades(backtest_run_id);

  CREATE TABLE IF NOT EXISTS backtest_metrics (
    backtest_run_id INTEGER PRIMARY KEY,
    trades INTEGER,
    wins INTEGER,
    losses INTEGER,
    win_rate DOUBLE PRECISION,
    avg_pnl DOUBLE PRECISION,
    max_drawdown DOUBLE PRECISION,
    avg_hold_time_seconds DOUBLE PRECISION,
    entry_diagnostics_summary TEXT
  );

  CREATE TABLE IF NOT EXISTS backtest_entry_diagnostics (
    id SERIAL PRIMARY KEY,
    backtest_run_id INTEGER NOT NULL,
    pair_address TEXT,
    timestamp INTEGER,
    allowed INTEGER NOT NULL,
    failed_checks TEXT NOT NULL,
    score DOUBLE PRECISION,
    policy_version TEXT
  );

CREATE INDEX IF NOT EXISTS idx_backtest_entry_diagnostics_run ON backtest_entry_diagnostics(backtest_run_id);

CREATE INDEX IF NOT EXISTS idx_backtest_entry_diagnostics_timestamp ON backtest_entry_diagnostics(timestamp);

CREATE INDEX IF NOT EXISTS idx_backtest_entry_diagnostics_pair ON backtest_entry_diagnostics(pair_address);
