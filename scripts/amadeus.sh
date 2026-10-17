#!/usr/bin/env bash
#
# amadeus — start/stop/inspect the full Solana trading stack.
#
#   scripts/amadeus.sh start            # dev mode (tsx watch), MCP + workers + UI
#   scripts/amadeus.sh start --prod     # run compiled dist/ (builds if needed)
#   scripts/amadeus.sh start --attach   # start, then tail all logs until Ctrl+C
#   scripts/amadeus.sh stop
#   scripts/amadeus.sh status
#   scripts/amadeus.sh logs [service]
#
# Services are started as background processes. PIDs live in .run/, logs in logs/.
# Each service is launched through its npm script so package.json stays the
# single source of truth for how a service actually runs.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

RUN_DIR="$ROOT/.run"
LOG_DIR="$ROOT/logs"

MODE="dev"          # dev | prod
WITH_UI=1
WITH_OPTIMIZER=0    # needs AGENT_API_URL + a running ADK api_server
WITH_AGENT_API=0    # starts the ADK api_server from agents/
ATTACH=0
FAILED=""       # services that died during start

# ---------------------------------------------------------------------------
# Service table:  name | npm-script-base | kind
#   kind: core  = MCP server, must be up before workers
#         worker
#         ui
#         agent
# npm-script-base gets ":dev" appended in dev mode (except ui/agent).
# Order matters: ingestion first, then the trade pipeline.
# ---------------------------------------------------------------------------
SERVICES="\
mcp|mcp|core
pumpswap-pairs|worker:pumpswap-pairs|worker
pumpswap-vault-swap|worker:pumpswap-vault-swap|worker
chain-snapshots|worker:chain-snapshots|worker
scoring|worker:scoring|worker
execution|worker:execution|worker
exit|worker:exit|worker
policy-analytics|worker:policy-analytics|worker
account-balance|worker:account-balance|worker
backtest|worker:backtest|worker"

OPTIMIZER_SERVICE="optimizer-agent|worker:optimizer-agent|worker"

C_RESET=$'\033[0m'; C_RED=$'\033[31m'; C_GRN=$'\033[32m'
C_YEL=$'\033[33m'; C_BLU=$'\033[34m'; C_DIM=$'\033[2m'

info() { printf '%s==>%s %s\n' "$C_BLU" "$C_RESET" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$C_GRN" "$C_RESET" "$*"; }
warn() { printf '%swarn%s %s\n' "$C_YEL" "$C_RESET" "$*"; }
err()  { printf '%s err%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
die()  { err "$*"; exit 1; }

# --- env -------------------------------------------------------------------

# Read .env for preflight only. The app loads its own via dotenv; we just need
# to know whether the required vars are actually set.
load_env() {
  [ -f "$ROOT/.env" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    local key="${line%%=*}"
    local val="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    # strip surrounding quotes
    val="${val%\"}"; val="${val#\"}"
    val="${val%\'}"; val="${val#\'}"
    # don't clobber anything already exported in the shell
    if [ -z "${!key:-}" ]; then export "$key=$val"; fi
  done < "$ROOT/.env"
}

port_open() {
  # $1 host, $2 port — returns 0 if something is listening.
  # The subshell owns fd 3 and closes it on exit; never use a bare `exec` with a
  # redirect here, it would apply to this shell permanently.
  ( exec 3<>"/dev/tcp/$1/$2" ) 2>/dev/null
}

wait_for_port() {
  local host="$1" port="$2" name="$3" tries="${4:-40}"
  local i=0
  while [ "$i" -lt "$tries" ]; do
    if port_open "$host" "$port"; then return 0; fi
    sleep 0.5
    i=$((i + 1))
  done
  return 1
}

# --- process helpers -------------------------------------------------------

pid_file() { printf '%s/%s.pid' "$RUN_DIR" "$1"; }
log_file() { printf '%s/%s.log' "$LOG_DIR" "$1"; }

is_running() {
  local pf; pf="$(pid_file "$1")"
  [ -f "$pf" ] || return 1
  local pid; pid="$(cat "$pf" 2>/dev/null)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

# npm run / tsx watch both fork children; killing the parent alone orphans them.
kill_tree() {
  local pid="$1" sig="${2:-TERM}" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$child" "$sig"
  done
  kill "-$sig" "$pid" 2>/dev/null
}

start_service() {
  local name="$1" script="$2" kind="$3"
  local lf; lf="$(log_file "$name")"
  local pf; pf="$(pid_file "$name")"

  if is_running "$name"; then
    warn "$name already running (pid $(cat "$pf"))"
    return 0
  fi

  local npm_script="$script"
  if [ "$MODE" = "dev" ] && [ "$kind" != "ui" ] && [ "$kind" != "agent" ]; then
    npm_script="${script}:dev"
  fi

  : > "$lf"
  if [ "$kind" = "agent" ]; then
    ( cd "$ROOT/agents" && exec npx adk api_server optimizer-agent.ts ) </dev/null >>"$lf" 2>&1 &
  else
    npm run --silent "$npm_script" </dev/null >>"$lf" 2>&1 &
  fi
  local pid=$!
  echo "$pid" > "$pf"

  # A service that dies instantly (bad env, port clash) should be reported now,
  # not discovered later in a log file.
  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$pf"
    FAILED="$FAILED $name"
    err "$name failed to start — last lines of $(basename "$lf"):"
    tail -n 15 "$lf" | sed 's/^/      /' >&2
    return 1
  fi
  ok "$name (pid $pid)  ${C_DIM}logs/$name.log${C_RESET}"
  return 0
}

stop_service() {
  local name="$1"
  local pf; pf="$(pid_file "$name")"
  if ! is_running "$name"; then
    rm -f "$pf"
    return 0
  fi
  local pid; pid="$(cat "$pf")"
  kill_tree "$pid" TERM
  local i=0
  while [ "$i" -lt 20 ] && kill -0 "$pid" 2>/dev/null; do
    sleep 0.25; i=$((i + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill_tree "$pid" KILL
  fi
  rm -f "$pf"
  ok "stopped $name"
}

# --- preflight -------------------------------------------------------------

preflight() {
  info "Preflight"
  local fatal=0

  # Node version
  local want have
  want="$(tr -d 'v[:space:]' < "$ROOT/.nvmrc" 2>/dev/null)"
  have="$(node -v 2>/dev/null | tr -d 'v')"
  if [ -z "$have" ]; then
    err "node not found"; fatal=1
  else
    local want_major="${want%%.*}" have_major="${have%%.*}"
    if [ "${have_major:-0}" -lt "${want_major:-0}" ]; then
      err "node $have is older than required v$want (see .nvmrc)"; fatal=1
    else
      ok "node v$have"
    fi
  fi

  # .env
  if [ ! -f "$ROOT/.env" ]; then
    err ".env not found — run: cp .env.example .env  (then fill in the values below)"
    fatal=1
  else
    ok ".env present"
  fi

  # Required vars
  local v
  for v in DATABASE_URL HELIUS_RPC_URL REDIS_URL; do
    if [ -z "${!v:-}" ]; then
      err "$v is not set (required)"; fatal=1
    else
      ok "$v set"
    fi
  done

  # Bail before doing expensive work (installs, builds) if config is broken.
  [ "$fatal" = 0 ] || die "preflight failed — fix the errors above"

  # Dependencies
  if [ ! -d "$ROOT/node_modules" ]; then
    info "installing root dependencies (npm install)"
    npm install --silent || { err "npm install failed"; fatal=1; }
  fi
  if [ "$WITH_UI" = 1 ] && [ ! -d "$ROOT/ui/node_modules" ]; then
    info "installing ui dependencies"
    ( cd "$ROOT/ui" && npm install --silent ) || { err "ui npm install failed"; fatal=1; }
  fi
  if [ "$WITH_AGENT_API" = 1 ] && [ ! -d "$ROOT/agents/node_modules" ]; then
    info "installing agents dependencies"
    ( cd "$ROOT/agents" && npm install --silent ) || { err "agents npm install failed"; fatal=1; }
  fi

  # Build artifacts for prod mode
  if [ "$MODE" = "prod" ]; then
    if [ ! -d "$ROOT/dist" ]; then
      info "dist/ missing — building"
      npm run build || { err "build failed"; fatal=1; }
    else
      ok "dist/ present"
    fi
  fi

  # Postgres reachable
  if [ -n "${DATABASE_URL:-}" ]; then
    if command -v pg_isready >/dev/null 2>&1; then
      if pg_isready -d "$DATABASE_URL" -t 5 >/dev/null 2>&1; then
        ok "postgres reachable"
      else
        err "postgres not reachable at DATABASE_URL"; fatal=1
      fi
    else
      warn "pg_isready not installed — skipping postgres check"
    fi
  fi

  # Redis reachable (required by the vault-swap worker's pub/sub)
  if [ -n "${REDIS_URL:-}" ]; then
    if command -v redis-cli >/dev/null 2>&1; then
      if redis-cli -u "$REDIS_URL" ping 2>/dev/null | grep -q PONG; then
        ok "redis reachable"
      else
        err "redis not reachable at REDIS_URL"; fatal=1
      fi
    else
      warn "redis-cli not installed — skipping redis check"
    fi
  fi

  # Port availability
  local mcp_port="${PORT:-3000}"
  if port_open 127.0.0.1 "$mcp_port" && ! is_running mcp; then
    err "port $mcp_port is already in use (MCP server) — set PORT or free it"; fatal=1
  fi
  if [ "$WITH_UI" = 1 ]; then
    local ui_port="${UI_PORT:-5173}"
    if port_open 127.0.0.1 "$ui_port" && ! is_running ui; then
      warn "port $ui_port in use — Vite will pick the next free port"
    fi
  fi

  # Live trading is loud on purpose.
  if [ "${LIVE_TRADING_ENABLED:-}" = "true" ]; then
    if [ "${LIVE_EXECUTION_DRY_RUN:-}" = "true" ]; then
      warn "LIVE_TRADING_ENABLED=true but LIVE_EXECUTION_DRY_RUN=true — transactions are simulated, not sent"
    else
      printf '%s\n' "${C_RED}  !! LIVE TRADING IS ENABLED — real transactions will be signed and sent.${C_RESET}"
      if [ -z "${SOLANA_PRIVATE_KEY:-}" ]; then
        err "LIVE_TRADING_ENABLED=true but SOLANA_PRIVATE_KEY is not set"; fatal=1
      fi
    fi
  else
    ok "live trading disabled (paper only)"
  fi

  [ "$fatal" = 0 ] || die "preflight failed — fix the errors above"
  echo
}

# --- commands --------------------------------------------------------------

cmd_start() {
  mkdir -p "$RUN_DIR" "$LOG_DIR"
  preflight

  info "Starting amadeus (${MODE} mode)"

  # MCP first: it applies the Postgres schema on first DB access, and the UI
  # talks to it. Workers are happy either way, but this keeps startup ordered.
  local name script kind
  while IFS='|' read -r name script kind; do
    [ -n "$name" ] || continue
    start_service "$name" "$script" "$kind"
    if [ "$name" = "mcp" ]; then
      if wait_for_port 127.0.0.1 "${PORT:-3000}" mcp; then
        ok "mcp listening on http://127.0.0.1:${PORT:-3000}/mcp"
      else
        warn "mcp did not open port ${PORT:-3000} in time — check logs/mcp.log"
      fi
    fi
  done <<< "$SERVICES"

  if [ "$WITH_AGENT_API" = 1 ]; then
    start_service agent-api "" agent
    wait_for_port 127.0.0.1 8000 agent-api 20 && ok "agent api on http://127.0.0.1:8000"
  fi

  if [ "$WITH_OPTIMIZER" = 1 ]; then
    if [ -z "${AGENT_API_URL:-}" ]; then
      warn "skipping optimizer-agent worker: AGENT_API_URL is not set"
    else
      while IFS='|' read -r name script kind; do
        start_service "$name" "$script" "$kind"
      done <<< "$OPTIMIZER_SERVICE"
    fi
  fi

  if [ "$WITH_UI" = 1 ]; then
    start_service ui ui ui
    ok "ui on http://localhost:${UI_PORT:-5173}"
  fi

  echo
  if [ -n "$FAILED" ]; then
    err "some services failed to start:$FAILED"
    err "inspect with: scripts/amadeus.sh logs <service>"
  else
    info "All services started."
  fi
  info "${C_DIM}scripts/amadeus.sh status | logs [service] | stop${C_RESET}"

  if [ "$ATTACH" = 1 ]; then
    echo
    info "Tailing logs (Ctrl+C stops everything)"
    trap 'echo; cmd_stop; exit 0' INT TERM
    tail -n 5 -F "$LOG_DIR"/*.log &
    wait $!
  fi
}

cmd_stop() {
  info "Stopping amadeus"
  local pf name
  # Stop everything we have a pidfile for, not just what the current flags imply.
  for pf in "$RUN_DIR"/*.pid; do
    [ -e "$pf" ] || continue
    name="$(basename "$pf" .pid)"
    stop_service "$name"
  done
  ok "done"
}

cmd_status() {
  local pf name pid
  printf '%-22s %-10s %s\n' SERVICE STATUS PID
  printf '%-22s %-10s %s\n' "----------------------" "----------" "------"
  local any=0
  for pf in "$RUN_DIR"/*.pid; do
    [ -e "$pf" ] || continue
    any=1
    name="$(basename "$pf" .pid)"
    pid="$(cat "$pf" 2>/dev/null)"
    if is_running "$name"; then
      printf '%-22s %s%-10s%s %s\n' "$name" "$C_GRN" running "$C_RESET" "$pid"
    else
      printf '%-22s %s%-10s%s %s\n' "$name" "$C_RED" dead "$C_RESET" "-"
    fi
  done
  [ "$any" = 1 ] || echo "(nothing started)"
}

cmd_logs() {
  mkdir -p "$LOG_DIR"
  if [ -n "${1:-}" ]; then
    local lf; lf="$(log_file "$1")"
    [ -f "$lf" ] || die "no log for '$1' (try: status)"
    tail -n 100 -F "$lf"
  else
    tail -n 20 -F "$LOG_DIR"/*.log
  fi
}

usage() {
  cat <<'USAGE'
amadeus — Solana trading stack process manager

  scripts/amadeus.sh start [options]
  scripts/amadeus.sh stop
  scripts/amadeus.sh restart [options]
  scripts/amadeus.sh status
  scripts/amadeus.sh logs [service]

Options (start/restart):
  --dev            tsx watch, auto-reload on file change  (default)
  --prod           run compiled dist/ (builds if missing)
  --no-ui          don't start the Vite UI dev server
  --with-optimizer start the optimizer-agent worker (needs AGENT_API_URL)
  --with-agent-api start the ADK api_server from agents/ (implies --with-optimizer)
  --attach         tail all logs; Ctrl+C stops the whole stack

Services started by default:
  mcp, pumpswap-pairs, pumpswap-vault-swap, chain-snapshots,
  scoring, execution, exit, policy-analytics, account-balance, backtest, ui
USAGE
}

# --- main ------------------------------------------------------------------

CMD="${1:-}"; shift 2>/dev/null || true

for arg in "$@"; do
  case "$arg" in
    --dev)            MODE="dev" ;;
    --prod)           MODE="prod" ;;
    --no-ui)          WITH_UI=0 ;;
    --with-optimizer) WITH_OPTIMIZER=1 ;;
    --with-agent-api) WITH_AGENT_API=1; WITH_OPTIMIZER=1 ;;
    --attach)         ATTACH=1 ;;
    -h|--help)        usage; exit 0 ;;
    *) ;;
  esac
done

load_env

case "$CMD" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; echo; cmd_start ;;
  status)  cmd_status ;;
  logs)    cmd_logs "${1:-}" ;;
  ""|-h|--help|help) usage ;;
  *) err "unknown command: $CMD"; echo; usage; exit 1 ;;
esac
