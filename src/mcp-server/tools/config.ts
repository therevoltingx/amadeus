import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from '../schema.js';

import {
  isLiveTradingEnabled,
  isLiveExecutionDryRun,
  getSolanaRpcUrl,
  getSolanaPrivateKeyRaw,
} from '../../config.js';

export interface LiveTradingOptions {
  live_trading_enabled: boolean;
  live_execution_dry_run: boolean;
  solana_rpc_configured: boolean;
  solana_signer_configured: boolean;
}

export function getConfig(): {
  agentApiUrl: string;
  live_trading_enabled: boolean;
  live_trading_options: LiveTradingOptions;
} {
  return {
    agentApiUrl: process.env.AGENT_API_URL ?? '',
    live_trading_enabled: isLiveTradingEnabled(),
    live_trading_options: {
      live_trading_enabled: isLiveTradingEnabled(),
      live_execution_dry_run: isLiveExecutionDryRun(),
      solana_rpc_configured: !!getSolanaRpcUrl(),
      solana_signer_configured: !!getSolanaPrivateKeyRaw(),
    },
  };
}

export function registerConfigTools(server: McpServer): void {
  server.registerTool(
    'get_config',
    {
      description: 'Get API configuration (e.g. agentApiUrl for the agent service).',
      inputSchema: z.object({}),
    },
    async () => {
      const data = getConfig();
      return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] };
    }
  );
}
