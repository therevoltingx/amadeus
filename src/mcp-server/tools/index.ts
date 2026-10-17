import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPairsTools } from './pairs.js';
import { registerSnapshotsTools } from './snapshots.js';
import { registerTradesTools } from './trades.js';
import { registerAnalyticsTools } from './analytics.js';
import { registerDecisionsTools } from './decisions.js';
import { registerAccountTools } from './account.js';
import { registerRecommendationsTools } from './recommendations.js';
import { registerBacktestTools } from './backtest.js';
import { registerPoliciesTools } from './policies.js';
import { registerConfigTools } from './config.js';
import { registerAgentTools } from './agent.js';
import { registerDeploymentsTools } from './deployments.js';

export function registerAllTools(server: McpServer): void {
  registerPairsTools(server);
  registerSnapshotsTools(server);
  registerTradesTools(server);
  registerAnalyticsTools(server);
  registerDecisionsTools(server);
  registerAccountTools(server);
  registerRecommendationsTools(server);
  registerBacktestTools(server);
  registerPoliciesTools(server);
  registerConfigTools(server);
  registerAgentTools(server);
  registerDeploymentsTools(server);
}
