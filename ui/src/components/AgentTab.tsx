import { useState, useEffect, useCallback, useRef } from 'react';
import { useMcpClient } from '../hooks/useMcpClient';
import './AgentTab.css';

const AGENT_USER_ID = 'default';
const SESSIONS_STORAGE_KEY = 'amadeus_agent_sessions';
const MAIN_CHAT_SESSION_ID = 'main_chat';
/** Session id for the agent chat (optimizer or recommendator when API server is run with that entry point). */
const TRADING_WORKER_SESSION_ID = 'trading_worker';
/** Same session id as optimizer-agent-worker; UI and worker share this session for the optimizer agent. */
const OPTIMIZER_WORKER_SESSION_ID = 'optimizer_worker';

function isTradingAgent(appName: string): boolean {
  return appName === 'trading-agent' || appName === 'trading_agent';
}

function isOptimizerAgent(appName: string): boolean {
  return appName === 'optimizer-agent' || appName === 'optimizer_agent';
}

/** ADK `/list-apps` may use the entry filename or `LlmAgent.name` — treat these as the recommendator chatbot. */
const RECOMMENDING_APP_ALIASES = ['recommending-agent', 'recommending_agent', 'recommendator_agent'] as const;

/** Prefer the recommendator when the prior selection is missing (e.g. reconnect); avoids defaulting to `appList[0]` (often optimizer). */
function pickDefaultChatbotAgent(appList: string[], previous: string): string {
  if (appList.length === 0) return '';
  if (previous && appList.includes(previous)) return previous;
  for (const name of RECOMMENDING_APP_ALIASES) {
    if (appList.includes(name)) return name;
  }
  return appList[0] ?? '';
}

export type SessionEntry = { id: string; displayName: string };

export type ChatMessage = {
  id: string;
  role: 'user' | 'model';
  text: string;
  /** Unix seconds from ADK Event.timestamp when available. */
  timestamp?: number | null;
};

/** Normalize ADK Event.timestamp (epoch ms, seconds, or ISO string) to unix seconds. */
function parseAdkEventTimestamp(ev: { timestamp?: unknown }): number | null {
  const raw = ev.timestamp;
  if (raw == null) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // ADK uses epoch ms; values ~1e12+ are ms, smaller values treated as seconds
    return raw > 1e11 ? Math.floor(raw / 1000) : Math.floor(raw);
  }
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  return null;
}

function formatMessageTime(ts: number | null | undefined): string | null {
  if (ts == null) return null;
  return new Date(ts * 1000).toLocaleString();
}

function extractModelTextFromEvents(events: { content?: { role?: string; parts?: { text?: string }[] } }[]): string {
  const parts: string[] = [];
  for (const ev of events) {
    if (ev.content?.role !== 'model' || !Array.isArray(ev.content.parts)) continue;
    for (const p of ev.content.parts) {
      if (typeof p?.text === 'string' && p.text.trim()) parts.push(p.text.trim());
    }
  }
  return parts.join('\n\n') || '';
}

/** Extract one chat message per model event from run events, so multiple backend responses show as multiple bubbles. */
function runEventsToModelMessages(
  events: { id?: string; timestamp?: unknown; content?: { role?: string; parts?: { text?: string }[] } }[]
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const ev of events) {
    if (ev.content?.role !== 'model' || !Array.isArray(ev.content.parts)) continue;
    const text = ev.content.parts
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n\n')
      .trim();
    if (!text) continue;
    const ts = parseAdkEventTimestamp(ev);
    out.push({
      id: ev.id ?? `m-${out.length}-${Date.now()}`,
      role: 'model',
      text,
      timestamp: ts,
    });
  }
  return out;
}

function eventsToChatMessages(
  events: { id?: string; timestamp?: unknown; content?: { role?: string; parts?: { text?: string }[] } }[]
): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const ev of events) {
    const role = ev.content?.role;
    if (role !== 'user' && role !== 'model') continue;
    const parts = ev.content?.parts;
    if (!Array.isArray(parts)) continue;
    const text = parts
      .map((p) => (typeof p?.text === 'string' ? p.text : ''))
      .filter(Boolean)
      .join('\n\n')
      .trim();
    if (!text) continue;
    const ts = parseAdkEventTimestamp(ev);
    out.push({
      id: ev.id ?? `ev-${out.length}-${Date.now()}`,
      role: role as 'user' | 'model',
      text,
      timestamp: ts,
    });
  }
  return out;
}

function getStoredSessions(appName: string): SessionEntry[] {
  try {
    const raw = localStorage.getItem(SESSIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Record<string, (SessionEntry | string)[]>;
    const list = parsed[appName];
    if (!Array.isArray(list)) return [];
    return list.map((s): SessionEntry => {
      if (typeof s === 'string') return { id: s, displayName: s };
      const id = s?.id ?? '';
      return { id, displayName: s?.displayName ?? id };
    });
  } catch {
    return [];
  }
}

function addStoredSession(appName: string, sessionId: string, displayName: string): void {
  try {
    const raw = localStorage.getItem(SESSIONS_STORAGE_KEY);
    const parsed: Record<string, SessionEntry[]> = raw ? JSON.parse(raw) : {};
    const list = Array.isArray(parsed[appName]) ? parsed[appName] : [];
    if (!list.some((s) => s.id === sessionId)) list.push({ id: sessionId, displayName });
    parsed[appName] = list;
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(parsed));
  } catch {}
}

function removeStoredSession(appName: string, sessionId: string): void {
  try {
    const raw = localStorage.getItem(SESSIONS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, SessionEntry[]>;
    const list = (parsed[appName] ?? []).filter((s) => s.id !== sessionId);
    if (list.length === 0) delete parsed[appName];
    else parsed[appName] = list;
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(parsed));
  } catch {}
}

type AgentStatus = 'checking' | 'connected' | 'disconnected' | 'not_configured';

/**
 * Agent tab: chat with the recommendator agent via MCP tools (get_config, agent_get_status, agent_list_sessions, agent_create_session).
 * Agent API URL is configured via AGENT_API_URL in the server .env.
 */
export function AgentTab() {
  const { callTool, connected: mcpConnected } = useMcpClient();
  const [status, setStatus] = useState<AgentStatus>('checking');
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [apps, setApps] = useState<string[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string>('recommending-agent');
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string>('');
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [createSessionLoading, setCreateSessionLoading] = useState(false);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  const checkStatus = useCallback(async () => {
    if (!mcpConnected) return;
    try {
      const config = (await callTool('get_config')) as { agentApiUrl?: string };
      const agentApiUrlVal = config?.agentApiUrl ?? '';
      if (!agentApiUrlVal.trim()) {
        setStatus('not_configured');
        setStatusMessage('Set AGENT_API_URL in server .env');
        setApps([]);
        setSelectedAgent('');
        return;
      }
      const data = (await callTool('agent_get_status')) as {
        connected: boolean;
        reason?: string;
        apps?: string[];
        message?: string;
        status?: number;
      };
      if (data.connected) {
        setStatus('connected');
        const appList = Array.isArray(data.apps) ? data.apps : [];
        setApps(appList);
        setStatusMessage(
          appList.length ? `Connected (${appList.length} app(s))` : 'Connected'
        );
        setSelectedAgent((prev) => pickDefaultChatbotAgent(appList, prev));
      } else {
        setApps([]);
        setSelectedAgent('');
        setStatus('disconnected');
        if (data.reason === 'not_configured') {
          setStatus('not_configured');
          setStatusMessage('Set AGENT_API_URL in server .env');
        } else if (data.message) {
          setStatusMessage(data.message);
        } else if (data.reason === 'bad_response' && data.status) {
          setStatusMessage(`HTTP ${data.status}`);
        } else {
          setStatusMessage('Unreachable');
        }
      }
    } catch {
      setApps([]);
      setSelectedAgent('');
      setStatus('disconnected');
      setStatusMessage('Request failed');
    }
  }, [mcpConnected, callTool]);

  useEffect(() => {
    if (!mcpConnected) {
      setStatus('disconnected');
      setStatusMessage('MCP not connected');
      setApps([]);
      setSelectedAgent('');
      return;
    }
    setStatus('checking');
    setStatusMessage('');
    checkStatus();
    const interval = setInterval(checkStatus, 15_000);
    return () => clearInterval(interval);
  }, [mcpConnected, checkStatus]);

  const createSession = useCallback(
    async (displayName: string, suggestedSessionId?: string): Promise<boolean> => {
      if (!selectedAgent.trim() || createSessionLoading) return false;
      setCreateSessionLoading(true);
      try {
        const args: { appName: string; userId: string; sessionId?: string } = {
          appName: selectedAgent,
          userId: AGENT_USER_ID,
        };
        if (suggestedSessionId) args.sessionId = suggestedSessionId;
        const data = (await callTool('agent_create_session', args)) as
          | { id: string; appName: string; userId: string }
          | { error: string; status?: number };
        if (data && 'error' in data) {
          throw new Error(data.error ?? 'Failed to create session');
        }
        const id = (data as { id: string })?.id ?? suggestedSessionId ?? '';
        if (id) {
          addStoredSession(selectedAgent, id, displayName.trim() || id);
          setSessions((prev) => (prev.some((s) => s.id === id) ? prev : [...prev, { id, displayName: displayName.trim() || id }]));
          setSelectedSessionId(id);
          return true;
        }
        return false;
      } catch (err) {
        console.error('Create session failed:', err);
        return false;
      } finally {
        setCreateSessionLoading(false);
      }
    },
    [selectedAgent, createSessionLoading, callTool]
  );

  const fetchSessions = useCallback(async () => {
    if (!selectedAgent.trim()) {
      setSessions([]);
      return;
    }
    setSessionsLoading(true);
    try {
      const data = (await callTool('agent_list_sessions', {
        appName: selectedAgent,
        userId: AGENT_USER_ID,
      })) as { sessions?: string[] };
      const fromApi = Array.isArray(data.sessions) ? data.sessions : [];
      const fromStorage = getStoredSessions(selectedAgent);
      const displayByNameId = new Map<string, string>();
      for (const s of fromStorage) displayByNameId.set(s.id, s.displayName);
      const merged: SessionEntry[] = fromApi.map((id) => {
        const stored = displayByNameId.get(id);
        if (stored) return { id, displayName: stored };
        if (isTradingAgent(selectedAgent) && id === TRADING_WORKER_SESSION_ID) {
          addStoredSession(selectedAgent, id, 'Trading (shared with worker)');
          return { id, displayName: 'Trading (shared with worker)' };
        }
        if (isOptimizerAgent(selectedAgent) && id === OPTIMIZER_WORKER_SESSION_ID) {
          addStoredSession(selectedAgent, id, 'Optimizer (shared with worker)');
          return { id, displayName: 'Optimizer (shared with worker)' };
        }
        return { id, displayName: id };
      });
      const apiSet = new Set(fromApi);
      const prunedStorage = fromStorage.filter((s) => apiSet.has(s.id));
      if (prunedStorage.length !== fromStorage.length) {
        try {
          const raw = localStorage.getItem(SESSIONS_STORAGE_KEY);
          const parsed: Record<string, SessionEntry[]> = raw ? JSON.parse(raw) : {};
          parsed[selectedAgent] = prunedStorage;
          localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(parsed));
        } catch {}
      }
      setSessions(merged);
      setSelectedSessionId((prev) => (fromApi.includes(prev) ? prev : merged[0]?.id ?? ''));
      if (merged.length === 0) {
        const defaultSessionId = isTradingAgent(selectedAgent)
          ? TRADING_WORKER_SESSION_ID
          : isOptimizerAgent(selectedAgent)
            ? OPTIMIZER_WORKER_SESSION_ID
            : MAIN_CHAT_SESSION_ID;
        const defaultDisplayName = isTradingAgent(selectedAgent)
          ? 'Trading (shared with worker)'
          : isOptimizerAgent(selectedAgent)
            ? 'Optimizer (shared with worker)'
            : 'Main Chat';
        await createSession(defaultDisplayName, defaultSessionId);
      }
    } catch {
      setSessions([]);
      setSelectedSessionId('');
    } finally {
      setSessionsLoading(false);
    }
  }, [selectedAgent, createSession, callTool]);

  useEffect(() => {
    if (status === 'connected' && selectedAgent) fetchSessions();
    else setSessions([]);
  }, [status, selectedAgent, fetchSessions]);

  const handleNewSession = useCallback(() => {
    const name = window.prompt('Session name:');
    if (name == null) return;
    createSession(name.trim() || 'New session');
  }, [createSession]);

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      if (!selectedAgent) return;
      if (!window.confirm('Delete this session? This cannot be undone.')) return;
      setDeletingSessionId(sessionId);
      try {
        const result = (await callTool('agent_delete_session', {
          appName: selectedAgent,
          userId: AGENT_USER_ID,
          sessionId,
        })) as { ok?: boolean } | { error?: string };
        if (result && 'error' in result) {
          console.error('Delete session failed:', result.error);
          return;
        }
        removeStoredSession(selectedAgent, sessionId);
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        if (selectedSessionId === sessionId) {
          const remaining = sessions.filter((s) => s.id !== sessionId);
          setSelectedSessionId(remaining[0]?.id ?? '');
        }
      } finally {
        setDeletingSessionId(null);
      }
    },
    [selectedAgent, selectedSessionId, sessions, callTool]
  );

  useEffect(() => {
    if (!selectedAgent || !selectedSessionId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setHistoryLoading(true);
    setMessages([]);
    (async () => {
      try {
        const result = (await callTool('agent_get_session', {
          appName: selectedAgent,
          userId: AGENT_USER_ID,
          sessionId: selectedSessionId,
        })) as {
          events?: { id?: string; timestamp?: unknown; content?: { role?: string; parts?: { text?: string }[] } }[];
        } | { error?: string };
        if (cancelled) return;
        if (result && 'error' in result) {
          setMessages([]);
          return;
        }
        const events =
          (result as { events?: { id?: string; timestamp?: unknown; content?: { role?: string; parts?: { text?: string }[] } }[] })?.events ??
          [];
        setMessages(eventsToChatMessages(events));
      } catch {
        if (!cancelled) setMessages([]);
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedSessionId, selectedAgent, callTool]);

  useEffect(() => {
    chatScrollRef.current?.scrollTo(0, chatScrollRef.current.scrollHeight);
  }, [messages]);

  const sendMessage = useCallback(async () => {
    const text = inputText.trim();
    if (!text || !selectedAgent || !selectedSessionId || sending) return;
    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      text,
      timestamp: null,
    };
    setMessages((prev) => [...prev, userMsg]);
    setInputText('');
    setSending(true);
    try {
      const result = (await callTool('agent_run', {
        appName: selectedAgent,
        userId: AGENT_USER_ID,
        sessionId: selectedSessionId,
        text,
      })) as {
        events?: { id?: string; timestamp?: unknown; content?: { role?: string; parts?: { text?: string }[] } }[];
      } | { error?: string };
      if (result && 'error' in result) {
        setMessages((prev) => [
          ...prev,
          {
            id: `m-${Date.now()}`,
            role: 'model',
            text: `Error: ${result.error ?? 'Unknown error'}`,
            timestamp: null,
          },
        ]);
        return;
      }
      const events =
        (result as {
          events?: { id?: string; timestamp?: unknown; content?: { role?: string; parts?: { text?: string }[] } }[];
        })?.events ?? [];
      const turn = eventsToChatMessages(events);
      setMessages((prev) => {
        const p = [...prev];
        const last = p[p.length - 1];
        if (
          last?.role === 'user' &&
          last.text.trim() === text &&
          turn.length > 0 &&
          turn[0]?.role === 'user' &&
          turn[0].text.trim() === text
        ) {
          p[p.length - 1] = { ...turn[0], id: turn[0].id || last.id };
          return [...p, ...turn.slice(1)];
        }
        const modelMessages = runEventsToModelMessages(events);
        if (modelMessages.length > 0) {
          return [...p, ...modelMessages];
        }
        const fallbackText = extractModelTextFromEvents(events) || '(No response)';
        const lastEv = events[events.length - 1];
        return [
          ...p,
          {
            id: `m-${Date.now()}`,
            role: 'model',
            text: fallbackText,
            timestamp: lastEv ? parseAdkEventTimestamp(lastEv) : null,
          },
        ];
      });
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `m-${Date.now()}`,
          role: 'model',
          text: `Error: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: null,
        },
      ]);
    } finally {
      setSending(false);
    }
  }, [inputText, selectedAgent, selectedSessionId, sending, callTool]);

  const canChat = status === 'connected' && !!selectedAgent && !!selectedSessionId;

  return (
    <div className="agent-tab">
      <header className="agent-tab-header">
        <h2>Chatbot</h2>
        <div className="agent-status">
          {status === 'checking' && <span>Checking…</span>}
          {status === 'connected' && (
            <span className="status-ok" title={statusMessage}>
              Connected to Agent Server
            </span>
          )}
          {(status === 'disconnected' || status === 'not_configured') && (
            <span className="status-error" title={statusMessage}>
              Agent: {statusMessage || (status === 'not_configured' ? 'Not configured' : 'Disconnected')}
            </span>
          )}
        </div>
      </header>
      <div className="agent-tab-body">
        {status === 'connected' && (
          <div className="agent-tab-sidebar">
            <aside className="agent-tab-panel agent-tab-agent-panel">
              <h3 className="agent-tab-panel-title">Agent</h3>
              <select
                className="agent-tab-agents-select"
                value={selectedAgent}
                onChange={(e) => setSelectedAgent(e.target.value)}
                disabled={apps.length === 0}
                aria-label="Agents"
              >
                <option value="">
                  {apps.length === 0 ? 'No agents' : 'Select an agent'}
                </option>
                {apps.map((app) => (
                  <option key={app} value={app}>
                    {app}
                  </option>
                ))}
              </select>
            </aside>
            <aside className="agent-tab-panel agent-tab-sessions-panel">
              <h3 className="agent-tab-panel-title">Sessions</h3>
              {!selectedAgent ? (
                <p className="agent-tab-sessions-message">Select an agent above</p>
              ) : sessionsLoading ? (
                <p className="agent-tab-sessions-message">Loading…</p>
              ) : (
                <>
                  <ul className="agent-tab-sessions-list" aria-label="Sessions">
                    {(sessions ?? []).map((s) => {
                      const id = s?.id ?? '';
                      const displayName = s?.displayName ?? id;
                      return (
                        <li key={id} className="agent-tab-session-row">
                          <button
                            type="button"
                            className={`agent-tab-session-btn ${selectedSessionId === id ? 'selected' : ''}`}
                            onClick={() => setSelectedSessionId(id)}
                            title={displayName !== id ? `${displayName} (${id})` : id}
                          >
                            {displayName.length > 24 ? `${displayName.slice(0, 22)}…` : displayName}
                          </button>
                          <button
                            type="button"
                            className="agent-tab-session-delete-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteSession(id);
                            }}
                            disabled={deletingSessionId === id}
                            title="Delete session"
                            aria-label={`Delete session ${displayName}`}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                              <line x1="10" y1="11" x2="10" y2="17" />
                              <line x1="14" y1="11" x2="14" y2="17" />
                            </svg>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  <button
                    type="button"
                    className="agent-tab-new-session-btn"
                    onClick={handleNewSession}
                    disabled={createSessionLoading}
                  >
                    {createSessionLoading ? 'Creating…' : 'New session'}
                  </button>
                </>
              )}
            </aside>
          </div>
        )}
        <section className="agent-tab-main">
          {canChat ? (
            <div className="agent-tab-chat">
              <div
                className="agent-tab-chat-messages"
                ref={chatScrollRef}
                role="log"
                aria-live="polite"
              >
                {historyLoading && (
                  <p className="agent-tab-chat-empty">Loading history…</p>
                )}
                {!historyLoading && messages.length === 0 && (
                  <p className="agent-tab-chat-empty">Send a message to start the conversation.</p>
                )}
                {messages.map((msg) => {
                  const timeLabel = formatMessageTime(msg.timestamp);
                  return (
                    <div
                      key={msg.id}
                      className={`agent-tab-chat-bubble agent-tab-chat-bubble--${msg.role}`}
                    >
                      <div className="agent-tab-chat-bubble-header">
                        <span className="agent-tab-chat-bubble-role">
                          {msg.role === 'user' ? 'You' : 'Agent'}
                        </span>
                        {timeLabel != null && (
                          <time
                            className="agent-tab-chat-bubble-time"
                            dateTime={new Date((msg.timestamp as number) * 1000).toISOString()}
                          >
                            {timeLabel}
                          </time>
                        )}
                      </div>
                      <div className="agent-tab-chat-bubble-text">{msg.text}</div>
                    </div>
                  );
                })}
                {sending && (
                  <div className="agent-tab-chat-bubble agent-tab-chat-bubble--model">
                    <div className="agent-tab-chat-bubble-header">
                      <span className="agent-tab-chat-bubble-role">Agent</span>
                    </div>
                    <div className="agent-tab-chat-bubble-text agent-tab-chat-typing">
                      Thinking…
                    </div>
                  </div>
                )}
              </div>
              <form
                className="agent-tab-chat-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  sendMessage();
                }}
              >
                <textarea
                  className="agent-tab-chat-input"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                  placeholder="Type a message…"
                  rows={2}
                  disabled={sending}
                  aria-label="Message"
                />
                <button
                  type="submit"
                  className="agent-tab-chat-send"
                  disabled={sending || !inputText.trim()}
                >
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </form>
            </div>
          ) : (
            <div className="agent-tab-placeholder">
              <p>Select an agent and a session to chat.</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
