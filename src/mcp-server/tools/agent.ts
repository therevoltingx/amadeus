import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, strMin1 } from '../schema.js';

const AGENT_BASE_URL = (process.env.AGENT_API_URL ?? '').replace(/\/$/, '');

export async function getAgentStatus(): Promise<{
  connected: boolean;
  reason?: string;
  apps?: string[];
  message?: string;
  status?: number;
}> {
  if (!AGENT_BASE_URL) {
    return { connected: false, reason: 'not_configured' };
  }
  try {
    const response = await fetch(`${AGENT_BASE_URL}/list-apps`);
    if (!response.ok) {
      return { connected: false, reason: 'bad_response', status: response.status };
    }
    const apps = (await response.json()) as string[];
    return { connected: true, apps: Array.isArray(apps) ? apps : [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { connected: false, reason: 'error', message };
  }
}

export async function getAgentSessions(
  appName: string,
  userId: string
): Promise<{ sessions: string[] }> {
  if (!AGENT_BASE_URL || !appName?.trim()) {
    return { sessions: [] };
  }
  try {
    const listUrl = `${AGENT_BASE_URL}/apps/${encodeURIComponent(appName)}/users/${encodeURIComponent(userId)}/sessions`;
    const response = await fetch(listUrl);
    if (!response.ok) return { sessions: [] };
    const data = (await response.json()) as { sessions?: { id: string }[] } | string[];
    const raw = Array.isArray(data) ? data : (data as { sessions?: { id: string }[] }).sessions ?? [];
    const sessions = Array.isArray(raw)
      ? raw.map((s) => (typeof s === 'string' ? s : (s as { id: string }).id))
      : [];
    return { sessions };
  } catch {
    return { sessions: [] };
  }
}

export async function createAgentSession(params: {
  appName?: string;
  userId?: string;
  sessionId?: string;
}): Promise<{ id: string; appName: string; userId: string } | { error: string; status?: number }> {
  if (!AGENT_BASE_URL) {
    return { error: 'Agent API not configured', status: 503 };
  }
  const appName = params?.appName?.trim();
  const userId = (params?.userId?.trim() ?? 'default') || 'default';
  const sessionId =
    params?.sessionId?.trim() || `s_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
  if (!appName) {
    return { error: 'appName required', status: 400 };
  }
  try {
    const createUrl = `${AGENT_BASE_URL}/apps/${encodeURIComponent(appName)}/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}`;
    const response = await fetch(createUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      const text = await response.text();
      return { error: text || 'Failed to create session', status: response.status };
    }
    const session = (await response.json()) as { id: string };
    return { id: session?.id ?? sessionId, appName, userId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message, status: 502 };
  }
}

/** ADK session/run events; `timestamp` is creation time (epoch ms per ADK docs). */
export type SessionEvent = {
  id?: string;
  /** Epoch milliseconds from the Agent API (ADK Event). */
  timestamp?: number;
  content?: { role?: string; parts?: { text?: string }[] };
  author?: string;
};

export async function getAgentSession(params: {
  appName: string;
  userId: string;
  sessionId: string;
}): Promise<{ events: SessionEvent[] } | { error: string; status?: number }> {
  if (!AGENT_BASE_URL) {
    return { error: 'Agent API not configured', status: 503 };
  }
  const appName = params.appName?.trim();
  const userId = (params.userId?.trim() ?? 'default') || 'default';
  const sessionId = params.sessionId?.trim();
  if (!appName || !sessionId) {
    return { error: 'appName and sessionId required', status: 400 };
  }
  try {
    const url = `${AGENT_BASE_URL}/apps/${encodeURIComponent(appName)}/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}`;
    const response = await fetch(url);
    if (!response.ok) {
      const text = await response.text();
      return { error: text || `HTTP ${response.status}`, status: response.status };
    }
    const session = (await response.json()) as { events?: SessionEvent[] };
    const events = Array.isArray(session?.events) ? session.events : [];
    return { events };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message, status: 502 };
  }
}

export async function deleteAgentSession(params: {
  appName: string;
  userId: string;
  sessionId: string;
}): Promise<{ ok: true } | { error: string; status?: number }> {
  if (!AGENT_BASE_URL) {
    return { error: 'Agent API not configured', status: 503 };
  }
  const appName = params.appName?.trim();
  const userId = (params.userId?.trim() ?? 'default') || 'default';
  const sessionId = params.sessionId?.trim();
  if (!appName || !sessionId) {
    return { error: 'appName and sessionId required', status: 400 };
  }
  try {
    const url = `${AGENT_BASE_URL}/apps/${encodeURIComponent(appName)}/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}`;
    const response = await fetch(url, { method: 'DELETE' });
    if (!response.ok) {
      const text = await response.text();
      return { error: text || `HTTP ${response.status}`, status: response.status };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message, status: 502 };
  }
}

type RunEvent = {
  id?: string;
  /** Epoch milliseconds from the Agent API (ADK Event). */
  timestamp?: number;
  content?: { role?: string; parts?: { text?: string }[] };
  author?: string;
};

/**
 * Call ADK /run_sse to receive all events via Server-Sent Events, then return them as a single array.
 * Using SSE ensures we collect every event the backend sends (multiple model turns, tool calls, etc.).
 */
export async function runAgent(params: {
  appName: string;
  userId: string;
  sessionId: string;
  text: string;
}): Promise<{ events: RunEvent[] } | { error: string; status?: number }> {
  if (!AGENT_BASE_URL) {
    return { error: 'Agent API not configured', status: 503 };
  }
  const { appName, userId, sessionId, text } = params;
  if (!appName?.trim() || !sessionId?.trim()) {
    return { error: 'appName and sessionId required', status: 400 };
  }
  try {
    const response = await fetch(`${AGENT_BASE_URL}/run_sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        appName: appName.trim(),
        userId: (userId?.trim() ?? 'default') || 'default',
        sessionId: sessionId.trim(),
        newMessage: {
          role: 'user',
          parts: [{ text: text.trim() || '' }],
        },
        streaming: false,
      }),
    });
    if (!response.ok) {
      const errText = await response.text();
      return { error: errText || `HTTP ${response.status}`, status: response.status };
    }
    const contentType = response.headers.get('content-type') ?? '';
    const events: RunEvent[] = [];

    if (contentType.includes('text/event-stream')) {
      const reader = response.body?.getReader();
      if (!reader) {
        return { error: 'No response body', status: 502 };
      }
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (line.startsWith('data:')) {
              const json = line.slice(5).trim();
              if (json === '[DONE]' || json === '') continue;
              try {
                const event = JSON.parse(json) as RunEvent;
                events.push(event);
              } catch {
                // ignore unparseable lines
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    } else {
      // fallback: non-streaming response (e.g. some servers return JSON array directly)
      const data = (await response.json()) as RunEvent[] | { events?: RunEvent[] };
      const list = Array.isArray(data) ? data : data?.events ?? [];
      events.push(...list);
    }

    return { events };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message, status: 502 };
  }
}

export function registerAgentTools(server: McpServer): void {
  server.registerTool(
    'agent_get_status',
    {
      description: 'Check connection status to the agent REST API (list-apps).',
      inputSchema: z.object({}),
    },
    async () => {
      const data = await getAgentStatus();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'agent_list_sessions',
    {
      description: 'List session IDs for an app (agent) and user.',
      inputSchema: z.object({
        appName: strMin1(),
        userId: z.optional(z.string()),
      }),
    },
    async (input) => {
      const userId = (input.userId ?? 'default').trim() || 'default';
      const data = await getAgentSessions(input.appName, userId);
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
    }
  );

  server.registerTool(
    'agent_create_session',
    {
      description: 'Create a new agent session. Returns id, appName, userId.',
      inputSchema: z.object({
        appName: strMin1(),
        userId: z.optional(z.string()),
        sessionId: z.optional(z.string()),
      }),
    },
    async (input) => {
      const result = await createAgentSession({
        appName: input.appName,
        userId: input.userId,
        sessionId: input.sessionId,
      });
      const text = 'error' in result ? JSON.stringify({ error: result.error, status: result.status }) : JSON.stringify(result);
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  server.registerTool(
    'agent_get_session',
    {
      description: 'Get a session including its event history (ADK GET session). Returns { events } for building chat history.',
      inputSchema: z.object({
        appName: strMin1(),
        userId: z.optional(z.string()),
        sessionId: strMin1(),
      }),
    },
    async (input) => {
      const result = await getAgentSession({
        appName: input.appName,
        userId: input.userId ?? 'default',
        sessionId: input.sessionId,
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    }
  );

  server.registerTool(
    'agent_delete_session',
    {
      description: 'Delete an agent session. Requires appName, userId (optional), and sessionId.',
      inputSchema: z.object({
        appName: strMin1(),
        userId: z.optional(z.string()),
        sessionId: strMin1(),
      }),
    },
    async (input) => {
      const result = await deleteAgentSession({
        appName: input.appName,
        userId: input.userId ?? 'default',
        sessionId: input.sessionId,
      });
      const text = 'error' in result ? JSON.stringify({ error: result.error, status: result.status }) : JSON.stringify(result);
      return { content: [{ type: 'text' as const, text }] };
    }
  );

  server.registerTool(
    'agent_run',
    {
      description: 'Send a message to an agent session and get the run events (ADK /run). Use events to extract model text from content.parts[].text where role is model.',
      inputSchema: z.object({
        appName: strMin1(),
        userId: z.optional(z.string()),
        sessionId: strMin1(),
        text: z.string(),
      }),
    },
    async (input) => {
      const result = await runAgent({
        appName: input.appName,
        userId: input.userId ?? 'default',
        sessionId: input.sessionId,
        text: input.text ?? '',
      });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    }
  );
}
