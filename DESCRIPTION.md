# Amadeus — Project Description

Amadeus is an **AI-driven trading bot for fresh Solana memecoins**. It discovers pairs from DEXes (Pump.fun, PumpSwap, Raydium), scores them with policy-driven features, and executes paper or live trades via a deterministic, policy-based pipeline. An optional **recommendator agent** analyzes historical data and suggests policy improvements; humans approve before any policy is created or changed.

---

## Goals

- **Automate discovery and scoring** of new Solana pairs from DexScreener.
- **Execute trades** in a deterministic, auditable way: paper first, with optional live Solana execution.
- **Govern behavior by policies**: entry filters, scoring weights, risk (stop loss, take profit, time stop), limits (trades/hour, concurrent, cooldowns), and safety (rug exit, volume collapse, liquidity guards).
- **Separate strategy (policies) from execution (accounts)**: one policy can run on multiple accounts (paper + live wallets) via **deployments**.
- **Support AI-assisted tuning**: recommendations (policy variants, warnings, suggestions) are advisory only; a human must accept before applying.

---

## File Structure

```
amadeus/
├── src/                          # Backend (Node.js, TypeScript)
│   ├── index.ts                  # Entry (MCP server)
│   ├── db.ts                     # PostgreSQL entry (DATABASE_URL); schema in db/schema/postgres-ddl.sql
│   ├── config.ts                 # Env (PORT, RPC, dry-run, etc.)
│   ├── deployment-resolver.ts    # Resolves policy → active (account, deployment) for execution
│   ├── pumpswap-rpc-parser.ts    # Parse PumpSwap create_pool tx from RPC (pool, base/quote mint, migrated flag)
│   ├── recommendations.ts       # createRecommendation() — writes to recommendations table
│   ├── position-sizing.ts        # Risk-based position size
│   ├── sol-price.ts              # SOL/USD for live sizing
│   ├── halts.ts                  # Liquidity halt checks
│   ├── market-mode.ts            # AMM vs bonding curve vs hybrid (per DEX)
│   ├── rug-exit.ts               # Rug protection exit logic
│   ├── rolling-volume-baselines.ts
│   ├── rolling-liquidity-metrics.ts
│   ├── executors/                # Paper and live execution
│   │   ├── index.ts              # Dispatches to paper or chain-specific executor
│   │   ├── paper.ts              # Paper: reserve/release balance in accounts
│   │   ├── solana.ts             # Live Solana: swap via Raydium/PumpSwap/Pump.fun SDKs
│   │   └── types.ts
│   ├── workers/                  # Background pollers (run as separate processes)
│   │   ├── pumpswap-pairs-worker.ts   # WebSocket listener for PumpSwap create_pool; inserts into pairs
│   │   ├── chain-snapshots-worker.ts # Pair snapshots from on-chain only (PumpSwap; price, volume, holders)
│   │   ├── scoring-worker.ts     # Policy-based scoring → pair_scores (signals, eligibility)
│   │   ├── execution-worker.ts   # Entry: scores → trade_decisions (paper/live)
│   │   ├── exit-worker.ts        # Exit: open decisions → close (stop/tp/time/volume/rug)
│   │   ├── policy-analytics-worker.ts     # Roll up events → policy_stats_hourly
│   │   ├── account-balance-worker.ts      # Sync balance_native for live Solana accounts
│   │   └── backtest-worker.ts    # Process queued backtest runs
│   ├── backtesting/
│   │   └── engine.ts             # Deterministic backtest over historical snapshots/scores
│   ├── mcp-server/
│   │   ├── index.ts              # MCP server setup, Streamable HTTP
│   │   ├── routes.ts             # REST + MCP routes; thin wrappers over tools
│   │   ├── schema.ts             # Shared zod schemas
│   │   └── tools/                # MCP tools (and source of truth for “endpoint” logic)
│   │       ├── index.ts          # registerAllTools()
│   │       ├── pairs.ts, snapshots.ts, trades.ts, decisions.ts
│   │       ├── policies.ts, recommendations.ts, backtest.ts
│   │       ├── account.ts, analytics.ts, config.ts, agent.ts, deployments.ts
│   │       └── ...
│   ├── api/                      # External APIs (DexScreener, etc.)
│   ├── types/                    # recommendation, policy, backtest, entry-filter-reject-reasons, etc.
│   ├── validators/
│   └── scripts/
│       └── sell-dust.ts          # Sell dust tokens in Solana wallet (no open position)
├── ui/                           # React app (Vite)
│   └── src/
│       ├── App.tsx               # Tab navigation (Pairs, Snapshots, Scores, Decisions, Trades, Policies, Deployments, Account, Stats, Analytics, Recommendations, Backtests, Agent)
│       ├── components/           # *Tab.tsx + CSS per area
│       └── hooks/useMcpClient.ts  # MCP client for UI
├── agents/
│   ├── recommendator-instruction.txt   # System prompt for the recommendator agent
│   ├── recommending-agent.ts
│   ├── optimizer-agent.ts
│   └── optimizer-instruction.txt
├── policies/
│   ├── policy_format.md          # Full policy schema (entry, scoring, risk, limits, rug, etc.)
│   └── *.md                     # Example policy docs
├── AGENTS.md                     # Rules for AI agents (MCP tools vs routes, SQL named params, thin tools)
├── README.md                     # Setup, workers, MCP, UI, env
└── package.json
```

---

## Architecture Overview

- **Data pipeline**: Pairs (and scraped pairs) → **pair_snapshots** → **pair_scores** (per active policy) → **trade_decisions** (entries) → **trades** (after exit). Execution and exit workers operate per **deployment** (policy + account).
- **Policies** define strategy only (filters, weights, risk, limits). **Accounts** hold balance and account-level risk (drawdown, max open trades). **Policy deployments** link a policy to an account; execution runs each (policy, account) pair.
- **MCP server** exposes tools (and optional REST routes) for the UI and agents. Business logic lives in `src/mcp-server/tools/` and in workers/executors; routes are thin wrappers.
- **Recommendations** are advisory: an agent (or human) creates them; a human accepts/rejects. Accepting a **policy_variant** or **new_policy** can create/update policies and optionally activate them; the bot never auto-applies.

---

## How Recommendations Work

- **Purpose**: Suggest policy improvements (or account-level warnings, or product ideas) without changing anything until a human approves.
- **Types**: `policy_variant` (changes to an existing active policy), `new_policy` (brand-new policy), `warning` (account-level), `suggestion` (features, strategies, data sources).
- **Flow**:
  1. Agent (or human) calls **create_recommendation** with `recommendation_type`, `policy_version` (for variant), `payload`, `rationale`, etc. Stored in `recommendations` with `status = 'pending'`.
  2. Humans review in the UI (Recommendations tab); they can **accept** or **reject** (and optionally **archive**).
  3. **Accept with apply** (for `policy_variant` or `new_policy`): the MCP tool creates or updates the policy and can activate it (and retire the previous active one if desired). `recommendations.applied_policy_version` and `status = 'accepted'` are set.
  4. The recommendator agent is instructed to use DB + DexScreener + codebase to justify suggestions and to **not** call create_recommendation until the user explicitly accepts.
- **Storage**: `recommendations` table: id, policy_version, scope, source, recommendation_type, payload (JSON), confidence, status, rationale, applied_policy_version, archived, etc. See `src/types/recommendation.ts` and `src/mcp-server/tools/recommendations.ts`.

---

## How Policies Work

- **Role**: Policies define **strategy only**: what to trade, how to score it, how to size and when to exit. They do **not** set account balance or account-level risk; those live in **accounts**.
- **Lifecycle**: `draft` → `active` → (optional) `retired`. Only **active** policies are used by the scoring worker and execution worker. One policy can be “active” at a time in practice when using “supersede” on accept; the schema allows multiple active policies.
- **Contents** (see `policies/policy_format.md` and `policies` table in `db.ts`):
  - **Entry filters**: max_pair_age_seconds, min_liquidity_usd, min_volume_1m/5m_usd, min_buy_sell_ratio, max_top_holder_pct, min_holder_count, allowed_dexes, liquidity trend guard, etc.
  - **Scoring weights**: weight_volume_5m, weight_volume_acceleration_1m, weight_price_momentum_5m, etc., and **min_trade_score** / **priority_trade_score**.
  - **Risk**: risk_per_trade_pct, stop_loss_pct, take_profit_pct, time_stop_seconds.
  - **Optional exits**: volume_collapse_exit, rug_exit (liquidity floor, snapshot stale, pair missing).
  - **Limits**: max_trades_per_hour, max_concurrent_trades, cooldown_seconds_after_loss, cooldown_on_consecutive_losses, token reentry cooldowns, max_trades_per_token_per_hour, pair_loss_cooldown, max_consecutive_losses_per_pair.
  - **Safety**: halt_on_liquidity_drop_pct, require_no_mint_authority, require_lp_lock, halt_on_rug_detected, allow_low_confidence_trades.
- **Scoring**: The **scoring worker** loads all active policies, fetches pairs with recent snapshots, applies hard filters and (when enabled) liquidity trend guard, computes weighted feature scores, and writes **pair_scores** with `eligible`, `signal` (NO_TRADE | WATCH | TRADE_CANDIDATE | PRIORITY_TRADE), and feature contributions.
- **Execution**: The **execution worker** reads `pair_scores` with `signal IN ('TRADE_CANDIDATE','PRIORITY_TRADE')`, validates policy + market mode, applies kill switches and limits (per policy and per account), reserves balance from the **account**, and records a **trade_decision** (paper or live). Position size = min(risk-based size, available_balance).

---

## How Accounts Work

- **Purpose**: Accounts represent a **wallet or paper balance** and hold **account-level risk settings**. Execution and exit workers use them for balance and limits.
- **Modes**: **paper** (simulated balance in DB) or **live** (real chain wallet). Live Solana accounts use `address` (wallet public key); balance can be synced by the **account-balance worker** into `balance_native`.
- **Key fields** (in `accounts` table): account_id, mode, chain, address, starting_equity, current_equity, available_balance, max_daily_drawdown_pct, max_total_open_trades, max_total_risk_pct, trading_enabled, is_active, balance_native, balance_last_updated.
- **Balance**: On **entry**, the execution worker reserves `position_size_usd` from `available_balance`. On **exit**, the exit worker updates `current_equity` and `available_balance` (adds back position + realized PnL). Paper executor only touches DB; live executor uses RPC and (optionally) private key from env.
- **Risk**: Account-level checks (e.g. max_daily_drawdown_pct, max_total_open_trades, max_total_risk_pct) are enforced in the execution worker per deployment; policies do not override these.
- **Defaults**: On fresh DB, a default **paper** account (`paper-default`) and a **Solana live** account (`solana-wallet`) are seeded. Active policies get default deployments to both so they can run on paper and (if enabled) live.

---

## Policy Deployments (Accounts × Policies)

- **policy_deployments** links a **policy** to an **account**: (policy_id, account_id, is_active, …). Execution runs per **deployment**: for each active policy it loads active deployments (via `deployment-resolver.ts`), and for each (policy, account) pair it evaluates scored pairs and opens/closes trades for that account.
- **Active** means deployment.is_active = 1, account.is_active = 1, and policy.status = 'active'. The execution worker only opens new trades for deployments that pass these and account-level checks (trading_enabled, drawdown, open count, etc.).
- **UI**: Deployments tab and MCP tools (e.g. list_deployments) allow attaching/detaching policies to accounts and activating/deactivating deployments.

---

## Workers (Summary)

| Worker | Role |
|--------|------|
| **pumpswap-pairs** | WebSocket listener for PumpSwap program; on create_pool fetches tx, parses base/quote, upserts into `pairs` with source `pumpswap_rpc`. |
| **chain-snapshots** | Builds `pair_snapshots` from on-chain data (PumpSwap): price, volume, liquidity, holders, etc. Only snapshot worker. |
| **scoring** | For each active policy, scores pairs from recent snapshots → hard filters + weighted score → `pair_scores` (eligible, signal, feature contributions). |
| **execution** | Reads `pair_scores` (TRADE_CANDIDATE/PRIORITY_TRADE), validates policy + account limits, reserves balance, records **trade_decisions** (paper or live). |
| **exit** | For each open **trade_decision**, evaluates stop loss, take profit, time stop, volume collapse, rug exit; closes trade, updates **accounts**, writes **trades**. |
| **policy-analytics** | Rolls up events (scores, decisions, trades, skips, entry rejections) into **policy_stats_hourly** for Stats UI and agents. |
| **account-balance** | Polls live Solana accounts and updates `balance_native` in `accounts`. |
| **backtest** | Processes **backtest_runs** (queued via MCP/UI): replays historical snapshots/scores with a policy config, writes **backtest_trades** and **backtest_metrics**. |

---

## MCP Server & UI

- **MCP server** (`src/mcp-server/`): Exposes tools for pairs, snapshots, trades, trade_decisions, policies, recommendations, backtests, account, analytics, config, agent, deployments. Implementations live under `tools/`; `routes.ts` exposes HTTP and MCP transport and may add thin REST wrappers that call the same tool logic.
- **UI** (React, Vite): Tabs for Pairs, Snapshots, Scores, Decisions, Trades, Policies, Deployments, Account, Stats, Analytics, Recommendations, Backtests, Agent. It uses the MCP client to call tools and display data.

---

## Backtesting

- **Backtest runs** are enqueued via MCP (`run_policy_backtest`) or UI; **backtest worker** picks queued runs, loads historical `pair_snapshots` and `pair_scores` (or equivalent), and runs the **backtesting engine** with a `PolicyConfig`. The engine replays entry/exit/cooldown logic without live trading and writes **backtest_trades** and **backtest_metrics**. Results are read via MCP/UI.

---

## Key Conventions (from AGENTS.md)

- **MCP “endpoints”** are implemented as **tools** in `src/mcp-server/tools/`; REST routes in `routes.ts` are thin wrappers that call the same exported functions.
- **Tools are thin**: they call existing logic in workers, executors, or services instead of duplicating it.
- **SQL**: Use **named parameters** (e.g. `$accountId`) and a single params object in all `db.prepare(...)` calls.
