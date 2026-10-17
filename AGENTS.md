# Agent instructions

This file guides AI agents and developers working on the Amadeus codebase.

---

## Solana: use Helius RPC and API, optimize usage

**Rule:** When working with the Solana blockchain, use **Helius RPC and API** (not generic public RPC endpoints). Code that talks to Solana must follow Helius optimization best practices so that performance, cost, and reliability stay in line with their guides.

### Why

- **Reliability and performance:** Helius provides stable, high-quality RPC and APIs suited for production.
- **Cost and rate limits:** Optimized patterns reduce call volume and avoid unnecessary throttling.
- **Consistency:** One provider and one set of patterns across the codebase.

### References (follow these)

- **[RPC optimization techniques](https://www.helius.dev/docs/rpc/optimization-techniques)** — Data retrieval, batching, pagination, WebSockets vs polling, commitment levels, error handling.
- **[Transaction optimization](https://www.helius.dev/docs/sending-transactions/optimizing-transactions)** — Priority fees, compute units, send options, confirmation and retry logic.

### What to do

1. **RPC / data**
   - Prefer **Helius RPC** (e.g. `https://mainnet.helius-rpc.com/?api-key=...`) for `Connection` or direct RPC calls.
   - Use **batch calls** (`getMultipleAccountsInfo`) instead of many single-account calls.
   - Use **dataSlice** and **filters** (`dataSize`, `memcmp`) to limit payload size and work done by the RPC.
   - For large datasets use **cursor-based pagination** (e.g. `getProgramAccountsV2` with `limit` and `paginationKey`) instead of unbounded `getProgramAccounts`.
   - Prefer **WebSocket subscriptions** for real-time updates instead of polling; close subscriptions when done.

2. **Transactions**
   - Use **commitment `"confirmed"`** for blockhash and general use unless you need finality.
   - **Simulate** to get compute units consumed, then set compute unit limit with a small margin (e.g. ~1.1×).
   - Set **priority fee** via Helius (e.g. `getPriorityFeeEstimate` with `recommended: true`) and apply it to the transaction.
   - Prefer **skipPreflight: true** and **maxRetries: 0** when you handle retries/confirmation yourself.
   - Implement **retry/rebroadcast** using latest blockhash and signature status checks rather than relying on RPC retries alone.

3. **General**
   - Use **named/configurable RPC URL** (e.g. env) so the Helius endpoint and API key are not hardcoded.
   - Handle **rate limits (429)** and RPC errors with backoff and clear error handling.

When adding or changing Solana-related code (e.g. in `src/executors/`, RPC clients, or workers that call Solana), align with the two Helius docs above.

---

## MCP server: implement endpoints as tools, not standalone routes

**Rule:** MCP server "endpoints" (API behavior) must be implemented as **tools**, not as standalone logic in `routes.ts`.

### Why

- **Single source of truth:** Behavior lives in one place and is exposed both as MCP tools (for AI/clients) and, when needed, as REST routes (for the UI).
- **Consistency:** All feature modules under `src/mcp-server/tools/` follow the same pattern.
- **Testability:** Tool handlers are plain functions that can be unit-tested without Express.

### How to implement

1. **Put logic under `src/mcp-server/tools/`**
   - One file per domain (e.g. `agent.ts`, `policies.ts`, `analytics.ts`).
   - Implement **pure handlers** that take typed inputs and return data (or throw). No `req`/`res` in the tool module.
   - Export a **registration function** `registerXxxTools(server: McpServer)` that calls `server.registerTool(...)` for each tool, with `inputSchema` (use `z` from `../schema.js`) and a handler that calls the same pure logic.

2. **Register tools in `src/mcp-server/tools/index.ts`**
   - Import `registerXxxTools` and call it from `registerAllTools(server)`.

3. **REST routes in `src/mcp-server/routes.ts` are thin wrappers**
   - For any REST path that exposes "endpoint" behavior (e.g. `/api/config`, `/api/agent/status`, `/api/agent/sessions`), the route handler must **only**:
     - Read query/body/params.
     - Call the exported functions from the appropriate tool module.
     - Send the result (or error) with the right status code.
   - Do **not** put business logic, `fetch` calls, or DB access directly in `routes.ts` for these endpoints.

### Pattern summary

| Layer | Location | Responsibility |
|-------|----------|----------------|
| **Logic** | `src/mcp-server/tools/<domain>.ts` | Exported functions (e.g. `getConfig()`, `getAgentStatus()`) + `registerXxxTools(server)` |
| **MCP** | Same file via `registerXxxTools` | `server.registerTool(name, { description, inputSchema }, handler)` calling those functions |
| **REST** | `src/mcp-server/routes.ts` | Thin route: parse request → call tool function → `res.json(...)` or `res.status(...).json(...)` |

### Allowed exceptions in `routes.ts`

- **Transport and MCP wiring:** e.g. `POST/GET /mcp` that delegate to `transport.handleRequest(...)`.
- **Middleware:** CORS, JSON body parser, logging.
- **Legacy or special-case routes** that have not yet been migrated to the tools pattern (e.g. file download with `Content-Disposition`, or one-off stats). When adding new behavior, do **not** add new standalone route logic; add a tool and a thin REST route that calls it.

### When adding a new "endpoint"

1. Add or extend a module in `src/mcp-server/tools/` with the logic and `registerXxxTools`.
2. Register it in `tools/index.ts`.
3. If the UI or another client needs REST, add a minimal route in `routes.ts` that calls the tool's exported function(s) and sends the response.

---

## MCP tools must be thin wrappers — reuse existing modules

**Rule:** MCP tool handlers in `src/mcp-server/tools/` must **not** contain business logic, DB statements, or execution code that already exists in another module. If the logic exists elsewhere (workers, executors, services), import and call it — do not copy it.

### Why

- **No duplication:** Copying logic into a tool means two places to maintain, two places for bugs, and two places that can drift apart.
- **Keep tools lightweight:** Tool files should only deal with input validation, calling the real implementation, and formatting the MCP response.
- **Single source of truth:** Domain logic belongs in the module that owns it (e.g. exit logic belongs in `exit-worker.ts`, execution logic in `executors/solana.ts`).

### How

1. **Before writing logic in a tool file, check if the behavior already exists.**
   - Workers: `src/workers/` (exit-worker, chain-snapshots-worker, scoring-worker, etc.)
   - Executors: `src/executors/` (solana.ts, etc.)
   - Services / helpers: `src/sol-price.ts`, `src/deployment-resolver.ts`, `src/db.ts`, etc.

2. **If the logic exists, export a function from that module and call it from the tool.**
   - The source module exports the function and its return type.
   - The tool file imports the function, calls it, and wraps the result in the MCP response format.
   - Example: `forceExitDecision()` lives in `exit-worker.ts`; the `force_exit_trade` tool just calls it.

3. **If the logic does not exist yet, decide where it belongs.**
   - If it is domain logic tied to a worker or executor, add it there and export it.
   - Only put logic directly in a tool file if it is truly tool-specific (e.g. formatting, aggregation of multiple queries for a dashboard view).

4. **Never duplicate prepared statements, types, or helper functions.**
   - If a tool needs a DB query or type that a worker already defines, import it from the worker (or extract it to a shared module) rather than redefining it.

### Pattern

```
src/workers/exit-worker.ts          ← owns exit logic, exports forceExitDecision()
src/mcp-server/tools/decisions.ts   ← thin wrapper: import { forceExitDecision } → call → return MCP response
```

### Red flags (do not do these)

- Copying a prepared statement (`db.prepare(...)`) that already exists in another file.
- Re-implementing sell/buy execution flow inside a tool file.
- Defining an interface that mirrors one already exported from a worker or executor.
- A tool handler longer than ~30 lines of non-query logic — it probably belongs in a dedicated module.

---

## SQL: always use named parameters

**Rule:** Any SQL query executed via `db.prepare(...)` must use **named parameters** (e.g. `$name`, `:name`) and pass a single **params object** to `.get()`, `.all()`, or `.run()`. Do **not** use positional placeholders (`?`) or spread positional arguments.

### Why

- **Readability:** Parameter names in the SQL match the keys in the params object, so it’s clear what each value is for.
- **Maintainability:** Adding or reordering parameters doesn’t require updating multiple argument lists.
- **Safety:** Reduces mistakes from wrong argument order when many parameters are used.

### How

1. **In the SQL string** use named placeholders (`$name`, e.g. `$accountId`, `$policy_version`, `$limit`). The PostgreSQL worker maps these to positional binds.
2. **When executing** pass one object: `.get({ accountId, policy_version })`, `.all({ startOfDay, ...tw.params, limit })`, `.run({ id, value })`.
3. **Reuse the same name** in the SQL when the same value is bound in multiple places (e.g. `$accountId` in two conditions); the params object still has one key.

### Example

```ts
// Good: named parameters
const row = db
  .prepare(
    `SELECT * FROM trades WHERE account_id = $accountId AND exit_time >= $startOfDay LIMIT $limit`
  )
  .get({ accountId, startOfDay, limit });

// Bad: positional placeholders
const row = db
  .prepare(`SELECT * FROM trades WHERE account_id = ? AND exit_time >= ? LIMIT ?`)
  .get(accountId, startOfDay, limit);
```

### Scope

This applies to all SQL in the repo: `src/db.ts`, `src/mcp-server/tools/*.ts`, `src/workers/*.ts`, `src/executors/*.ts`, and any other module that calls `db.prepare(...)`.
