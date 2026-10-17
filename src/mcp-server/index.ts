import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerAllTools } from './tools/index.js';
import { createApp } from './routes.js';
import { applyMcpHttpServerTimeouts } from './http-timeouts.js';

const PORT = process.env.PORT ?? 3000;
const MCP_BIND_ADDRESS = process.env.MCP_BIND_ADDRESS ?? '127.0.0.1';
const MCP_ALLOWED_ORIGINS = process.env.MCP_ALLOWED_ORIGINS
  ? process.env.MCP_ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : undefined;

const server = new McpServer(
  { name: 'amadeus', version: '1.0.0' },
  { capabilities: { tools: { listChanged: false } } }
);

registerAllTools(server);

const transport = new StreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableJsonResponse: true,
  enableDnsRebindingProtection: !!MCP_ALLOWED_ORIGINS?.length,
  allowedOrigins: MCP_ALLOWED_ORIGINS?.length ? MCP_ALLOWED_ORIGINS : undefined,
});
transport.onerror = (err: Error) => {
  const msg = err.message;
  if (msg.startsWith('Invalid Origin header:')) {
    const origin = msg.slice('Invalid Origin header:'.length).trim();
    console.error(`[mcp-server] invalid origin rejected: ${origin}`);
  } else if (msg.startsWith('Invalid Host header:')) {
    const host = msg.slice('Invalid Host header:'.length).trim();
    console.error(`[mcp-server] invalid host rejected: ${host}`);
  }
};

server.connect(transport);

const app = createApp(transport);
const httpServer = app.listen(Number(PORT), MCP_BIND_ADDRESS, () => {
  console.error(`[mcp-server] MCP server listening on http://${MCP_BIND_ADDRESS}:${PORT}/mcp (Streamable HTTP)`);
});
applyMcpHttpServerTimeouts(httpServer);
