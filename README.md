# amadeus

An AI-driven trading bot for fresh Solana memecoins.

## Setup

### Prerequisites

- Node.js v24.13.0 or above 
- npm

### Install

```bash
npm install
```

### Build

```bash
npm run build
```

### Configuration

Copy the example environment file and edit as needed:

```bash
cp .env.example .env
```

Available environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | MCP server port | `3000` |
| `MCP_HTTP_REQUEST_TIMEOUT_MS` | Node HTTP `requestTimeout` for MCP (ms). Default **`0`** (disabled) so long tools are not closed by the server. | `0` |
| `MCP_HTTP_HEADERS_TIMEOUT_MS` | Optional. Node `headersTimeout` (ms). | (Node default) |
| `MCP_HTTP_KEEP_ALIVE_TIMEOUT_MS` | Optional. Node `keepAliveTimeout` (ms). | (Node default) |
| `DATABASE_URL` | **Required.** PostgreSQL connection string (`postgresql://…`). Schema is applied on startup. | — |
| `HELIUS_RPC_URL` | Helius RPC endpoint (required). Used for all Solana RPC: balance sync, execution, chain-snapshots (PumpSwap volume via getTransactionsForAddress), pumpswap-pairs worker. Example: `https://mainnet.helius-rpc.com/?api-key=XXX`. | — |
| `REDIS_URL` | Redis connection URL (required for **pumpswap-vault-swap** worker). Pumpswap-pairs worker publishes new pairs to channel `pairs:new`; vault swap worker subscribes and adds vault watchers for new pairs (no DB polling). Example: `redis://localhost:6379`. | — |
| `SOLANA_PRIVATE_KEY` | Signer for live Solana execution (env only; never in DB or UI). Base58 secret key or JSON array (Phantom-style) of 64 bytes. Required when running live Solana accounts. | — |
| `LIVE_EXECUTION_DRY_RUN` | When `true`, live Solana executor does not send transactions (simulate only). | — |
| `ENABLED_DEXES` | Comma-separated DEX ids for ingestion and snapshots (e.g. `raydium,pumpswap,pumpfun`). When set, the **pumpswap-pairs worker** and **chain-snapshots worker** only process pairs from these DEXes; when unset, all DEXes are allowed. | (all) |

| `UI_PORT` | Port for the UI dev server (Vite). Only used when running `npm run ui`. | `5173` |

| `UI_HOST` | Listen host for the UI dev server. Use `0.0.0.0` to listen on all interfaces (e.g. for LAN access), or `true`/`1` for same. Omit for localhost only. | (localhost) |

| `AGENT_API_URL` | Base URL of the ADK agent API server (e.g. `http://localhost:8000`). Required for the **optimizer agent worker** and the UI Agent tab. The agent API server must be started separately from the `agents` directory with the desired entry point (e.g. `optimizer-agent.ts`). | — |

| `OPTIMIZER_APP_NAME` | App name for the optimizer agent when calling the ADK API (e.g. `optimizer-agent` or `optimizer_agent`). Optional; the optimizer agent worker infers from `/list-apps` if unset. | (from list-apps) |

| `OPTIMIZER_AGENT_INTERVAL_MINUTES` | Interval in minutes between optimizer agent worker runs. Must be between 1 and 1440 (24 hours). | `20` |

| `PAPER_ACCOUNT_EQUITY_USD` | (Unused when using accounts table.) Paper balance is stored in `accounts`; default paper account starts at $100. | — |

The database (SQLite) is created automatically on first run.

## Running everything

`scripts/amadeus.sh` starts the MCP server, every worker, and the UI as background
processes, with a preflight check first. Logs go to `logs/<service>.log`, PIDs to `.run/`.

```bash
npm run up          # dev mode (tsx watch) — MCP + workers + UI
npm run status      # what is running
npm run logs        # tail every service (npm run logs -- scoring for one)
npm run down        # stop everything
```

Or call the script directly for options:

```bash
scripts/amadeus.sh start --prod           # run compiled dist/ (builds if missing)
scripts/amadeus.sh start --no-ui          # headless
scripts/amadeus.sh start --attach         # tail logs; Ctrl+C stops the stack
scripts/amadeus.sh start --with-agent-api # also start the ADK api_server + optimizer worker
```

Preflight verifies the Node version against `.nvmrc`, that `.env` exists with
`DATABASE_URL` / `HELIUS_RPC_URL` / `REDIS_URL` set, that Postgres and Redis are
reachable, that the MCP port is free, and installs missing dependencies. It refuses to
start if any of that fails. When `LIVE_TRADING_ENABLED=true` it prints a loud warning
before starting anything.

Services start in pipeline order — MCP first (it applies the Postgres schema and the UI
talks to it), then ingestion (`pumpswap-pairs`, `pumpswap-vault-swap`), snapshots,
scoring, execution, exit, and the analytics/backtest/balance workers. A service that
dies on startup is reported immediately with the tail of its log rather than failing
silently.

The `optimizer-agent` worker is opt-in (`--with-optimizer`) because it needs
`AGENT_API_URL` and a running ADK api_server; see [Optimizer agent worker](#optimizer-agent-worker).

## Workers

Each worker has a dev mode that runs TypeScript directly and reloads on file changes: `worker:pumpswap-pairs:dev`, `worker:pumpswap-vault-swap:dev`, `worker:chain-snapshots:dev`, `worker:scoring:dev`, `worker:execution:dev`, `worker:exit:dev`, `worker:policy-analytics:dev`, `worker:backtest:dev`, `worker:account-balance:dev`, `worker:optimizer-agent:dev`.

### PumpSwap vault swap worker (Redis pub/sub)

Subscribes to base/quote vault accounts for PumpSwap pairs and writes swap events to `pair_swap_events`. New pairs are discovered via Redis channel `pairs:new` (published by the pumpswap-pairs worker when it inserts a pair); at startup, loads existing pairs from the DB. **Requires `REDIS_URL`.** No DB polling. Run this worker so chain-snapshots (and scoring) have buy/sell event data.

```bash
npm run worker:pumpswap-vault-swap
# or with auto-reload: npm run worker:pumpswap-vault-swap:dev
```

### Chain snapshots worker

Builds `pair_snapshots` from on-chain data only (no DexScreener). **PumpSwap only** for now; Raydium can be added later. Fetches pool reserves via the PumpSwap SDK, mint account for supply and mint/freeze authority, SOL price for USD conversion, and volume/buys/sells via Helius getTransactionsForAddress. Requires `HELIUS_RPC_URL`. Respects `ENABLED_DEXES` (must include `pumpswap` if set). Poll interval is configurable via `SNAPSHOT_POLL_INTERVAL_SEC` (only 15, 30, or 60 seconds; default 60). This is the only snapshot worker; run it so the UI and scoring have snapshot data.

```bash
npm run worker:chain-snapshots
# or with auto-reload: npm run worker:chain-snapshots:dev
```

### Scoring worker

Converts raw pair + snapshot data into normalized trade scores using the active policy. Polls every 30 seconds. Uses the active policy (status = 'active') for hard filters and feature weights. Outputs to `pair_scores` table with eligibility, score, signal (NO_TRADE/WATCH/TRADE_CANDIDATE/PRIORITY_TRADE), and feature contributions for explainability. **PumpSwap** pairs are only scored if they pass the same schedule as chain snapshots (tier, age vs active policies, LP lock vs `require_lp_lock` — see `snapshot-pair-eligibility-sql.ts`); other DEXes still use recent-snapshot discovery only. Requires pumpswap-pairs worker and chain-snapshots worker to run first.

```bash
npm run worker:scoring
# or with auto-reload: npm run worker:scoring:dev
```

### Execution worker

Deterministic, policy-driven execution: reads scored signals (TRADE_CANDIDATE, PRIORITY_TRADE) from `pair_scores`, validates policy match and market mode, applies kill switches and limits, then records paper entries to `trade_decisions`. Balance is read and updated from the `accounts` table (reserve on entry). Position size = min(risk-based size, available_balance); insufficient balance skips the trade. Exits are handled by the exit worker. Paper only; no live prices or real orders.

```bash
npm run worker:execution
# or with auto-reload: npm run worker:execution:dev
```

### Exit worker

Closes open paper trades using policy thresholds and latest snapshot price. For each open `trade_decisions` row, evaluates in order: **stop loss** (exit if PnL % ≤ `stop_loss_pct`), **take profit** (exit if PnL % ≥ `take_profit_pct`), **time stop** (exit if `now - entry_time >= time_stop_seconds`). First condition met closes the trade: computes realized PnL, updates `accounts` (current_equity and available_balance), sets `exit_recorded_at` on the decision, and inserts into `trades` with `exit_reason` (STOP_LOSS | TAKE_PROFIT | TIME_STOP). Missing price for a pair skips that trade for the cycle. Runs every 20 seconds.

```bash
npm run worker:exit
# or with auto-reload: npm run worker:exit:dev
```

### Policy analytics worker

Rolls up raw events (pair_scores, trade_decisions, trades, trade_decision_skips, entry_filter_rejections) into hourly buckets in `policy_stats_hourly` for the Stats UI and agent reasoning. Append/upsert only; idempotent via `policy_analytics_offsets`. Run every 30–60s. Use the MCP tool `get_policy_stats_timeseries` (policy_version, from, to) to read the same data the Stats page uses.

```bash
npm run worker:policy-analytics
# or with auto-reload: npm run worker:policy-analytics:dev
```

### Account balance worker

Polls all **live** Solana accounts and updates `balance_native` (and `balance_last_updated`) in the `accounts` table using the global `HELIUS_RPC_URL`. Paper accounts are skipped. Use this when running live Solana execution so the UI and any balance checks see up-to-date SOL. Polls every 90 seconds. Requires `HELIUS_RPC_URL` to be set; logs a warning at startup if live Solana accounts exist and RPC is missing.

```bash
npm run worker:account-balance
# or with auto-reload: npm run worker:account-balance:dev
```

### Backtest worker

Processes queued backtest runs. Backtests are enqueued via the MCP tool `run_policy_backtest` (from the UI Backtests tab or an agent): the tool inserts a row into `backtest_runs` with `status = 'queued'`. This worker polls for queued runs, marks each as `running`, loads historical `pair_snapshots` and `pair_scores` for the run’s time range, runs the deterministic backtest engine (replay of entry/exit/cooldown logic with no live trading), writes results to `backtest_trades` and `backtest_metrics`, then sets the run to `completed` or `failed`. Read-only with respect to live trading; only writes to `backtest_*` tables. Polls every 5 seconds. Start this worker so that backtests requested in the UI or by agents are executed.

```bash
npm run worker:backtest
# or with auto-reload: npm run worker:backtest:dev
```

### Optimizer agent worker

Calls the **optimizer agent** via the ADK REST API on a configurable interval (default **20 minutes**; set `OPTIMIZER_AGENT_INTERVAL_MINUTES` to override). Each cycle it ensures a session exists (user `default`, session id `optimizer_worker`), sends the message **"run again"**, and logs the agent's text response. The optimizer agent then auto-optimizes active policies that have **Auto Optimize** enabled (SQL analytics, DexScreener/DexTools checks, policy updates or recommendations). **Requires `AGENT_API_URL`.** The agent API server must be running with the optimizer entry point (e.g. from the `agents` directory: `npx adk api_server optimizer-agent.ts`). Optional: set `OPTIMIZER_APP_NAME` to the app name exposed by your API server (e.g. `optimizer-agent` or `optimizer_agent`) if it differs from the default. If the agent API is unreachable or the app name is missing, the worker logs a warning and skips the cycle; on session-not-found it retries by creating the session and running again.

```bash
npm run worker:optimizer-agent
# or with auto-reload: npm run worker:optimizer-agent:dev
```

## Scripts

Scripts in `src/scripts/` are run with `npx tsx src/scripts/<name>.ts` (or after `npm run build`, `node dist/scripts/<name>.js`). One script has npm aliases (see below).

### Sell dust

Sells **dust** tokens in the Solana wallet: any token that has a balance but **no open trade decision** (no open position) for the default Solana account. Resolves pool/DEX from the database first, then DexScreener API for tokens not in the DB. Skips WSOL and tokens that have an open position. Uses a slippage ladder and retries on failure.

**Requirements:** `HELIUS_RPC_URL`, `SOLANA_PRIVATE_KEY`. To send transactions, set `LIVE_TRADING_ENABLED=true` in `.env`.

```bash
# List dust only (no transactions sent)
npm run sell-dust:dev -- --dry-run

# Sell dust (sends real transactions when LIVE_TRADING_ENABLED=true)
npm run sell-dust:dev
```

After building: `npm run sell-dust -- --dry-run` or `npm run sell-dust`.

### Retry sell

Debug script to **retry a PumpSwap (or other DEX) sell** for a specific pair/token. Builds the swap transaction and **simulates by default**; use `--send` to submit. Useful to diagnose sell failures (e.g. insufficient token balance).

**Requirements:** `HELIUS_RPC_URL`. To send: `SOLANA_PRIVATE_KEY` and (if enforced) `LIVE_TRADING_ENABLED=true`.

```bash
# By pair address (token/dex resolved from DB)
npx tsx src/scripts/retry-sell.ts <pair_address>

# By pair_scores id
npx tsx src/scripts/retry-sell.ts --score-id <id>

# With options and send
npx tsx src/scripts/retry-sell.ts <pair_address> --slippage 1000 --usd 0.5 --send

# Pair not in DB: pass token mint (and optionally --dex)
npx tsx src/scripts/retry-sell.ts <pair_address> --token <base_token_mint> --dex pumpswap
```

| Option | Description |
|--------|-------------|
| `--token <mint>` | Token mint (default: from DB) |
| `--dex <dex>` | DEX name (default: pumpswap) |
| `--usd <amount>` | Min expected output USD for slippage (default: 0.1) |
| `--slippage <bps>` | Slippage in basis points (default: 500) |
| `--send` | Send the transaction (default: simulate only) |
| `--score-id <id>` | Resolve pair/token/dex from `pair_scores.id` |

### Retry buy

Debug script to **retry a PumpSwap (or other DEX) buy** for a specific pair/token. Simulates by default; use `--send` to submit.

**Requirements:** Same as retry-sell.

```bash
npx tsx src/scripts/retry-buy.ts <pair_address>
npx tsx src/scripts/retry-buy.ts --score-id <id>
npx tsx src/scripts/retry-buy.ts <pair_address> --usd 0.5 --slippage 1000 --send
npx tsx src/scripts/retry-buy.ts <pair_address> --token <base_token_mint> --dex pumpswap
```

Options: `--token`, `--dex`, `--usd` (position size in USD, default 1.0), `--slippage`, `--send`, `--score-id` (same as retry-sell).

### Debug PumpSwap transaction

One-off debug script to **fetch a Solana transaction by signature** (base64 and jsonParsed), inspect inner instructions, and run the PumpSwap RPC parser. Used to verify how the parser interprets a real tx (e.g. swap direction, pool, amount).

**Requirements:** `HELIUS_RPC_URL`.

```bash
# Use default hardcoded signature
HELIUS_RPC_URL=... npx tsx src/scripts/debug-pumpswap-tx.ts

# Custom signature
npx tsx src/scripts/debug-pumpswap-tx.ts <signature>
```

Output includes inner-instruction layout, normalized PumpSwap inner instructions, and parser result (swaps / pool addresses).

### Clear database

Clears all tables **except** `policies` and `policy_deployments`. Resets the snapshot cursor and re-seeds default accounts (`paper-default`, `solana-wallet`). Use to wipe trades, pairs, snapshots, scores, and other runtime data while keeping policy and deployment config.

**Requirements:** `DATABASE_URL` must point at a PostgreSQL database (create the DB first).

```bash
# Dry run (list tables that would be cleared)
npx tsx src/scripts/clear-db.ts --dry-run

# Run
npx tsx src/scripts/clear-db.ts
```

## MCP Server

The backend exposes tools via the [Model Context Protocol](https://modelcontextprotocol.io/) over Streamable HTTP. The UI uses these MCP tools to fetch data.

**Tools:**
- `list_pairs` – List trading pairs from the database (optional `limit`, `offset`, filters; optional `eligible_for_snapshots` to restrict to the same PumpSwap eligibility as snapshots/vault/scoring workers)
- `list_snapshots` – List recent pair snapshots (optional `limit`, `offset`)
- `get_snapshots_by_ids` – Get snapshots by snapshot IDs
- `list_trades` – List trades from the database (optional `limit`, `offset`)
- `list_trade_decisions` – List trade decisions / paper entries (optional `limit`, `offset`, `open_only`)
- `get_paper_account` – Get paper account (balance, mode). Read-only.
- `reset_paper_account` – Close all open paper trades and reset balance to starting equity
- `list_policies` – List policies (optional `limit`, `offset`, `status`)
- `list_pair_scores` – List pair scores (optional `limit`, `offset`, `signal`, `eligible`)
- `create_policy` – Create a new policy

Start the MCP server (port 3000):

```bash
npm run build   # if you changed server code
npm run mcp
```

For development with auto-reload on file changes:

```bash
npm run mcp:dev
```

Restart the MCP server and refresh the UI after adding or changing tools.

### Timeouts (agents / Cursor)

Timeouts can come from **two** places:

1. **Node HTTP server** — From Node 18 onward, `requestTimeout` defaults to **5 minutes**. Slow tools (heavy DB, RPC) can hit this while the response is still pending. This server sets **`MCP_HTTP_REQUEST_TIMEOUT_MS`** default behavior to **`0`** (disable Node’s request timeout) so long tool calls are not cut off by the server. Override if you want a cap, e.g. `MCP_HTTP_REQUEST_TIMEOUT_MS=600000` (10 minutes).

2. **MCP client (e.g. Cursor)** — The IDE enforces its **own** MCP tool timeout (often shorter than 5 minutes). If the agent still reports timeouts after a successful server response, raise the client limit. In **Settings (JSON)** try:

   - `"mcp.server.timeout": 600000` (10 minutes, milliseconds — exact key may vary by Cursor version)

Restart Cursor after changing IDE settings. See [Cursor forum threads on MCP timeouts](https://forum.cursor.com/) for current keys and defaults.

Optional server env (all milliseconds, `0` = use Node default where not explicitly set):

| Variable | Purpose |
|----------|---------|
| `MCP_HTTP_REQUEST_TIMEOUT_MS` | Node `server.requestTimeout`. Default **unset** → applied as **`0`** (disabled). |
| `MCP_HTTP_HEADERS_TIMEOUT_MS` | Node `server.headersTimeout` (incoming request headers). Only set if you know you need it. |
| `MCP_HTTP_KEEP_ALIVE_TIMEOUT_MS` | Node `server.keepAliveTimeout`. Only set if you know you need it. |

### MCP Inspector

To inspect and test MCP tools (e.g. list tools, call them with custom arguments), run the official MCP inspector. With the MCP server already running (`npm run mcp`), in another terminal:

```bash
npx @modelcontextprotocol/inspector
```

Then point the inspector at your server URL (e.g. `http://localhost:3000/mcp` for Streamable HTTP). You can browse tools and send requests from the inspector UI.

### MCP Toolbox for Databases

[MCP Toolbox for Databases](https://googleapis.github.io/genai-toolbox/getting-started/introduction/) is an open-source MCP server that exposes database tools (e.g. SQLite, PostgreSQL, BigQuery) so agents can run read-only or managed queries, inspect schema, and integrate with your IDE or other MCP clients.

For installation, configuration, and running the server (binary, container, or `npx`), see the official **Getting started** guide:

**https://googleapis.github.io/genai-toolbox/getting-started/introduction/**

```
SQLITE_DATABASE=./data/amadeus.db npx @toolbox-sdk/server --address 0.0.0.0 --ui --prebuilt=sqlite
```

or 

```
SQLITE_DATABASE=./data/amadeus.db toolbox --address 0.0.0.0 --ui --prebuilt=sqlite
```
## UI

The UI is a React app that connects to the MCP server and displays pairs. It uses the MCP client to call tools.

1. Start the MCP server: `npm run mcp`
2. Install UI deps and start dev server: `npm run ui` (or `cd ui && npm install && npm run dev`)
3. Open http://localhost:5173 (or the port you set — see below).

**Port:** The dev server defaults to port **5173**. To use a different port:

- **Environment variable:** set `UI_PORT` (e.g. in `ui/.env` or when invoking: `UI_PORT=3001 npm run ui`).
- **One-off:** from the `ui` directory run `npm run dev -- --port <port>` (e.g. `npm run dev -- --port 3001`).

**Host:** By default the dev server listens on localhost only. To listen on all interfaces (e.g. to access from another device on the LAN), set `UI_HOST=0.0.0.0` or `UI_HOST=true` (e.g. in `ui/.env` or `UI_HOST=0.0.0.0 npm run ui`). From the `ui` directory you can also run `npm run dev -- --host` or `npm run dev -- --host 0.0.0.0`.

The UI proxies `/mcp`, `/api`, and `/stats` to the MCP server in dev. For production, set `MCP_URL` to the MCP server URL.
