import type { AccountForExecutor, ExecutionOrder, ExecuteOrderResult } from './types.js';

/**
 * EVM executor placeholder. Not implemented.
 */
export async function evmExecutor(
  _account: AccountForExecutor,
  _order: ExecutionOrder
): Promise<ExecuteOrderResult> {
  throw new Error('EVM executor not implemented');
}
