# Amadeus

An AI-driven trading bot for fresh Solana memecoins. It discovers new pairs from
on-chain data, scores them against declarative policies, and executes paper or live
trades through a deterministic pipeline — with backtesting, per-policy analytics, and
optional LLM agents that propose strategy changes for human review.

Node.js 24 · TypeScript · PostgreSQL · Redis · React · [MCP](https://modelcontextprotocol.io/)

---

## ⚠️ Read this first

**This software places real trades with real money. It can and will lose funds.**

- **Experimental and unaudited.** Written for one person's use, published as-is. There
  is no warranty of any kind, and no guarantee it does what this README claims.
- **Memecoin trading is close to worst-case.** Tokens minted minutes ago, thin
  liquidity, rug pulls, honeypots, and sandwich attacks are the normal operating
  environment, not edge cases. Most strategies lose money net of fees and slippage.
- **Not financial advice.** Nothing here is a recommendation to trade anything. You are
  solely responsible for any funds you put at risk and for complying with the law
  wherever you are.
- **Live trading is off by default** and stays off until you set two separate
  environment variables. Start on paper. Then backtest. Then paper again.
- **It needs your private key** to sign transactions. Read [Security](#security) before
  you put a key anywhere near this.

If you are looking for a turnkey profitable bot, this is not that. It is a framework for
expressing and testing strategies, where the strategy is yours and so is the outcome.

---

## Contents

- [How it works](#how-it-works)
- [Quickstart](#quickstart)
- [Configuration](#configuration)
- [Running the stack](#running-the-stack)
- [Workers](#workers)
- [Policies, accounts, deployments](#policies-accounts-deployments)
- [Security](#security)
- [Known limitations](#known-limitations)
- [MCP server](#mcp-server)
- [UI](#ui)
- [Operational scripts](#operational-scripts)
- [Development](#development)
- [License](#license)

---

## How it works

Data flows one way through a chain of independent workers, each reading what the
previous one wrote to Postgres:

```
  pumpswap-pairs ──────────> pairs              new pools, from a program log subscription
  pumpswap-vault-swap ─────> pair_swap_events   buys/sells, from vault account subscriptions
  chain-snapshots ─────────> pair_snapshots     price, liquidity, volume, holders, authorities
  scoring ─────────────────> pair_scores        policy filters + weighted features -> a signal
  execution ───────────────> trade_decisions    entries, after risk and limit checks
  exit ────────────────────> trades             closes on stop / target / time / rug / collapse
```

Alongside that: `policy-analytics` rolls events into hourly buckets, `backtest` replays
history against a policy, and `account-balance` keeps live wallet balances fresh.

Everything observable is a table, so every decision is auditable after the fact — why a
pair was rejected, which filter it missed by how much, what the score decomposed into.

**Discovery is push, not poll.** New pools arrive over a WebSocket subscription to the
PumpSwap program rather than by scraping an API, and the pairs worker publishes them to
Redis (`pairs:new`) so the swap-event worker can subscribe to a brand-new pool's vaults
within seconds of its creation. For tokens whose entire life is measured in minutes,
that latency is the product.

A deeper design walkthrough lives in [DESCRIPTION.md](DESCRIPTION.md).

---

## Quickstart

### Prerequisites

| | |
|---|---|
| **Node.js 24.13.0+** | see [`.nvmrc`](.nvmrc) — `nvm use` |
| **PostgreSQL** | the schema is applied automatically on first run |
| **Redis** | used for pair-discovery pub/sub between workers |
| **A Helius API key** | [helius.dev](https://helius.dev) — the only supported Solana RPC provider |

### Install and run

```bash
git clone https://github.com/therevoltingx/amadeus.git
cd amadeus
nvm use
npm install

createdb amadeus                      # or point DATABASE_URL at an existing database
cp .env.example .env                  # then fill in the three required variables
npm run up                            # starts the MCP server, every worker, and the UI
```

Then open <http://localhost:5173>.

`npm run up` runs a preflight first and refuses to start on a broken setup — wrong Node
version, missing `.env`, unreachable Postgres or Redis, occupied port. It installs
missing dependencies once the configuration checks out.

```bash
npm run status      # what is running
npm run logs        # tail everything (npm run logs -- scoring for one service)
npm run down        # stop everything
```

Nothing trades live until you deliberately enable it. Out of the box you get a paper
account seeded with $100 and a full pipeline writing real market data against it.

---

## Configuration

All configuration is environment variables, read from `.env` in the project root. See
[`.env.example`](.env.example) for a commented template.

### Required

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. The schema in [`src/db/schema/postgres-ddl.sql`](src/db/schema/postgres-ddl.sql) is applied on startup. Managed providers usually need `?sslmode=require`. |
| `HELIUS_RPC_URL` | Helius RPC endpoint, e.g. `https://mainnet.helius-rpc.com/?api-key=YOUR_KEY`. Used for all Solana RPC: discovery, snapshots, execution, balances. |
| `REDIS_URL` | e.g. `redis://localhost:6379`. Carries the `pairs:new` channel between the pairs and vault-swap workers. |

### Live trading

Both of these are off unless you set them. They are the only things standing between a
paper run and real transactions.

| Variable | Default | Description |
|---|---|---|
| `LIVE_TRADING_ENABLED` | `false` | **Master kill switch.** Must be exactly `true` or no live order is ever submitted, regardless of account configuration. |
| `SOLANA_PRIVATE_KEY` | — | Signer for live execution. Base58 secret key, or a Phantom-style JSON array of 64 bytes. Read from the environment only — never stored in the database or exposed through the UI or MCP. |
| `LIVE_EXECUTION_DRY_RUN` | `false` | When `true`, the live executor builds and simulates transactions but does not send them. Use this for your first live-configured run. |

### Server and UI

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | MCP server port. |
| `MCP_BIND_ADDRESS` | `127.0.0.1` | Interface the MCP server binds to. Loopback by default — see [Security](#security) before changing it. |
| `MCP_ALLOWED_ORIGINS` | — | Comma-separated CORS allowlist for the MCP server. |
| `UI_PORT` | `5173` | Vite dev server port. |
| `UI_HOST` | localhost | Set `0.0.0.0` to expose the UI on your LAN. |
| `MCP_URL` / `MCP_SERVER_URL` | `http://localhost:3000` | Where the UI and agents reach the MCP server. |

### Pipeline tuning

| Variable | Default | Description |
|---|---|---|
| `ENABLED_DEXES` | all | Comma-separated DEX ids for ingestion and snapshots, e.g. `raydium,pumpswap,pumpfun`. |
| `SNAPSHOT_POLL_INTERVAL_SEC` | `60` | Seconds between snapshot cycles. Only `15`, `30`, or `60`. |
| `SNAPSHOT_BATCH_SIZE` | — | Pairs per snapshot batch. Raise with care; it multiplies RPC load. |
| `SNAPSHOT_BATCH_DELAY_MS` | — | Delay between snapshot batches, to stay under RPC rate limits. |
| `PUMPSWAP_VAULT_ELIGIBILITY_POLL_SEC` | — | How often the vault-swap worker re-checks which pairs are eligible. |
| `COALESCE_WINDOW_MS` | — | Window for coalescing vault swap events. |
| `CHAINLINK_SOL_USD_FEED_ADDRESS` | — | When set, SOL/USD is read from a Chainlink feed over RPC instead of CoinGecko/Binance. |
| `MORALIS_API_KEY` | — | Optional. Enriches snapshots with holder count and top-holder concentration. |

### Agents

The LLM agents are entirely optional; the trading pipeline runs without them.

| Variable | Default | Description |
|---|---|---|
| `AGENT_API_URL` | — | Base URL of the ADK agent API server, e.g. `http://localhost:8000`. Required by the optimizer worker and the UI's Agent tab. |
| `OPTIMIZER_APP_NAME` | from `/list-apps` | App name the optimizer agent is exposed under. |
| `OPTIMIZER_AGENT_INTERVAL_MINUTES` | `20` | Minutes between optimizer runs (1–1440). |
| `MCP_TOOLBOX_URL` | — | MCP Toolbox server, giving agents read-only SQL access. |
| `MCP_TOOLBOX_CONNECTION_TIMEOUT_MS` | — | Connection timeout for the above. |

### Advanced and debug

`MCP_HTTP_REQUEST_TIMEOUT_MS` (default `0`, disabled, so long tool calls are not cut
off), `MCP_HTTP_HEADERS_TIMEOUT_MS`, `MCP_HTTP_KEEP_ALIVE_TIMEOUT_MS`,
`AMADEUS_PG_USE_DIST_WORKER`, `AMADEUS_DB_SYNCKIT_TIMEOUT_MS`,
`DEBUG_PUMPSWAP_PARSER`, `DEBUG_PUMPSWAP_VOLUME`, `DEBUG_PUMPSWAP_PAIRS_FETCH`,
`LOG_PUMPSWAP_VOLUME`.

---

## Running the stack

[`scripts/amadeus.sh`](scripts/amadeus.sh) supervises all eleven processes. Logs go to
`logs/<service>.log`, PIDs to `.run/`.

```bash
scripts/amadeus.sh start                  # dev mode: tsx watch, auto-reload
scripts/amadeus.sh start --prod           # run compiled dist/ (builds if missing)
scripts/amadeus.sh start --no-ui          # headless
scripts/amadeus.sh start --attach         # tail logs; Ctrl+C stops the stack
scripts/amadeus.sh start --with-agent-api # also start the ADK server + optimizer worker
scripts/amadeus.sh stop | restart | status | logs [service]
```

Services start in pipeline order, with the MCP server first because it applies the
database schema and the UI depends on it. A service that dies during startup is reported
immediately with the tail of its log. `stop` walks the full process tree, so no worker
is left holding an RPC subscription.

To run a single worker by hand, every one has an npm script and a watch variant:

```bash
npm run worker:scoring          # compiled
npm run worker:scoring:dev      # tsx watch
```

---

## Workers

Each runs as its own process and can be scaled or restarted independently.

| Worker | Writes | Cadence | Notes |
|---|---|---|---|
| `pumpswap-pairs` | `pairs` | push | WebSocket subscription to PumpSwap `create_pool`. Publishes to Redis `pairs:new`. |
| `pumpswap-vault-swap` | `pair_swap_events` | push | Subscribes to pool vault accounts. Requires `REDIS_URL`. No DB polling. |
| `chain-snapshots` | `pair_snapshots` | 15–60s | Pool reserves, supply, mint/freeze authority, SOL price, volume and buy/sell counts. On-chain only. PumpSwap for now. |
| `scoring` | `pair_scores` | 30s | Applies each active policy's hard filters and feature weights. Emits `NO_TRADE` / `WATCH` / `TRADE_CANDIDATE` / `PRIORITY_TRADE` plus per-feature contributions. |
| `execution` | `trade_decisions` | 2s | Entries. Validates policy and market mode, applies kill switches, per-policy and per-account limits, reserves balance, sizes the position. Paper or live depending on the account. |
| `exit` | `trades` | 10s | Evaluates stop loss, take profit, time stop, volume collapse, and rug conditions in order. Settles PnL against the account. Sells on-chain for live accounts. |
| `policy-analytics` | `policy_stats_hourly` | 45s | Idempotent hourly rollups for the Stats UI and agent reasoning. |
| `backtest` | `backtest_*` | 5s | Picks up queued runs and replays the deterministic engine over historical snapshots and scores. Never touches live trading tables. |
| `account-balance` | `accounts` | 90s | Syncs native SOL balance for live accounts. |
| `optimizer-agent` | — | 20m | Opt-in. Pokes the optimizer agent, which may propose or apply policy changes. Requires `AGENT_API_URL`. |

---

## Policies, accounts, deployments

The central design decision is that **strategy and capital are separate things**:

- A **policy** is strategy only — entry filters, scoring weights, risk (`risk_per_trade_pct`,
  `stop_loss_pct`, `take_profit_pct`, `time_stop_seconds`), limits (trades per hour,
  concurrent trades, cooldowns after losses), and safety rules (liquidity floors, rug
  exit, required absence of mint authority). Policies live in the `policies` table and go
  `draft` → `active` → `retired`. See [`policies/policy_format.yaml`](policies/policy_format.yaml)
  for the full schema and the other files in [`policies/`](policies/) for worked examples.
- An **account** is capital and account-level risk — balance, max drawdown, max open
  trades, and whether it is `paper` or `live`.
- A **policy deployment** joins the two. The same policy can run simultaneously against a
  paper account and a live wallet, which is how you compare intended behaviour against
  real fills.

Execution runs per deployment, so paper and live results for one strategy are directly
comparable instead of being two separate configurations that drift apart.

### Agents are advisory

Two optional [ADK](https://github.com/google/adk) agents live in [`agents/`](agents/).
The **recommendator** analyses historical performance and writes rows to
`recommendations`; the **optimizer** analyses policy stats via SQL and can propose or
apply tuning. Recommendations are inert until a human accepts them in the UI. The one
exception is a policy explicitly flagged **Auto Optimize**, which the optimizer may
update on its own — leave that off unless you understand what it will do.

---

## Security

**The private key is the whole ballgame.** `SOLANA_PRIVATE_KEY` signs every live
transaction. Treat this repository's threat model as "whatever can read that environment
variable controls the wallet."

- **Use a dedicated hot wallet** funded with only what you are willing to lose. Never
  your main wallet, never a hardware-wallet seed.
- **Keep `.env` out of version control.** It is gitignored, along with the usual
  credential filenames, and this repository's history has been scanned to confirm no key
  was ever committed. That protects you from the common accident, not from a deliberate
  one.
- **The MCP server is unauthenticated.** It binds to `127.0.0.1` by default, and it
  should stay that way. It exposes tools that can change policies, settings, and
  accounts, and force-exit trades. Anything that can reach the port can do all of that.
  Do not set `MCP_BIND_ADDRESS=0.0.0.0` on a machine reachable from the internet; if you
  need remote access, put it behind a VPN or an authenticating reverse proxy.
- **The UI is likewise unauthenticated** and talks to that server. `UI_HOST=0.0.0.0`
  exposes it to your whole network.
- **Rotate anything you paste anywhere.** Helius keys and database URLs end up in shell
  history, terminal scrollback, and screenshots far more often than in code.

Found a vulnerability? Open an issue for anything non-sensitive. For anything that could
be exploited against a running deployment, please report it privately rather than in a
public issue.

---

## Known limitations

Stated plainly, because some of these will cost you money if you assume otherwise.

- **One signer for all live accounts.** `SOLANA_PRIVATE_KEY` is a single process-wide
  keypair, and the Solana executor does not check it against `accounts.address`. If you
  configure two live accounts with different addresses, **both trade from the same
  wallet** while balance syncing follows the addresses you declared — so account-level
  risk limits are computed against a balance that is not the one actually trading. Run
  exactly one live account until this is fixed.
- **Thin test coverage.** One test file, covering swap-event parsing. The scoring,
  execution, and exit workers — roughly 3,500 lines that decide whether money moves —
  have no automated tests. Backtest before trusting any policy change.
- **Solana only.** The data model carries a `chain` column throughout and the executor
  layer has a registry keyed by chain, but only Solana is implemented.
  [`src/executors/evm.ts`](src/executors/evm.ts) is a placeholder that throws.
- **PumpSwap only, in practice.** Raydium and Pump.fun swap paths exist, but discovery
  and snapshots currently cover PumpSwap.
- **No MEV protection.** Transactions go to a standard RPC. No private mempool, no
  Jito bundles, no sandwich mitigation beyond slippage limits.
- **The exit worker bypasses one kill switch.** It calls the live sell path directly
  rather than going through the central `executeOrderForAccount` guard, so
  `LIVE_TRADING_ENABLED=false` stops new entries but does not stop a live exit sell.
  Arguably the safer direction to fail, but it is not what the flag implies.

---

## MCP server

The backend is an [MCP](https://modelcontextprotocol.io/) server over Streamable HTTP,
exposing **54 tools** across pairs, snapshots, scores, decisions, trades, policies,
deployments, accounts, analytics, backtests, recommendations, and agent control. The UI
is a client of those same tools, so anything the UI can do, an agent or script can do
too.

```bash
npm run mcp        # compiled; npm run mcp:dev for watch mode
```

Browse and call tools interactively:

```bash
npx @modelcontextprotocol/inspector     # point it at http://localhost:3000/mcp
```

Business logic lives in `src/mcp-server/tools/<domain>.ts`; REST routes in `routes.ts`
are thin wrappers over the same functions. See [AGENTS.md](AGENTS.md) for the
conventions this follows.

If a client reports a timeout while the server eventually succeeds, the limit is usually
on the client side — the server disables Node's own request timeout by default.

---

## UI

A React + Vite app with a tab per stage of the pipeline: Pairs, Snapshots, Scores,
Decisions, Trades, Policies, Deployments, Account, Stats, Analytics, Recommendations,
Backtests, Agent.

```bash
npm run ui      # or: cd ui && npm install && npm run dev
```

It proxies `/mcp`, `/api`, and `/stats` to the MCP server in development. For a
production build, set `MCP_URL` and serve `ui/dist`.

---

## Operational scripts

Run with `npx tsx src/scripts/<name>.ts`, or from `dist/` after a build.

| Script | Purpose |
|---|---|
| `sell-dust` | Sells leftover tokens with no open position. Supports `--dry-run`. Has npm aliases: `npm run sell-dust:dev -- --dry-run`. |
| `retry-sell` | Rebuilds and retries a sell for one pair. **Simulates by default**; `--send` submits. Useful for diagnosing failed exits. |
| `retry-buy` | The same for a buy. |
| `debug-pumpswap-tx` | Fetches a transaction by signature and runs the PumpSwap parser against it, to check how a real swap is interpreted. |
| `clear-db` | Wipes runtime data but keeps policies and deployments. `--dry-run` lists what it would clear. |
| `test-db-connection` | Verifies `DATABASE_URL`. `npm run test:db`. |

`retry-sell`, `retry-buy`, and `sell-dust` can submit real transactions. All three
simulate unless you pass `--send` or enable live trading.

---

## Development

```bash
npm run build       # tsc, plus copying the DDL into dist/
npm run dev         # tsc --watch
npm test            # node --test over tests/**/*.test.ts
npm run test:db     # check the database connection
```

Conventions are documented in [AGENTS.md](AGENTS.md) and are worth reading before a
first pull request. The important ones:

- **Helius-first RPC.** Batch account reads, use `dataSlice` and filters, paginate with
  cursors, prefer subscriptions over polling. Simulate for compute units, set a priority
  fee, and handle retries yourself rather than leaning on the RPC.
- **Named SQL parameters only.** `db.prepare('... WHERE id = $id').get({ id })`, never
  positional `?`.
- **MCP tools stay thin.** Domain logic belongs in the worker or executor that owns it
  and gets imported, not copied into a tool handler.

Contributions are welcome. Given how thin the test coverage is, a pull request that adds
tests around the scoring, execution, or exit workers is worth more than a feature.

---

## License

ISC. See [LICENSE](LICENSE).
