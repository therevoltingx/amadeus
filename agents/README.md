# Agents

AI agents that use the amadeus MCP server and database to analyze trading data and suggest policy improvements.

## Agents overview

| Agent            | Entry point               | Purpose |
|------------------|---------------------------|--------|
| **Recommendator** | `recommending-agent.ts`   | Analyzes historical policy data (trades, outcomes, skip reasons) and suggests new policies or warnings. |
| **Optimizer**  | `optimizer-agent.ts`   | Uses SQLite (MCP Toolbox) and Amadeus MCP to analyze policy performance and suggest or apply optimizations (weights, thresholds, auto_optimize). |

## Recommendator agent

The recommendator agent entry point is **`recommending-agent.ts`**.

The **recommendator** analyzes historical policy data (trades, outcomes, skip reasons, entry-filter rejections) and suggests new policies or warnings. It does **not** change policies automatically—it only creates recommendations that a human must accept before any policy is modified or created.

The agent has:

- **Read-only** access to the database (via MCP Toolbox) to inspect trades, outcomes, policies, and related tables.
- **MCP tools** from the amadeus server (e.g. policy stats, rejection breakdown, backtest runs) to reason about performance and constraints.

Instructions and constraints are in `recommendator-instruction.txt`.

## Optimizer agent

The optimizer agent entry point is **`optimizer-agent.ts`**.

The **optimizer** uses **SQLite** (MCP Toolbox) and **Amadeus MCP** only. It analyzes policy performance via SQL and Amadeus tools and suggests or applies optimizations (e.g. scoring weights, entry filters, min_trade_score, or enabling auto_optimize). It can create recommendations or update policies when the user asks. Instructions are in `optimizer-instruction.txt`.

## Setup

### Prerequisites

- **Node.js v24.13.0 or above**
- Amadeus **MCP server** running (so the agent can call amadeus tools).
- **MCP Toolbox** server running with the amadeus SQLite database (so the agent can run read-only queries).

From the **repository root**:

1. Build and start the MCP server:
   ```bash
   npm run build
   npm run mcp
   ```
   (Uses port 3000 by default.)

2. Start the MCP Toolbox server with the amadeus DB (in another terminal):
   ```bash
   SQLITE_DATABASE=./data/amadeus.db npx @toolbox-sdk/server --address 0.0.0.0 --ui --prebuilt=sqlite
   ```
   Or use the `toolbox` CLI if installed. See the [main README](../README.md#mcp-toolbox-for-databases) for details.

### Install agent dependencies

From the **`agents`** directory:

```bash
cd agents
npm install
```

### Environment variables

Set these before running the agent (e.g. in `.env` in `agents/` or in your shell):

| Variable           | Description                                      | Example                    |
|--------------------|--------------------------------------------------|----------------------------|
| `MCP_SERVER_URL`   | Amadeus MCP server (Streamable HTTP) URL         | `http://127.0.0.1:3000/mcp` |
| `MCP_TOOLBOX_URL`  | MCP Toolbox server URL (for database tools)      | `http://127.0.0.1:5000`    |

Create an `.env` file in `agents/` if you like:

```bash
# agents/.env
MCP_SERVER_URL=http://127.0.0.1:3000/mcp
MCP_TOOLBOX_URL=http://127.0.0.1:5000
```

Load them when you run the agent (e.g. `export $(cat .env | xargs)` or use a tool that loads `.env`).

## Launch agent in console

From the **`agents`** directory, with `MCP_SERVER_URL` and `MCP_TOOLBOX_URL` set:

```bash
cd agents
npm run run
```

This runs the recommendator (default). To run a specific agent:

```bash
npm run run:recommendator   # recommendator
npm run run:optimizer   # optimizer agent (SQL + Amadeus MCP)
```

Or directly:

```bash
npx adk run recommending-agent.ts
npx adk run optimizer-agent.ts
```

This starts an interactive console session: you can type prompts and the agent will use the MCP and Toolbox tools to analyze data and return recommendations or code suggestions.

### Start the API server

To expose the agent over HTTP (for the Amadeus UI Agent tab or other clients using `AGENT_API_URL`):

From the **`agents`** directory:

```bash
npx adk api_server --verbose
```

By default this loads the main entry point (`recommending-agent.ts`). To run the API server with a different agent, pass the entry file:

```bash
npx adk api_server optimizer-agent.ts --verbose
```

The API server runs by default on `http://localhost:8000` and exposes endpoints such as `/list-apps`, `/run`, `/run_sse`, and session management. Set `AGENT_API_URL` in the Amadeus server's `.env` to this URL (e.g. `http://localhost:8000`) so the UI can connect. The Agent tab dropdown is populated from `/list-apps` (the app name depends on which entry point the server was started with).

### Web UI

For a browser-based chat interface and session inspection:

```bash
npm run web
```

Then open the URL shown (e.g. `http://localhost:8000`).
