/**
 * PumpSwap vault swap worker: subscribes to base/quote vault accounts for PumpSwap pairs.
 * Slot-coalesces vault updates by pool so a swap is emitted only when both base and quote
 * deltas are known (or after a short fallback timer). New pairs via Redis pub/sub (pairs:new);
 * at startup loads only pairs eligible for snapshots (same SQL as chain-snapshots-worker / pairs page count): LP lock vs active policies — see snapshot-pair-eligibility-sql.ts.
 * Periodically re-queries that eligible set and unsubscribes vault watchers for subscribed pools that are no longer eligible.
 */

import 'dotenv/config';
import { Redis } from 'ioredis';
import type { AccountInfo } from '@solana/web3.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { getHeliusRpcUrl, getEnabledDexes } from '../config.js';
import { db } from '../db.js';
import { getEligiblePumpswapPairsWithVaults, isPairEligibleForSnapshotSubscription } from './chain-snapshots-worker.js';

const LOG_PREFIX = '[pumpswap-vault-swap-worker]';
const DEX_PUMPSWAP = 'pumpswap';
const REDIS_CHANNEL_NEW_PAIRS = 'pairs:new';
const REDIS_CHANNEL_PAIRS_DORMANT = 'pairs:dormant';

/**
 * How often to compare subscribed pools to the snapshot-eligible set and unsubscribe stale ones.
 * Env PUMPSWAP_VAULT_ELIGIBILITY_POLL_SEC (default 60, clamped 15–300).
 */
const ELIGIBILITY_RECONCILE_MS = (() => {
  const raw = Number(process.env.PUMPSWAP_VAULT_ELIGIBILITY_POLL_SEC);
  const sec = Number.isFinite(raw) && raw > 0 ? raw : 60;
  return Math.max(15, Math.min(300, sec)) * 1000;
})();

/** Coalesce window (ms). Emit swap when both deltas present, or discard after this. Configurable via COALESCE_WINDOW_MS. */
const COALESCE_WINDOW_MS = Math.max(
  75,
  Math.min(120, Number(process.env.COALESCE_WINDOW_MS ?? 100) || 100)
);

/** Minimum absolute delta to consider (dust threshold). */
const DUST_THRESHOLD = 0n;

type PendingSwap = {
  slot: number;
  baseDelta?: bigint;
  quoteDelta?: bigint;
  timer?: ReturnType<typeof setTimeout>;
};

/** Pairs we have already subscribed to (by pair_address). */
const subscribedPools = new Set<string>();

/** Vault pubkeys we have already subscribed to (avoids duplicate accountSubscribe). */
const subscribedVaults = new Set<string>();

/** Subscription id per vault (for removeAccountChangeListener). */
const vaultSubscriptionIds = new Map<string, number>();

/** Map vault pubkey -> pair_address (fast lookup). */
const vaultToPool = new Map<string, string>();

/** Map vault pubkey -> 'base' | 'quote' for delta attribution. */
const vaultToVaultType = new Map<string, 'base' | 'quote'>();

/** Map pair_address -> { baseVault, quoteVault } for resolving vault type. */
const poolToVaults = new Map<string, { baseVault: string; quoteVault: string }>();

/** Last known balance per vault (for delta). */
const vaultPreviousBalance = new Map<string, bigint>();

/** Vaults that have received at least one update (skip first update as initial state, not a delta). */
const vaultPrimed = new Set<string>();

/** Slot-coalesced pending swaps keyed by poolAddress. */
const pendingSwaps = new Map<string, PendingSwap>();

/** Current slot from slot subscription (used when account change doesn't provide slot). */
let currentSlot = 0;

/** Client subscription id from `onSlotChange` (removed on shutdown). */
let slotSubscriptionId: number | null = null;

/** Periodic eligibility reconcile (cleared on shutdown). */
let eligibilityReconcileInterval: ReturnType<typeof setInterval> | null = null;

type PairRow = { pair_address: string; base_vault: string; quote_vault: string };

const insertSwapEvent = db.prepare(`
  INSERT INTO pair_swap_events (pair_address, slot, direction, base_delta, quote_delta, created_at)
  VALUES ($pairAddress, $slot, $direction, $baseDelta, $quoteDelta, $createdAt)
`);

/** Pairs eligible for snapshots with vaults (same set as pairs page "X eligible for snapshots"). Bootstrap + periodic reconcile. */
function getPumpswapPairsWithVaults(): PairRow[] {
  return getEligiblePumpswapPairsWithVaults();
}

/** Read SPL token account amount (u64 LE at offset 64). Returns null if data too short or invalid. */
function readTokenAccountAmount(data: Buffer | Uint8Array): bigint | null {
  if (!data || data.length < 72) return null;
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return buf.readBigUInt64LE(64);
  } catch {
    return null;
  }
}

/**
 * Emit a swap: both deltas present and valid pattern (buy: base < 0, quote > 0; sell: base > 0, quote < 0).
 * Inserts into pair_swap_events and logs.
 */
function emitSwap(
  poolAddress: string,
  baseDelta: bigint,
  quoteDelta: bigint,
  slot: number
): void {
  const baseNeg = baseDelta < 0n;
  const basePos = baseDelta > 0n;
  const quotePos = quoteDelta > 0n;
  const quoteNeg = quoteDelta < 0n;
  const createdAt = Date.now();
  if (baseNeg && quotePos) {
    insertSwapEvent.run({
      pairAddress: poolAddress,
      slot,
      direction: 'buy',
      baseDelta: String(baseDelta),
      quoteDelta: String(quoteDelta),
      createdAt,
    });
    // console.log(`${LOG_PREFIX} Swap BUY pool=${poolAddress} baseDelta=${baseDelta} quoteDelta=${quoteDelta}`);
    return;
  }
  if (basePos && quoteNeg) {
    insertSwapEvent.run({
      pairAddress: poolAddress,
      slot,
      direction: 'sell',
      baseDelta: String(baseDelta),
      quoteDelta: String(quoteDelta),
      createdAt,
    });
    // console.log(`${LOG_PREFIX} Swap SELL pool=${poolAddress} baseDelta=${baseDelta} quoteDelta=${quoteDelta}`);
    return;
  }
  // Ignore other patterns (e.g. deposit/withdraw)
}

/** Try to flush pending swap: emit if both deltas present, then delete entry and clear timer. */
function flushPendingSwap(poolAddress: string): void {
  const pending = pendingSwaps.get(poolAddress);
  if (!pending) return;
  if (pending.timer) {
    clearTimeout(pending.timer);
    pending.timer = undefined;
  }
  const base = pending.baseDelta;
  const quote = pending.quoteDelta;
  const slot = pending.slot;
  pendingSwaps.delete(poolAddress);
  if (base != null && quote != null) {
    emitSwap(poolAddress, base, quote, slot);
  }
}

/**
 * Subscribe to a single vault account if not already subscribed.
 * vaultType is 'base' or 'quote' for the given pool.
 * Returns true if a new subscription was added.
 */
function subscribeVault(
  connection: Connection,
  vaultPubkey: string,
  pairAddress: string,
  vaultType: 'base' | 'quote'
): boolean {
  if (subscribedVaults.has(vaultPubkey)) return false;
  try {
    const pubkey = new PublicKey(vaultPubkey);
    const subId = connection.onAccountChange(
      pubkey,
      (accountInfo: AccountInfo<Buffer>, context?: { slot?: number }) => {
        handleVaultUpdate(vaultPubkey, accountInfo, context?.slot ?? currentSlot);
      },
      'processed'
    );
    subscribedVaults.add(vaultPubkey);
    vaultSubscriptionIds.set(vaultPubkey, subId);
    vaultToPool.set(vaultPubkey, pairAddress);
    vaultToVaultType.set(vaultPubkey, vaultType);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`${LOG_PREFIX} Failed to subscribe to vault ${vaultPubkey.slice(0, 12)}…:`, err);
    if (
      msg.includes('32006') ||
      msg.includes('Too many subscriptions') ||
      msg.includes('Exceeded max limit')
    ) {
      console.warn(
        `${LOG_PREFIX} RPC reports subscription cap reached on this WebSocket. This worker only needs ~2 vault subs per pool + 1 slot. Typical causes: other processes or tools using the same HELIUS_RPC_URL/API key, stale node workers still running, or tsx watch leaving old processes. Check running Node jobs and try a dedicated API key or restart after killing orphans.`
      );
    }
    return false;
  }
}

/**
 * Handle one vault account change: compute delta, coalesce by pool+slot, emit when both deltas present or on timer.
 */
function handleVaultUpdate(
  vaultPubkey: string,
  accountInfo: AccountInfo<Buffer>,
  slot: number
): void {
  const poolAddress = vaultToPool.get(vaultPubkey);
  if (!poolAddress) return;

  const vaultType = vaultToVaultType.get(vaultPubkey);
  if (!vaultType) return;

  const newBalance = readTokenAccountAmount(accountInfo?.data);
  if (newBalance == null) return;

  const prevBalance = vaultPreviousBalance.get(vaultPubkey) ?? 0n;
  const isFirst = !vaultPrimed.has(vaultPubkey);
  vaultPrimed.add(vaultPubkey);
  vaultPreviousBalance.set(vaultPubkey, newBalance);

  if (isFirst) return;

  const delta = newBalance - prevBalance;

  if (delta === 0n) return;
  if (delta < 0n && -delta < DUST_THRESHOLD) return;
  if (delta > 0n && delta < DUST_THRESHOLD) return;

  let pending = pendingSwaps.get(poolAddress);

  if (!pending) {
    pending = { slot };
    if (vaultType === 'base') pending.baseDelta = delta;
    else pending.quoteDelta = delta;
    pending.timer = setTimeout(() => {
      flushPendingSwap(poolAddress);
    }, COALESCE_WINDOW_MS);
    pendingSwaps.set(poolAddress, pending);
  } else {
    if (slot > pending.slot) {
      flushPendingSwap(poolAddress);
      pending = { slot };
      if (vaultType === 'base') pending.baseDelta = delta;
      else pending.quoteDelta = delta;
      pending.timer = setTimeout(() => {
        flushPendingSwap(poolAddress);
      }, COALESCE_WINDOW_MS);
      pendingSwaps.set(poolAddress, pending);
    } else if (slot === pending.slot) {
      if (vaultType === 'base') pending.baseDelta = delta;
      else pending.quoteDelta = delta;
    }
    // slot < pending.slot: stale, ignore
  }

  if (pending.baseDelta != null && pending.quoteDelta != null) {
    if (pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
    emitSwap(poolAddress, pending.baseDelta, pending.quoteDelta, pending.slot);
    pendingSwaps.delete(poolAddress);
  }
}

/**
 * Subscribe to both vaults for a pool. Idempotent: skips vaults already in subscribedVaults.
 * Adds pair to subscribedPools when at least one vault is newly subscribed.
 */
function subscribeVaultsForPool(
  connection: Connection,
  pairAddress: string,
  baseVault: string,
  quoteVault: string
): boolean {
  const b = baseVault.trim();
  const q = quoteVault.trim();
  poolToVaults.set(pairAddress, { baseVault: b, quoteVault: q });
  const baseAdded = subscribeVault(connection, b, pairAddress, 'base');
  const quoteAdded = subscribeVault(connection, q, pairAddress, 'quote');
  if (baseAdded || quoteAdded) {
    subscribedPools.add(pairAddress);
    return true;
  }
  subscribedPools.add(pairAddress);
  return false;
}

type NewPairMessage = {
  pairAddress: string;
  baseVault: string;
  quoteVault: string;
  baseMint?: string;
  quoteMint?: string;
};

/**
 * Subscribe vault watchers for a new pair. Idempotent: no-op if already tracked.
 * Only subscribes if the pair passes shared snapshot eligibility (tier, age policies, LP lock vs require_lp_lock — see snapshot-pair-eligibility-sql.ts).
 */
function handleNewPair(connection: Connection, pair: NewPairMessage): void {
  const pairAddress = pair?.pairAddress;
  const baseVault = typeof pair?.baseVault === 'string' ? pair.baseVault.trim() : '';
  const quoteVault = typeof pair?.quoteVault === 'string' ? pair.quoteVault.trim() : '';
  if (!pairAddress || !baseVault || !quoteVault) return;
  if (subscribedPools.has(pairAddress)) return;

  if (!isPairEligibleForSnapshotSubscription(pairAddress)) {
    return; // Skip: no active policy's max pair age matches this pair (and no open trade)
  }

  console.log(`${LOG_PREFIX} New pair appeared via Redis:`, { pairAddress, baseVault, quoteVault });
  subscribeVaultsForPool(connection, pairAddress, baseVault, quoteVault);
  console.log(`${LOG_PREFIX} Subscribed vault watchers for ${pairAddress.slice(0, 12)}…`);
}

type UnsubscribeVaultReason = 'redis_dormant' | 'eligibility_reconcile';

/**
 * Unsubscribe vault watchers for a pair and clean up state. Idempotent.
 * @param reason - redis_dormant: pairs:dormant message; eligibility_reconcile: no longer in snapshot-eligible set.
 */
function handlePairDormant(
  connection: Connection,
  pairAddress: string,
  reason: UnsubscribeVaultReason = 'redis_dormant'
): void {
  const address = typeof pairAddress === 'string' ? pairAddress.trim() : '';
  if (!address || !subscribedPools.has(address)) return;

  const vaults = poolToVaults.get(address);
  if (vaults) {
    for (const vaultPubkey of [vaults.baseVault, vaults.quoteVault]) {
      const subId = vaultSubscriptionIds.get(vaultPubkey);
      if (subId != null) {
        void connection.removeAccountChangeListener(subId).catch((err) => {
          console.warn(
            `${LOG_PREFIX} removeAccountChangeListener failed for ${vaultPubkey.slice(0, 12)}…:`,
            err instanceof Error ? err.message : err
          );
        });
        vaultSubscriptionIds.delete(vaultPubkey);
      }
      subscribedVaults.delete(vaultPubkey);
      vaultToPool.delete(vaultPubkey);
      vaultToVaultType.delete(vaultPubkey);
      vaultPreviousBalance.delete(vaultPubkey);
      vaultPrimed.delete(vaultPubkey);
    }
    poolToVaults.delete(address);
  }
  flushPendingSwap(address);
  pendingSwaps.delete(address);
  subscribedPools.delete(address);
  if (reason === 'redis_dormant') {
    console.log(`${LOG_PREFIX} Unsubscribed vault watchers for dormant pair ${address.slice(0, 12)}…`);
  } else {
    console.log(
      `${LOG_PREFIX} Unsubscribed vault watchers (no longer snapshot-eligible) ${address.slice(0, 12)}…`
    );
  }
}

/**
 * Drop vault subscriptions for pools that are still tracked locally but no longer returned by
 * getEligiblePumpswapPairsWithVaults() (policy/tier/LP-lock drift without a Redis dormant event).
 */
function reconcileEligibilitySubscriptions(connection: Connection): void {
  const eligibleSet = new Set(getPumpswapPairsWithVaults().map((r) => r.pair_address));
  const tracked = [...subscribedPools];
  let removed = 0;
  for (const poolAddress of tracked) {
    if (!eligibleSet.has(poolAddress)) {
      handlePairDormant(connection, poolAddress, 'eligibility_reconcile');
      removed++;
    }
  }
  if (removed > 0) {
    console.log(
      `${LOG_PREFIX} Eligibility reconcile: removed ${removed} pool(s); ${subscribedPools.size} pool(s) still subscribed`
    );
  }
}

/**
 * Bootstrap: load all existing PumpSwap pairs with vaults and subscribe.
 */
function bootstrapSubscriptions(connection: Connection): void {
  const pairs = getPumpswapPairsWithVaults();
  let added = 0;
  for (const row of pairs) {
    if (subscribedPools.has(row.pair_address)) continue;
    if (subscribeVaultsForPool(connection, row.pair_address, row.base_vault, row.quote_vault)) {
      added++;
    }
  }
  const vaultSubCount = subscribedVaults.size;
  const approxRpcSubs = vaultSubCount + (slotSubscriptionId != null ? 1 : 0);
  console.log(
    `${LOG_PREFIX} Bootstrap: ${pairs.length} eligible pair(s) with vaults, ${subscribedPools.size} pool(s) tracked, ${added} pool(s) gained new vault watcher(s), ${vaultSubCount} vault accountSubscribe(s) active (~${approxRpcSubs} RPC subs incl. slot once registered)`
  );
}

/**
 * Tear down Solana subscriptions and Redis so restarts (e.g. tsx watch) do not leave
 * orphaned state; does not fix provider-side caps if other apps share the same key.
 */
async function shutdownVaultSwapWorker(connection: Connection, redisSub: Redis): Promise<void> {
  if (eligibilityReconcileInterval != null) {
    clearInterval(eligibilityReconcileInterval);
    eligibilityReconcileInterval = null;
  }
  const vaultIds = [...vaultSubscriptionIds.entries()];
  await Promise.all(
    vaultIds.map(([, subId]) => connection.removeAccountChangeListener(subId).catch(() => {}))
  );
  for (const [vaultPubkey] of vaultIds) {
    vaultSubscriptionIds.delete(vaultPubkey);
    subscribedVaults.delete(vaultPubkey);
    vaultToPool.delete(vaultPubkey);
    vaultToVaultType.delete(vaultPubkey);
    vaultPreviousBalance.delete(vaultPubkey);
    vaultPrimed.delete(vaultPubkey);
  }
  subscribedPools.clear();
  poolToVaults.clear();
  for (const [, pending] of pendingSwaps) {
    if (pending.timer) clearTimeout(pending.timer);
  }
  pendingSwaps.clear();

  if (slotSubscriptionId != null) {
    const id = slotSubscriptionId;
    slotSubscriptionId = null;
    await connection.removeSlotChangeListener(id).catch(() => {});
  }

  try {
    await redisSub.unsubscribe(REDIS_CHANNEL_NEW_PAIRS, REDIS_CHANNEL_PAIRS_DORMANT);
  } catch {
    // ignore
  }
  try {
    redisSub.disconnect();
  } catch {
    // ignore
  }
}

export async function startPumpswapVaultSwapWorker(): Promise<void> {
  const rpcUrl = getHeliusRpcUrl();
  if (!rpcUrl) {
    console.error(`${LOG_PREFIX} HELIUS_RPC_URL is required. Exiting.`);
    process.exit(1);
  }

  const enabledDexes = getEnabledDexes();
  if (enabledDexes !== null && !enabledDexes.has(DEX_PUMPSWAP)) {
    console.log(
      `${LOG_PREFIX} ENABLED_DEXES is set and does not include pumpswap. Exiting.`
    );
    process.exit(0);
  }

  const connection = new Connection(rpcUrl, { commitment: 'processed' });
  slotSubscriptionId = connection.onSlotChange((slotInfo) => {
    currentSlot = slotInfo.slot;
  });

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.error(`${LOG_PREFIX} REDIS_URL is required (new pairs via pub/sub only). Exiting.`);
    process.exit(1);
  }

  const sub = new Redis(redisUrl);

  const onShutdown = (signal: string) => {
    console.log(`${LOG_PREFIX} ${signal}, closing subscriptions…`);
    void shutdownVaultSwapWorker(connection, sub).finally(() => process.exit(0));
  };
  process.once('SIGINT', () => onShutdown('SIGINT'));
  process.once('SIGTERM', () => onShutdown('SIGTERM'));

  await sub.subscribe(REDIS_CHANNEL_NEW_PAIRS, REDIS_CHANNEL_PAIRS_DORMANT);
  sub.on('message', (channel: string, message: string) => {
    if (channel === REDIS_CHANNEL_NEW_PAIRS) {
      console.log(`${LOG_PREFIX} Redis message received (${channel}):`, message);
      try {
        const pair = JSON.parse(message) as NewPairMessage;
        handleNewPair(connection, pair);
      } catch (err) {
        console.warn(`${LOG_PREFIX} Invalid Redis new-pair message:`, err instanceof Error ? err.message : err);
      }
      return;
    }
    if (channel === REDIS_CHANNEL_PAIRS_DORMANT) {
      try {
        const payload = JSON.parse(message) as { pairAddress?: string };
        const pairAddress = payload?.pairAddress;
        if (pairAddress) {
          handlePairDormant(connection, pairAddress);
        }
      } catch (err) {
        console.warn(`${LOG_PREFIX} Invalid Redis pairs:dormant message:`, err instanceof Error ? err.message : err);
      }
      return;
    }
  });
  console.log(
    `${LOG_PREFIX} Connecting to ${rpcUrl.replace(/\?api-key=[^&]+/, '?api-key=…')} (Redis: ${REDIS_CHANNEL_NEW_PAIRS}, ${REDIS_CHANNEL_PAIRS_DORMANT}, coalesce ${COALESCE_WINDOW_MS}ms; eligibility reconcile every ${ELIGIBILITY_RECONCILE_MS / 1000}s)`
  );

  bootstrapSubscriptions(connection);

  eligibilityReconcileInterval = setInterval(() => {
    try {
      reconcileEligibilitySubscriptions(connection);
    } catch (err) {
      console.warn(
        `${LOG_PREFIX} Eligibility reconcile failed:`,
        err instanceof Error ? err.message : err
      );
    }
  }, ELIGIBILITY_RECONCILE_MS);
}

import { fileURLToPath } from 'node:url';

const isMain =
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1]?.endsWith('pumpswap-vault-swap-worker.js');

if (isMain) {
  startPumpswapVaultSwapWorker().catch((err) => {
    console.error(`${LOG_PREFIX} Fatal:`, err);
    process.exit(1);
  });
}
