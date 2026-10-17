/**
 * Optimizer agent worker: calls the optimizer agent via the REST API on a configurable interval (default 20 minutes).
 * Sends a single message "run again" so the agent runs its cycle (auto-optimize active policies with Auto Optimize enabled,
 * SQL analytics, DexScreener/DexTools checks, policy updates or recommendations).
 *
 * Requires AGENT_API_URL (same as the UI Agent tab). The agent API server must be running
 * with the optimizer entry point (e.g. `npx adk api_server optimizer-agent.ts`).
 * Optional: OPTIMIZER_APP_NAME (default: resolved from list-apps: "optimizer-agent" or "optimizer_agent") if your ADK server exposes a different app name.
 * Optional: OPTIMIZER_AGENT_INTERVAL_MINUTES (default: 20) — interval in minutes between runs.
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import {
  getAgentStatus,
  createAgentSession,
  runAgent,
} from '../mcp-server/tools/agent.js';
import { db } from '../db.js';

const LOG_PREFIX = '[optimizer-agent-worker]';
const DEFAULT_INTERVAL_MINUTES = 20;
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 60 * 24; // 24 hours

function getRunIntervalMs(): number {
  const raw = (process.env.OPTIMIZER_AGENT_INTERVAL_MINUTES ?? '').trim();
  if (!raw) return DEFAULT_INTERVAL_MINUTES * 60 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < MIN_INTERVAL_MINUTES || n > MAX_INTERVAL_MINUTES) {
    console.warn(
      `${LOG_PREFIX} OPTIMIZER_AGENT_INTERVAL_MINUTES must be between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}; using default ${DEFAULT_INTERVAL_MINUTES}.`
    );
    return DEFAULT_INTERVAL_MINUTES * 60 * 1000;
  }
  return Math.round(n) * 60 * 1000;
}

const RUN_INTERVAL_MS = getRunIntervalMs();
const USER_ID = 'default';
const SESSION_ID = 'optimizer_worker';
const MESSAGE = 'run again';

/** When the agent API (e.g. Gemini) returns 503, retry after this many milliseconds. */
const RETRY_503_MS = 60 * 1000;

/** Default app names to try (ADK often uses entry-point filename "optimizer-agent"; agent name is "optimizer_agent"). */
const DEFAULT_APP_NAMES = ['optimizer-agent', 'optimizer_agent'];

/** Extract one string per model event so multiple agent responses can be logged separately. */
function getModelMessagesFromEvents(
  events: { content?: { role?: string; parts?: { text?: string }[] } }[]
): string[] {
  const messages: string[] = [];
  for (const ev of events) {
    if (ev.content?.role !== 'model' || !Array.isArray(ev.content.parts)) continue;
    const text = ev.content.parts
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n\n')
      .trim();
    if (text) messages.push(text);
  }
  return messages;
}

function getAppName(apps: string[]): string | null {
  const explicit = (process.env.OPTIMIZER_APP_NAME ?? '').trim();
  if (explicit && apps.includes(explicit)) return explicit;
  if (explicit) return null;
  return DEFAULT_APP_NAMES.find((name) => apps.includes(name)) ?? null;
}

async function ensureSession(): Promise<{ ok: boolean; appName: string | null }> {
  const status = await getAgentStatus();
  if (!status.connected || !Array.isArray(status.apps)) {
    console.warn(`${LOG_PREFIX} Agent API not connected; check AGENT_API_URL and API server.`);
    return { ok: false, appName: null };
  }
  const appName = getAppName(status.apps);
  if (!appName) {
    console.warn(`${LOG_PREFIX} Optimizer app not in list-apps: [${status.apps.join(', ')}]. Set OPTIMIZER_APP_NAME if needed.`);
    return { ok: false, appName: null };
  }

  const result = await createAgentSession({
    appName,
    userId: USER_ID,
    sessionId: SESSION_ID,
  });

  if ('error' in result) {
    if (result.status === 409 || (result.error && result.error.toLowerCase().includes('exist'))) {
      return { ok: true, appName };
    }
    console.warn(`${LOG_PREFIX} Create session failed: ${result.error}.`);
    return { ok: false, appName: null };
  }
  return { ok: true, appName };
}

/** Run the agent once; on 503, retry every RETRY_503_MS until success or non-503 error. */
async function runAgentWith503Retry(appName: string): Promise<{ events: { content?: { role?: string; parts?: { text?: string }[] } }[] } | { error: string; status?: number }> {
  let attempt = 0;
  for (;;) {
    attempt += 1;
    if (attempt > 1) console.log(`${LOG_PREFIX} Retry ${attempt} after 503.`);
    const result = await runAgent({
      appName,
      userId: USER_ID,
      sessionId: SESSION_ID,
      text: MESSAGE,
    });
    if (!('error' in result)) return result;
    if (result.status === 503) {
      console.warn(`${LOG_PREFIX} Agent API 503; retrying in ${RETRY_503_MS / 1000}s.`);
      await new Promise((r) => setTimeout(r, RETRY_503_MS));
      continue;
    }
    return result;
  }
}

async function runCycle(): Promise<void> {
  const baseUrl = (process.env.AGENT_API_URL ?? '').replace(/\/$/, '');
  if (!baseUrl) {
    console.warn(`${LOG_PREFIX} AGENT_API_URL not set; skipping cycle.`);
    return;
  }

  const hasAutoOptimize = db
    .prepare(
      `SELECT 1 FROM policies WHERE status = $status AND auto_optimize = $autoOptimize LIMIT 1`
    )
    .get({ status: 'active', autoOptimize: 1 });
  if (!hasAutoOptimize) {
    console.log(`${LOG_PREFIX} No active policies with auto-optimize; skipping cycle.`);
    return;
  }

  const { ok, appName } = await ensureSession();
  if (!ok || !appName) return;

  const runResult = await runAgentWith503Retry(appName);

  if ('error' in runResult) {
    if (runResult.status === 404 || (runResult.error && runResult.error.toLowerCase().includes('session'))) {
      const retrySession = await ensureSession();
      if (retrySession.ok && retrySession.appName) {
        const retry = await runAgentWith503Retry(retrySession.appName);
        if ('error' in retry) {
          console.error(`${LOG_PREFIX} Run failed: ${retry.error}.`);
        } else {
          console.log(`${LOG_PREFIX} Sent "run again".`);
          const modelMessages = getModelMessagesFromEvents(retry.events);
          modelMessages.forEach((msg, i) => {
            const label = modelMessages.length > 1 ? `Response ${i + 1}/${modelMessages.length}:` : 'Response:';
            console.log(`${LOG_PREFIX} ${label}\n${msg}`);
          });
        }
        return;
      }
    }
    console.error(`${LOG_PREFIX} Run failed: ${runResult.error}.`);
    return;
  }

  console.log(`${LOG_PREFIX} Sent "run again".`);
  const modelMessages = getModelMessagesFromEvents(runResult.events);
  modelMessages.forEach((msg, i) => {
    const label = modelMessages.length > 1 ? `Response ${i + 1}/${modelMessages.length}:` : 'Response:';
    console.log(`${LOG_PREFIX} ${label}\n${msg}`);
  });
}

export async function startOptimizerAgentWorker(): Promise<void> {
  const baseUrl = (process.env.AGENT_API_URL ?? '').replace(/\/$/, '');
  const intervalMinutes = RUN_INTERVAL_MS / 1000 / 60;
  if (!baseUrl) {
    console.warn(`${LOG_PREFIX} AGENT_API_URL not set; worker will skip cycles until set.`);
  } else {
    const status = await getAgentStatus();
    const appName =
      status.connected && Array.isArray(status.apps)
        ? getAppName(status.apps)
        : null;
    console.log(`${LOG_PREFIX} Starting every ${intervalMinutes} min, app=${appName ?? 'optimizer-agent/optimizer_agent'}, session=${SESSION_ID}.`);
  }

  async function cycle(): Promise<void> {
    try {
      await runCycle();
    } catch (err) {
      console.error(`${LOG_PREFIX} Cycle error:`, err);
    }
  }

  console.log(`${LOG_PREFIX} Running initial cycle.`);
  await cycle();
  setInterval(cycle, RUN_INTERVAL_MS);
}

const isMain =
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1]?.endsWith('optimizer-agent-worker.js');

if (isMain) {
  startOptimizerAgentWorker().catch((err) => {
    console.error(`${LOG_PREFIX} Fatal:`, err);
    process.exit(1);
  });
}
