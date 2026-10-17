import { isLiveTradingEnabled } from '../config.js';
import type { AccountForExecutor, ChainExecutor, ExecutionOrder, ExecuteOrderResult } from './types.js';
import { paperExecutor } from './paper.js';
import { solanaExecutor } from './solana.js';
import { evmExecutor } from './evm.js';

export type { AccountForExecutor, ExecutionOrder, ExecuteOrderResult };

const CHAIN_EXECUTORS: Record<string, ChainExecutor> = {
  paper: paperExecutor,
  solana: solanaExecutor,
  ethereum: evmExecutor,
  evm: evmExecutor,
};

/**
 * Resolver: returns the executor for the account. Paper mode always uses paper executor;
 * live mode uses the chain-specific executor. Throws if no executor is registered for the chain.
 */
export function getExecutorForAccount(account: AccountForExecutor): ChainExecutor {
  if (account.mode === 'paper') {
    return paperExecutor;
  }
  const chain = account.chain ?? 'solana';
  const executor = CHAIN_EXECUTORS[chain];
  if (!executor) {
    throw new Error(`No executor registered for chain: ${chain}`);
  }
  return executor;
}

/**
 * Centralized execution entry point. No worker should call solanaExecutor or paperExecutor directly.
 * Enforces global live kill switch before delegating to the chain executor.
 */
export async function executeOrderForAccount(
  account: AccountForExecutor,
  order: ExecutionOrder
): Promise<ExecuteOrderResult> {
  if (account.mode === 'live' && !isLiveTradingEnabled()) {
    return { success: false, skipReason: 'LIVE_DISABLED' };
  }

  const executor = getExecutorForAccount(account);
  return executor(account, order);
}
