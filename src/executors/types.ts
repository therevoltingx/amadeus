/**
 * Chain-agnostic order payload for executeOrderForAccount.
 * Policies remain chain-agnostic; the executor handles chain-specific execution.
 */
export interface ExecutionOrder {
  pair_address: string;
  token_mint: string | null;
  entry_dex: string | null;
  policy_version: string;
  market_mode: string;
  signal: string;
  entry_price: number;
  position_size_usd: number;
  entry_snapshot_id: number | null;
  entry_score_id: number | null;
  risk_pct_at_entry: number | null;
  score_size_multiplier: number | null;
  entry_snapshot_ts: number;
  deployment_id: string;
  reason: string;
}

/** Account shape required by executors (chain, address, mode). RPC from config when needed. */
export interface AccountForExecutor {
  account_id: string;
  mode: 'paper' | 'live';
  chain: string | null;
  address: string | null;
  available_balance: number;
  starting_equity: number;
  max_total_risk_pct: number;
  [key: string]: unknown;
}

export interface ExecuteOrderResult {
  success: boolean;
  /** If !success, reason for skip/failure (e.g. 'LIVE_DISABLED', 'DRY_RUN'). */
  skipReason?: string;
  /** On success, for exit sell: the confirmed transaction signature. */
  txSignature?: string;
  /** On success, for exit sell: actual USD received from the tx (parsed from chain). */
  actualUsdReceived?: number;
  /** On success, for exit sell: SOL received (native) from the tx. */
  solReceived?: number;
  /** On success, for exit sell: SOL price (USD) used to compute actualUsdReceived. */
  solPriceUsd?: number;
  /** On success, for exit sell: actual exit price USD per token from chain (actualUsdReceived / tokensSold). */
  effectiveExitPriceUsd?: number;
  /** On success, for exit sell: slippage bps that was used for the sell tx. */
  slippageBpsUsed?: number;
  /** On success, for exit sell: token amount sold (from chain). */
  tokensSold?: number;
  /** On success, for exit sell: exit transaction fee in lamports. */
  feeLamports?: number;
}

export type ChainExecutor = (
  account: AccountForExecutor,
  order: ExecutionOrder
) => Promise<ExecuteOrderResult>;
