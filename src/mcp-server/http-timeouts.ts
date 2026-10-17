import type { Server as HttpServer } from 'node:http';

/**
 * Tune Node's HTTP server so long-running MCP tool handlers are not cut off.
 *
 * Node 18+ sets `requestTimeout` to 300_000 ms (5 minutes) by default. While a tool runs, the
 * connection may look "idle" until the JSON response is sent, so the server can close the socket
 * before the handler finishes. Setting `requestTimeout` to `0` disables that behavior.
 *
 * MCP clients (e.g. Cursor) apply **their own** tool-call timeouts; increase those in the IDE if
 * tools still time out after server changes.
 */
export function applyMcpHttpServerTimeouts(server: HttpServer): void {
  const reqRaw = process.env.MCP_HTTP_REQUEST_TIMEOUT_MS;
  const parsed =
    reqRaw != null && reqRaw !== '' ? Number(reqRaw) : 0;
  const requestMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  server.requestTimeout = requestMs;

  const headersRaw = process.env.MCP_HTTP_HEADERS_TIMEOUT_MS;
  if (headersRaw != null && headersRaw !== '') {
    const headersMs = Number(headersRaw);
    if (Number.isFinite(headersMs) && headersMs >= 0) {
      server.headersTimeout = headersMs;
    }
  }

  const keepRaw = process.env.MCP_HTTP_KEEP_ALIVE_TIMEOUT_MS;
  if (keepRaw != null && keepRaw !== '') {
    const keepMs = Number(keepRaw);
    if (Number.isFinite(keepMs) && keepMs >= 0) {
      server.keepAliveTimeout = keepMs;
    }
  }
}
