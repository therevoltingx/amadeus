import { useState, useEffect, useCallback } from 'react';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

const MCP_URL =
  import.meta.env.MCP_URL ||
  (import.meta.env.DEV ? '/mcp' : `${window.location.origin}/mcp`);

/**
 * MCP SDK default tool-call timeout is 60s (-32001 Request timed out). Agent chat and session
 * fetches can run much longer (LLM + SQL + tools). Override via VITE_MCP_LONG_TOOL_TIMEOUT_MS.
 */
const LONG_TOOL_TIMEOUT_MS = (() => {
  const raw = Number(import.meta.env.VITE_MCP_LONG_TOOL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 600_000;
})();

const LONG_TIMEOUT_TOOLS = new Set(['agent_run', 'agent_get_session']);

export function useMcpClient() {
  const [client, setClient] = useState<Client | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let transport: StreamableHTTPClientTransport | null = null;
    let aborted = false;

    async function connect() {
      try {
        setError(null);
        const url = new URL(MCP_URL, window.location.href);
        transport = new StreamableHTTPClientTransport(url);
        const mcpClient = new Client(
          { name: 'amadeus-ui', version: '1.0.0' },
          { capabilities: {} }
        );
        await mcpClient.connect(transport);
        if (aborted) return;
        setClient(mcpClient);
        setSessionId(transport.sessionId ?? null);
        setConnected(true);
      } catch (err) {
        if (aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setConnected(false);
      }
    }

    connect();
    return () => {
      aborted = true;
      transport?.close();
      setClient(null);
      setSessionId(null);
      setConnected(false);
    };
  }, []);

  const callTool = useCallback(
    async (name: string, args?: Record<string, unknown>) => {
      if (!client) throw new Error('MCP client not connected');
      const requestOptions = LONG_TIMEOUT_TOOLS.has(name) ? { timeout: LONG_TOOL_TIMEOUT_MS } : undefined;
      const result = await client.callTool(
        { name, arguments: args ?? {} },
        CallToolResultSchema,
        requestOptions
      );
      if (result.isError) {
        const content = result.content ?? [];
        const textContent = Array.isArray(content)
          ? content.find((c: { type?: string }) => c.type === 'text')
          : undefined;
        const rawText =
          textContent && 'text' in textContent
            ? typeof textContent.text === 'string'
              ? textContent.text
              : Array.isArray(textContent.text)
                ? (textContent.text as string[]).join('')
                : ''
            : '';
        try {
          const parsed = rawText ? JSON.parse(rawText) : null;
          const msg = parsed?.error ?? rawText ?? 'Tool returned error';
          throw new Error(typeof msg === 'string' ? msg : String(msg));
        } catch (err) {
          if (err instanceof SyntaxError) throw new Error(rawText || 'Tool returned error');
          throw err;
        }
      }
      const content = result.content ?? [];
      const textContent = Array.isArray(content)
        ? content.find((c: { type?: string }) => c.type === 'text')
        : undefined;
      let rawText: string;
      if (textContent && 'text' in textContent) {
        if (typeof textContent.text === 'string') rawText = textContent.text;
        else if (Array.isArray(textContent.text)) rawText = (textContent.text as string[]).join('');
        else if (typeof textContent.text === 'object' && textContent.text !== null) return textContent.text as unknown;
        else rawText = '';
      } else rawText = '';

      if (!rawText) throw new Error('Invalid tool response: no text content');
      try {
        return JSON.parse(rawText);
      } catch (err) {
        // For create_policy, UI doesn't use the parsed result; return success to avoid breaking the flow
        if (name === 'create_policy' || name === 'update_policy') return { success: true };
        throw new Error(
          `Invalid JSON in tool response: ${err instanceof Error ? err.message : String(err)}. Raw: ${rawText.slice(0, 200)}`
        );
      }
    },
    [client]
  );

  return { client, sessionId, error, connected, callTool };
}
