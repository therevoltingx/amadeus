import express from 'express';
import cors from 'cors';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

function logMcpError(method: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(`[mcp-server] ${method} error: ${msg}`);
  if (stack) console.error(stack);
}

export function createApp(transport: StreamableHTTPServerTransport): express.Express {
  const app = express();
  app.use(cors({ origin: true }));
  app.use(express.json());

  app.use('/mcp', (req, res, next) => {
    const method = (req.method || '').toUpperCase();
    const start = Date.now();
    console.error(`[mcp-server] ${method} /mcp`);
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.error(`[mcp-server] ${method} /mcp → ${res.statusCode} (${duration}ms)`);
    });
    next();
  });

  app.use('/mcp', (req, res, next) => {
    const method = (req.method || '').toUpperCase();
    if (method === 'GET' || method === 'POST') return next();
    res.setHeader('Allow', 'GET, POST');
    res.status(405).send('Method Not Allowed');
  });

  app.post('/mcp', async (req, res) => {
    try {
      await transport.handleRequest(req as never, res as never, req.body);
    } catch (err) {
      logMcpError('POST', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  app.get('/mcp', async (req, res) => {
    try {
      await transport.handleRequest(req as never, res as never);
    } catch (err) {
      logMcpError('GET', err);
      if (!res.headersSent) res.status(500).send('Internal server error');
    }
  });

  return app;
}
