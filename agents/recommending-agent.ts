import { LlmAgent, MCPToolset, type ToolUnion } from '@google/adk';
import { ToolboxClient } from '@toolbox-sdk/adk';
import axios from 'axios';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Recommendation system: advisory only, no auto-apply.
 * Source-agnostic (agent / human / system), auditable, UI-visible.
 * (Inlined from former `src/types/recommendation.ts`; domain slice duplicated in `src/types/recommendation.ts` for MCP server — keep aligned.)
 */

export const RECOMMENDATION_SCOPES = ['policy', 'account', 'global'] as const;
export const RECOMMENDATION_SOURCES = ['agent', 'human', 'system'] as const;
export const RECOMMENDATION_TYPES = ['policy_variant', 'new_policy', 'warning', 'suggestion'] as const;

/** Stored in recommendations.policy_version when the recommendation is for a brand-new policy (not based on an existing one). */
export const NEW_POLICY_RECOMMENDATION_BASE = '__new__';
export const RECOMMENDATION_STATUSES = ['pending', 'accepted', 'rejected', 'expired'] as const;

export type RecommendationScope = (typeof RECOMMENDATION_SCOPES)[number];
export type RecommendationSource = (typeof RECOMMENDATION_SOURCES)[number];
export type RecommendationType = (typeof RECOMMENDATION_TYPES)[number];
export type RecommendationStatus = (typeof RECOMMENDATION_STATUSES)[number];

export interface CreateRecommendationInput {
  /** Required for policy_variant; omit or empty for new_policy (stored as NEW_POLICY_RECOMMENDATION_BASE). */
  policyVersion?: string;
  scope: RecommendationScope;
  source: RecommendationSource;
  sourceId?: string | null;
  recommendationType: RecommendationType;
  payload: Record<string, unknown>;
  confidence?: number | null;
  rationale?: string | null;
  /** Optional changelog text applied to the new policy when the recommendation is accepted. */
  changelog?: string | null;
  /**
   * For policy_variant / new_policy: proposed **policy_version** for the new policy.
   * Must match the version string in the new changelog heading `## [name] - YYYY-MM-DD`.
   */
  name?: string | null;
}

// --- Amadeus MCP server (Streamable HTTP) timeouts ---

/** Env: HTTP timeout (ms) for recommendator → Amadeus MCP server requests. */
export const RECOMMENDATOR_MCP_SERVER_CONNECTION_TIMEOUT_MS_ENV =
  'MCP_SERVER_CONNECTION_TIMEOUT_MS';

/** Default when env is unset or invalid. */
export const RECOMMENDATOR_MCP_SERVER_CONNECTION_TIMEOUT_MS_DEFAULT = 120_000;

export function getRecommendatorMcpServerConnectionTimeoutMs(): number {
  const raw = Number(process.env[RECOMMENDATOR_MCP_SERVER_CONNECTION_TIMEOUT_MS_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : RECOMMENDATOR_MCP_SERVER_CONNECTION_TIMEOUT_MS_DEFAULT;
}

function mergeAbortSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const combined = new AbortController();
  const forward = (source: AbortSignal) => {
    if (source.aborted) {
      combined.abort(source.reason);
      return true;
    }
    source.addEventListener('abort', () => combined.abort(source.reason), { once: true });
    return false;
  };
  if (forward(a)) return combined.signal;
  if (forward(b)) return combined.signal;
  return combined.signal;
}

/**
 * Fetch used as MCPToolset `transportOptions.fetch` so Streamable HTTP requests
 * honor a wall-clock timeout (ADK does not wire `StreamableHTTPConnectionParams.timeout` today).
 */
export function createMcpStreamableHttpFetchWithTimeout(timeoutMs: number): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      timeoutController.abort(new Error('MCP HTTP request timeout'));
    }, timeoutMs);
    const outer = init?.signal;
    const signal = outer ? mergeAbortSignals(outer, timeoutController.signal) : timeoutController.signal;
    return fetch(input, { ...init, signal }).finally(() => clearTimeout(timer));
  };
}

/** HTTP timeout (ms) for SQL Toolbox MCP requests (connect + transfer). Env MCP_TOOLBOX_CONNECTION_TIMEOUT_MS; default 120000. */
const sqlConnectionTimeoutMs = (() => {
  const raw = Number(process.env.MCP_TOOLBOX_CONNECTION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
})();

const sqlHttp = axios.create({ timeout: sqlConnectionTimeoutMs });

const sqlClient = new ToolboxClient(process.env.MCP_TOOLBOX_URL as string, sqlHttp);

const sqlToolset = {
  getTools: async () => await sqlClient.loadToolset(),
} as unknown as ToolUnion;

const serverMcpConnectionTimeoutMs = getRecommendatorMcpServerConnectionTimeoutMs();

const serverMCPToolset = new MCPToolset({
  type: 'StreamableHTTPConnectionParams',
  url: process.env.MCP_SERVER_URL as string,
  timeout: serverMcpConnectionTimeoutMs,
  transportOptions: {
    fetch: createMcpStreamableHttpFetchWithTimeout(serverMcpConnectionTimeoutMs),
  },
});

export const rootAgent = new LlmAgent({
  name: 'recommendator_agent',
  model: 'gemini-2.5-pro',
  description: 'generate recommendations for the trading bot',
  instruction: fs.readFileSync(path.resolve(process.cwd(), './recommendator-instruction.txt'), 'utf-8'),
  tools: [serverMCPToolset, sqlToolset],
});
