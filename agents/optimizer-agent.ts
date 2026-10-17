import { LlmAgent, MCPToolset, type ToolUnion } from '@google/adk';
import { ToolboxClient } from '@toolbox-sdk/adk';
import * as path from 'path';
import * as fs from 'fs';

const toolboxClient = new ToolboxClient(process.env.MCP_TOOLBOX_URL as string);

const toolboxToolset = {
  getTools: async () => await toolboxClient.loadToolset(),
} as unknown as ToolUnion;

const mcpToolset = new MCPToolset({
  type: 'StreamableHTTPConnectionParams',
  url: process.env.MCP_SERVER_URL as string,
});

export const rootAgent = new LlmAgent({
  name: 'optimizer_agent',
  model: 'gemini-2.5-flash-lite',
  description:
    'Optimizer agent: auto-optimizes active policies with Auto Optimize enabled. Uses SQLite (MCP Toolbox), Amadeus MCP, and direct access to DexScreener/DexTools (web fetch) for analytics. Prefers own SQL over backtests; uses linked_policy_id to follow policy history.',
  instruction: fs.readFileSync(path.resolve(process.cwd(), './optimizer-instruction.txt'), 'utf-8'),
  tools: [mcpToolset, toolboxToolset],
});
