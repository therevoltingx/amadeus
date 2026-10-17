/**
 * Solana executor: real buy/sell via env signer and global RPC.
 * Guards: live only, kill switch, dry-run. Never reads key from account/DB.
 */
import {
  Connection,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { db } from '../db.js';
import {
  isLiveTradingEnabled,
  isLiveExecutionDryRun,
  getSolanaRpcUrl,
} from '../config.js';
import { getSolanaSigner } from '../solana-signer.js';
import { getSolPriceUsd } from '../sol-price.js';
import { buildSwapTransaction } from '../solana-swap.js';
import { getActualUsdReceivedFromExitTx, getEntryTxActuals } from '../solana-tx-actuals.js';
import type { AccountForExecutor, ExecutionOrder, ExecuteOrderResult } from './types.js';

const DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 3000;
const MAX_RETRIES = 3;

/** True if the error indicates the transaction's blockhash expired (block height exceeded). */
function isBlockhashExpiredError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('block height exceeded') ||
    msg.includes('blockhash has expired') ||
    msg.includes('has expired')
  );
}

/** Set a fresh blockhash on the transaction to avoid "block height exceeded" on send. */
async function setFreshBlockhash(connection: Connection, tx: Transaction): Promise<void> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;
  const txWithExpiry = tx as Transaction & { lastValidBlockHeight?: number };
  if (lastValidBlockHeight != null) {
    txWithExpiry.lastValidBlockHeight = lastValidBlockHeight;
  }
}

/**
 * Send and confirm with a fresh blockhash. On "block height exceeded" / expired error, retry once
 * with a new blockhash so we don't fail unnecessarily when the cluster is slow.
 */
async function sendAndConfirmWithFreshBlockhash(
  connection: Connection,
  tx: Transaction,
  signers: { publicKey: PublicKey }[],
  opts: { skipPreflight: boolean; maxRetries: number; commitment: 'confirmed' }
): Promise<string> {
  await setFreshBlockhash(connection, tx);
  try {
    return await sendAndConfirmTransaction(connection, tx, signers, opts);
  } catch (e) {
    if (!isBlockhashExpiredError(e)) throw e;
    await setFreshBlockhash(connection, tx);
    return await sendAndConfirmTransaction(connection, tx, signers, opts);
  }
}

const MAX_EXECUTION_ERROR_LENGTH = 1000;

function formatExecutionError(message: string, simulationLogs?: string[]): string {
  let s = message;
  if (simulationLogs != null && simulationLogs.length > 0) {
    const logSnippet = simulationLogs.slice(0, 5).join('; ');
    s += ' | ' + logSnippet;
  }
  return s.length > MAX_EXECUTION_ERROR_LENGTH ? s.slice(0, MAX_EXECUTION_ERROR_LENGTH - 3) + '...' : s;
}

const insertTradeDecisionLive = db.prepare(`
  INSERT INTO trade_decisions (
    pair_address, token_mint, entry_dex, policy_version, market_mode, signal,
    entry_price, position_size_usd, executed_at, reason, execution_mode, entry_snapshot_id, entry_score_id,
    risk_pct_at_entry, score_size_multiplier, pair_missing_failures, last_snapshot_timestamp,
    account_id, deployment_id, chain,
    tx_signature, execution_status, execution_error, actual_entry_price, actual_position_size_usd,
    slippage_bps_realized, execution_latency_ms, submit_timestamp, confirmed_slot,
    sol_price_at_entry, entry_slippage_bps_used, tokens_received, actual_usd_bought, exit_recorded_at
  ) VALUES ($pairAddress, $tokenMint, $entryDex, $policyVersion, $marketMode, $signal,
    $entryPrice, $positionSizeUsd, $executedAt, $reason, 'live', $entrySnapshotId, $entryScoreId,
    $riskPctAtEntry, $scoreSizeMultiplier, 0, $lastSnapshotTimestamp,
    $accountId, $deploymentId, $chain,
    $txSignature, $executionStatus, $executionError, $actualEntryPrice, $actualSize,
    $slippageBpsRealized, $executionLatencyMs, $submitTimestamp, $confirmedSlot,
    $solPriceAtEntry, $entrySlippageBpsUsed, $tokensReceived, $actualUsdBought, $exitRecordedAt)
`);

function insertLiveDecision(
  order: ExecutionOrder,
  account: AccountForExecutor,
  now: number,
  status: string,
  txSignature: string | null,
  actualEntryPrice: number | null,
  actualSize: number | null,
  slippageBpsRealized: number | null,
  latencyMs: number | null,
  submitTs: number | null,
  confirmedSlot: number | null,
  solPriceAtEntry: number | null,
  entrySlippageBpsUsed: number | null,
  tokensReceived: number | null,
  actualUsdBought: number | null,
  executionError: string | null = null
): void {
  const chain = account.chain ?? 'solana';
  const exitRecordedAt = status === 'LIVE_FAILED' ? now : null;
  insertTradeDecisionLive.run({
    pairAddress: order.pair_address,
    tokenMint: order.token_mint,
    entryDex: order.entry_dex,
    policyVersion: order.policy_version,
    marketMode: order.market_mode,
    signal: order.signal,
    entryPrice: order.entry_price,
    positionSizeUsd: order.position_size_usd,
    executedAt: now,
    reason: order.reason,
    entrySnapshotId: order.entry_snapshot_id,
    entryScoreId: order.entry_score_id ?? null,
    riskPctAtEntry: order.risk_pct_at_entry,
    scoreSizeMultiplier: order.score_size_multiplier,
    lastSnapshotTimestamp: order.entry_snapshot_ts,
    accountId: account.account_id,
    deploymentId: order.deployment_id,
    chain,
    txSignature,
    executionStatus: status,
    executionError,
    actualEntryPrice,
    actualSize,
    slippageBpsRealized,
    executionLatencyMs: latencyMs,
    submitTimestamp: submitTs,
    confirmedSlot,
    solPriceAtEntry,
    entrySlippageBpsUsed,
    tokensReceived,
    actualUsdBought,
    exitRecordedAt,
  });
}

/** Compute actual fill from chain (SOL spent + tokens received). Falls back to order values if parsing fails. */
async function computeActualFill(
  connection: Connection,
  _account: AccountForExecutor,
  order: ExecutionOrder,
  txSignature: string,
  signerPubkey: { publicKey: PublicKey }
): Promise<{ actualTokensReceived: number; effectivePrice: number; slippageBpsRealized: number; actualUsdSpent: number | null }> {
  if (!order.token_mint?.trim()) {
    return {
      actualTokensReceived: 0,
      effectivePrice: order.entry_price,
      slippageBpsRealized: 0,
      actualUsdSpent: null,
    };
  }
  let actuals = await getEntryTxActuals(
    connection,
    txSignature,
    signerPubkey.publicKey,
    order.token_mint
  );
  if (actuals == null) {
    console.warn(JSON.stringify({ event: 'entry_chain_parse_retry', tx: txSignature, attempt: 2 }));
    await new Promise((r) => setTimeout(r, 5_000));
    actuals = await getEntryTxActuals(
      connection,
      txSignature,
      signerPubkey.publicKey,
      order.token_mint
    );
  }
  if (actuals == null) {
    console.error(JSON.stringify({ event: 'entry_chain_parse_failed_all_attempts', tx: txSignature, pair: order.pair_address }));
    return {
      actualTokensReceived: 0,
      effectivePrice: order.entry_price,
      slippageBpsRealized: 0,
      actualUsdSpent: null,
    };
  }
  const slippageBpsRealized =
    order.entry_price !== 0 && Number.isFinite(actuals.effectivePriceUsd)
      ? Math.round(((actuals.effectivePriceUsd - order.entry_price) / order.entry_price) * 10000)
      : 0;
  return {
    actualTokensReceived: actuals.tokensReceived,
    effectivePrice: actuals.effectivePriceUsd,
    slippageBpsRealized,
    actualUsdSpent: Number.isFinite(actuals.actualUsdSpent) && actuals.actualUsdSpent > 0 ? actuals.actualUsdSpent : null,
  };
}

export async function solanaExecutor(
  account: AccountForExecutor,
  order: ExecutionOrder
): Promise<ExecuteOrderResult> {
  if (account.chain !== 'solana') {
    return { success: false, skipReason: 'invalid_chain' };
  }
  if (account.mode !== 'live') {
    return { success: false, skipReason: 'invalid_mode' };
  }
  if (!isLiveTradingEnabled()) {
    return { success: false, skipReason: 'LIVE_DISABLED' };
  }
  if (isLiveExecutionDryRun()) {
    return { success: false, skipReason: 'DRY_RUN' };
  }

  const now = Math.floor(Date.now() / 1000);
  let solPriceAtEntry: number | null = null;
  try {
    solPriceAtEntry = await getSolPriceUsd();
  } catch {
    // omit if price fetch fails
  }
  let signer;
  let rpcUrl: string;
  let connection: Connection;
  try {
    signer = getSolanaSigner();
    const url = getSolanaRpcUrl();
    if (!url) throw new Error('HELIUS_RPC_URL not configured');
    rpcUrl = url;
    connection = new Connection(rpcUrl, { commitment: 'confirmed' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const logs = await getTransactionErrorLogs(e);
    console.error(
      JSON.stringify(
        fullTransactionErrorPayload(e, logs, {
          event: 'live_tx_failed',
          account_id: account.account_id,
        })
      )
    );
    insertLiveDecision(
      order,
      account,
      now,
      'LIVE_FAILED',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      solPriceAtEntry,
      null,
      null,
      null,
      formatExecutionError(msg, logs ?? undefined)
    );
    return { success: false, skipReason: msg };
  }

  let lastError: unknown;
  let txSignature: string | null = null;
  let submitTime = 0;
  let slippageBpsUsed = ENTRY_BUY_SLIPPAGE_BPS_LADDER[0];

  for (const slippageBps of ENTRY_BUY_SLIPPAGE_BPS_LADDER) {
    slippageBpsUsed = slippageBps;
    let tx: Transaction;
    try {
      tx = await buildSwapTransaction({
        account,
        order,
        signer,
        slippageBps,
        connection,
      });
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      const logs = await getTransactionErrorLogs(e);
      console.error(
        JSON.stringify(
          fullTransactionErrorPayload(e, logs, {
            event: 'live_tx_failed',
            account_id: account.account_id,
          })
        )
      );
      insertLiveDecision(
        order,
        account,
        now,
        'LIVE_FAILED',
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      solPriceAtEntry,
      null,
      null,
      null,
        formatExecutionError(msg, logs ?? undefined)
      );
      return { success: false, skipReason: msg };
    }

    tx.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
      })
    );

    submitTime = Date.now();

    try {
      txSignature = await sendAndConfirmWithFreshBlockhash(
        connection,
        tx,
        [signer],
        {
          skipPreflight: false,
          maxRetries: MAX_RETRIES,
          commitment: 'confirmed',
        }
      );
      const confirmTime = Date.now();
      const latencyMs = confirmTime - submitTime;

      console.log(
        JSON.stringify({
          event: 'live_tx_submitted',
          account_id: account.account_id,
          tx_signature: txSignature,
        })
      );
      console.log(
        JSON.stringify({
          event: 'live_tx_confirmed',
          account_id: account.account_id,
          tx_signature: txSignature,
          slot: null,
          latency_ms: latencyMs,
          slippage_bps_used: slippageBps,
        })
      );

      const fill = await computeActualFill(connection, account, order, txSignature, signer);
      const actualEntryPrice = fill.effectivePrice > 0 ? fill.effectivePrice : order.entry_price;
      const actualSize = order.position_size_usd;
      const slippageBpsRealized = fill.slippageBpsRealized;
      if (slippageBpsRealized > slippageBpsUsed) {
        console.warn(
          JSON.stringify({
            event: 'live_slippage_warning',
            account_id: account.account_id,
            tx_signature: txSignature,
            slippage_bps_realized: slippageBpsRealized,
            slippage_bps_expected: slippageBpsUsed,
          })
        );
      }

      insertLiveDecision(
        order,
        account,
        now,
        'LIVE_FILLED',
        txSignature,
        actualEntryPrice,
        actualSize,
        slippageBpsRealized,
        latencyMs,
        Math.floor(submitTime / 1000),
        null,
        solPriceAtEntry,
        slippageBps,
        fill.actualTokensReceived > 0 ? fill.actualTokensReceived : null,
        fill.actualUsdSpent ?? null
      );
      return { success: true };
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (isSlippageError(e)) {
        console.warn(
          JSON.stringify({
            event: 'live_buy_slippage_retry',
            account_id: account.account_id,
            slippage_bps_tried: slippageBps,
            next_slippage_bps:
              ENTRY_BUY_SLIPPAGE_BPS_LADDER[ENTRY_BUY_SLIPPAGE_BPS_LADDER.indexOf(slippageBps) + 1] ?? null,
            error_snippet: msg.slice(0, 120),
          })
        );
        continue;
      }
      const logs = await getTransactionErrorLogs(e);
      console.error(
        JSON.stringify(
          fullTransactionErrorPayload(e, logs, {
            event: 'live_tx_failed',
            account_id: account.account_id,
          })
        )
      );
      const latencyMs = Date.now() - submitTime;
      const skipReason = isNonRetriableInsufficientLamports(e)
        ? 'INSUFFICIENT_LAMPORTS'
        : msg.includes('timeout') || msg.includes('Timeout')
          ? 'PENDING_CONFIRMATION'
          : 'LIVE_FAILED';
      insertLiveDecision(
        order,
        account,
        now,
        skipReason === 'PENDING_CONFIRMATION' ? 'PENDING_CONFIRMATION' : 'LIVE_FAILED',
        null,
        null,
        null,
        null,
        latencyMs,
        Math.floor(submitTime / 1000),
        null,
        solPriceAtEntry,
        null,
        null,
        null,
        formatExecutionError(msg, logs ?? undefined)
      );
      return { success: false, skipReason };
    }
  }

  const msg = lastError instanceof Error ? (lastError as Error).message : String(lastError);
  const logs = await getTransactionErrorLogs(lastError);
  console.error(
    JSON.stringify(
      fullTransactionErrorPayload(lastError, logs, {
        event: 'live_tx_failed',
        account_id: account.account_id,
        exhausted_slippage_ladder: true,
      })
    )
  );
  insertLiveDecision(
    order,
    account,
    now,
    'LIVE_FAILED',
    null,
    null,
    null,
    null,
    null,
    Date.now() - submitTime,
    Math.floor(submitTime / 1000),
    null,
    solPriceAtEntry,
    null,
    null,
    null,
    formatExecutionError(msg, logs ?? undefined)
  );
  return { success: false, skipReason: msg };
}

/** Slippage ladder (bps) for exit sell retries: 1% → 3% → 5% → 10% → 15% → 20% → 25%. */
const EXIT_SELL_SLIPPAGE_BPS_LADDER = [100, 300, 500, 1000, 1500, 2000, 2500];

/** Slippage ladder (bps) for entry buy retries: 1% → 3% → 5% → 10% → 15% → 20% → 25%. */
const ENTRY_BUY_SLIPPAGE_BPS_LADDER = [100, 300, 500, 1000, 1500, 2000, 2500];

function isSlippageError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('ExceededSlippage') ||
    msg.includes('0x1774') ||
    (msg.includes('custom program error') && msg.includes('slippage'))
  );
}

/** True if the error is insufficient lamports / SOL (system program 0x1). Do not retry. */
function isNonRetriableInsufficientLamports(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes('insufficient lamports') ||
    (msg.includes('11111111111111111111111111111111') && msg.includes('custom program error: 0x1'))
  );
}

/** If the error is a SendTransactionError (has getLogs), return program logs for diagnostics (e.g. Custom error codes). */
async function getTransactionErrorLogs(err: unknown): Promise<string[] | undefined> {
  const e = err as { getLogs?: () => Promise<string[]> | string[] };
  if (typeof e?.getLogs !== 'function') return undefined;
  try {
    const logs = await Promise.resolve(e.getLogs());
    return Array.isArray(logs) ? logs : undefined;
  } catch (getLogsErr) {
    console.error(
      JSON.stringify({
        event: 'get_logs_failed',
        error: getLogsErr instanceof Error ? getLogsErr.message : String(getLogsErr),
      })
    );
    return undefined;
  }
}

/** Build a full error payload for logging (message, name, stack, transaction_error_logs, optional signature). */
function fullTransactionErrorPayload(
  err: unknown,
  transactionErrorLogs: string[] | undefined,
  base: Record<string, unknown>
): Record<string, unknown> {
  const msg = err instanceof Error ? err.message : String(err);
  const name = err instanceof Error ? err.name : undefined;
  const stack = err instanceof Error ? err.stack : undefined;
  const withExtras = err as { signature?: string };
  const signature = typeof withExtras.signature === 'string' ? withExtras.signature : undefined;
  return {
    ...base,
    error_message: msg,
    error_name: name ?? null,
    error_stack: stack ?? null,
    transaction_error_logs: transactionErrorLogs ?? null,
    ...(signature != null && { transaction_signature: signature }),
  };
}

/**
 * Execute a live exit sell only: build sell transaction (order.signal must be 'SELL'), send and confirm.
 * Retries with higher slippage (5% → 10% → 15% → 20% → 25%) on ExceededSlippage.
 * Does not insert any trade_decision row; used by the exit worker after evaluating exit conditions.
 */
export async function executeLiveExitSell(
  account: AccountForExecutor,
  order: ExecutionOrder
): Promise<ExecuteOrderResult> {
  if (account.chain !== 'solana') {
    return { success: false, skipReason: 'invalid_chain' };
  }
  if (account.mode !== 'live') {
    return { success: false, skipReason: 'invalid_mode' };
  }
  if (!isLiveTradingEnabled()) {
    return { success: false, skipReason: 'LIVE_DISABLED' };
  }
  if (isLiveExecutionDryRun()) {
    return { success: false, skipReason: 'DRY_RUN' };
  }

  let signer;
  let connection: Connection;
  try {
    signer = getSolanaSigner();
    const url = getSolanaRpcUrl();
    if (!url) throw new Error('HELIUS_RPC_URL not configured');
    connection = new Connection(url, { commitment: 'confirmed' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const logs = await getTransactionErrorLogs(e);
    console.error(
      JSON.stringify(
        fullTransactionErrorPayload(e, logs, {
          event: 'live_exit_sell_failed',
          account_id: account.account_id,
        })
      )
    );
    return { success: false, skipReason: msg };
  }

  let lastError: unknown;
  for (const slippageBps of EXIT_SELL_SLIPPAGE_BPS_LADDER) {
    let tx: Transaction;
    try {
      tx = await buildSwapTransaction({
        account,
        order,
        signer,
        slippageBps,
        connection,
      });
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      const logs = await getTransactionErrorLogs(e);
      console.error(
        JSON.stringify(
          fullTransactionErrorPayload(e, logs, {
            event: 'live_exit_sell_failed',
            account_id: account.account_id,
            pair_address: order.pair_address,
          })
        )
      );
      return { success: false, skipReason: msg };
    }

    tx.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
      })
    );

    try {
      const txSignature = await sendAndConfirmWithFreshBlockhash(
        connection,
        tx,
        [signer],
        {
          skipPreflight: false,
          maxRetries: MAX_RETRIES,
          commitment: 'confirmed',
        }
      );
      if (slippageBps > EXIT_SELL_SLIPPAGE_BPS_LADDER[0]) {
        console.log(
          JSON.stringify({
            event: 'live_exit_sell_retry_succeeded',
            account_id: account.account_id,
            pair_address: order.pair_address,
            slippage_bps_used: slippageBps,
          })
        );
      }
      console.log(
        JSON.stringify({
          event: 'live_exit_sell_confirmed',
          account_id: account.account_id,
          pair_address: order.pair_address,
          tx_signature: txSignature,
        })
      );
      let actualUsdReceived: number | undefined;
      let solReceived: number | undefined;
      let solPriceUsd: number | undefined;
      let effectiveExitPriceUsd: number | undefined;
      let tokensSold: number | undefined;
      let feeLamports: number | undefined;
      for (let chainAttempt = 0; chainAttempt < 2; chainAttempt++) {
        try {
          const actuals = await getActualUsdReceivedFromExitTx(
            connection,
            txSignature,
            signer.publicKey,
            order.token_mint
          );
          if (actuals != null && Number.isFinite(actuals.actualUsdReceived)) {
            actualUsdReceived = actuals.actualUsdReceived;
            solReceived = actuals.solReceived;
            solPriceUsd = actuals.solPriceUsd;
            feeLamports = actuals.feeLamports;
            if (actuals.effectiveExitPriceUsd != null && Number.isFinite(actuals.effectiveExitPriceUsd)) {
              effectiveExitPriceUsd = actuals.effectiveExitPriceUsd;
            }
            if (actuals.tokensSold != null && Number.isFinite(actuals.tokensSold)) {
              tokensSold = actuals.tokensSold;
            }
            break;
          }
        } catch {
          // logged inside getActualUsdReceivedFromExitTx
        }
        if (chainAttempt === 0 && actualUsdReceived == null) {
          console.warn(JSON.stringify({ event: 'exit_chain_parse_retry', tx: txSignature, attempt: 2 }));
          await new Promise((r) => setTimeout(r, 5_000));
        }
      }
      if (actualUsdReceived == null) {
        console.error(JSON.stringify({ event: 'exit_chain_parse_failed_all_attempts', tx: txSignature, pair: order.pair_address }));
      }
      return { success: true, txSignature, actualUsdReceived, solReceived, solPriceUsd, effectiveExitPriceUsd, slippageBpsUsed: slippageBps, tokensSold, feeLamports };
    } catch (e) {
      lastError = e;
      if (isNonRetriableInsufficientLamports(e)) {
        const msg = e instanceof Error ? e.message : String(e);
        const logs = await getTransactionErrorLogs(e);
        console.error(
          JSON.stringify(
            fullTransactionErrorPayload(e, logs, {
              event: 'live_exit_sell_failed',
              account_id: account.account_id,
              pair_address: order.pair_address,
            })
          )
        );
        return { success: false, skipReason: 'INSUFFICIENT_LAMPORTS' };
      }
      if (isSlippageError(e)) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(
          JSON.stringify({
            event: 'live_exit_sell_slippage_retry',
            account_id: account.account_id,
            pair_address: order.pair_address,
            slippage_bps_tried: slippageBps,
            next_slippage_bps:
              EXIT_SELL_SLIPPAGE_BPS_LADDER[EXIT_SELL_SLIPPAGE_BPS_LADDER.indexOf(slippageBps) + 1] ?? null,
            error_snippet: msg.slice(0, 120),
          })
        );
        continue;
      }
      const msg = e instanceof Error ? e.message : String(e);
      const logs = await getTransactionErrorLogs(e);
      console.error(
        JSON.stringify(
          fullTransactionErrorPayload(e, logs, {
            event: 'live_exit_sell_failed',
            account_id: account.account_id,
            pair_address: order.pair_address,
          })
        )
      );
      return { success: false, skipReason: msg };
    }
  }

  const msg = lastError instanceof Error ? lastError.message : String(lastError);
  const logs = await getTransactionErrorLogs(lastError);
  console.error(
    JSON.stringify(
      fullTransactionErrorPayload(lastError, logs, {
        event: 'live_exit_sell_failed',
        account_id: account.account_id,
        pair_address: order.pair_address,
        exhausted_slippage_ladder: true,
      })
    )
  );
  return { success: false, skipReason: msg };
}
