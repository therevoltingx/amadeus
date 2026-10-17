/**
 * Sell dust: sell any tokens in the Solana wallet that do not have an open trade decision
 * (no open position) for the default Solana account. Resolves pool/dex from DB first, then
 * DexScreener API for tokens not in the DB (so dust not in DB is also sold when a supported pair exists).
 *
 * Usage:
 *   npx tsx src/scripts/sell-dust.ts           # run (requires LIVE_TRADING_ENABLED=true to send)
 *   npx tsx src/scripts/sell-dust.ts --dry-run # list dust only, do not send txs
 */
import 'dotenv/config';
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { getSolanaRpcUrl } from '../config.js';
import { getSolanaSigner } from '../solana-signer.js';
import { db, SOLANA_DEFAULT_ACCOUNT_ID } from '../db.js';
import { getAccountById } from '../deployment-resolver.js';
import { buildSwapTransaction } from '../solana-swap.js';
import { fetchTokenPairs } from '../api/dexscreener.js';
import type { AccountForExecutor, ExecutionOrder } from '../executors/types.js';

const DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 3000;
const MAX_RETRIES = 3;
/** Slippage ladder (bps): 1%, 3%, 5%, 10%, 30%, 50%, 75%, 99%. Retry with next tier after each failure. */
const DUST_SLIPPAGE_BPS_LADDER = [100, 300, 500, 1000, 3000, 5000, 7500, 9900];
/** WSOL mint - skip, we don't sell native SOL as "dust". */
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/** PumpSwap error: division by zero (0x1789 / 6025) — pool liquidity or math edge case. */
const PUMPSWAP_DIVISION_BY_ZERO = '0x1789';
/** PumpSwap error: requesting more base (SOL) than pool reserves (0x1780 / 6016). */
const PUMPSWAP_MORE_BASE_THAN_RESERVES = '0x1780';
/** PumpSwap error: arithmetic overflow (0x1787 / 6023) — e.g. token amount or fee math exceeds u64. */
const PUMPSWAP_OVERFLOW = '0x1787';

function pumpSwapErrorReason(msg: string): string {
  if (msg.includes(PUMPSWAP_DIVISION_BY_ZERO) || msg.includes('6025')) {
    return 'PumpSwap divisionByZero (0x1789) — pool may have insufficient liquidity or incompatible state';
  }
  if (msg.includes(PUMPSWAP_MORE_BASE_THAN_RESERVES) || msg.includes('6016')) {
    return 'PumpSwap buyMoreBaseThanPoolReserves (0x1780) — requested more SOL than pool has';
  }
  if (msg.includes(PUMPSWAP_OVERFLOW) || msg.includes('6023') || msg.includes('Overflow')) {
    return 'PumpSwap Overflow (0x1787) — amount or fee math exceeded program limit';
  }
  return msg.slice(0, 120);
}

/** Token accounts (mint + raw amount) for owner from both Token and Token-2022. */
async function getWalletTokenBalances(
  connection: Connection,
  owner: PublicKey
): Promise<{ mint: string; amountRaw: number }[]> {
  const out: { mint: string; amountRaw: number }[] = [];
  const seen = new Set<string>();

  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const accounts = await connection.getParsedTokenAccountsByOwner(owner, {
      programId,
    });
    for (const { account } of accounts.value) {
      const parsed = account.data?.parsed;
      if (!parsed?.info?.mint) continue;
      const mint = parsed.info.mint as string;
      const tokenAmount = parsed.info.tokenAmount;
      if (!tokenAmount || tokenAmount.amount === '0') continue;
      const amountRaw = Number(tokenAmount.amount);
      if (amountRaw <= 0) continue;
      if (seen.has(mint)) continue;
      seen.add(mint);
      out.push({ mint, amountRaw });
    }
  }
  return out;
}

/** Token mints that have an open trade decision for the given account. */
function getOpenDecisionMints(accountId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT token_mint FROM trade_decisions
       WHERE account_id = $accountId AND exit_recorded_at IS NULL
         AND token_mint IS NOT NULL AND TRIM(token_mint) != ''`
    )
    .all({ accountId }) as { token_mint: string }[];
  return new Set(rows.map((r) => r.token_mint.trim()));
}

const CHAIN = 'solana';
type PairInfo = { pair_address: string; dex: string; base_symbol: string };

/** Pair from DB: pair_address, dex, base_symbol. Prefer pumpfun, pumpswap, raydium. */
function getPairFromDb(baseTokenAddress: string): PairInfo | null {
  const row = db
    .prepare(
      `SELECT pair_address, dex, base_symbol FROM pairs
       WHERE base_token_address = $baseTokenAddress
       ORDER BY CASE LOWER(TRIM(dex))
         WHEN 'pumpfun' THEN 1 WHEN 'pumpswap' THEN 2 WHEN 'raydium' THEN 3 ELSE 4 END
       LIMIT 1`
    )
    .get({ baseTokenAddress: baseTokenAddress.trim() }) as
    | { pair_address: string; dex: string; base_symbol: string }
    | undefined;
  return row ?? null;
}

/** Normalize DexScreener dexId to our swap layer keys (pumpfun | pumpswap | raydium). */
function normalizeDexId(dexId: string): string | null {
  const n = dexId.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
  if (n === 'pumpfun') return 'pumpfun';
  if (n === 'pumpswap') return 'pumpswap';
  if (n === 'raydium') return 'raydium';
  return null;
}

/** Pick first supported pair from DexScreener API response. Returns null if none. */
function pickPairFromApiPairs(
  pairs: Awaited<ReturnType<typeof fetchTokenPairs>>
): PairInfo | null {
  const supported = pairs.filter((p) => normalizeDexId(p.dexId ?? '') != null);
  if (supported.length === 0) return null;
  const sorted = [...supported].sort((a, b) => {
    const liqA = a.liquidity?.usd ?? 0;
    const liqB = b.liquidity?.usd ?? 0;
    if (liqB !== liqA) return liqB - liqA;
    const dexA = normalizeDexId(a.dexId ?? '') ?? '';
    const dexB = normalizeDexId(b.dexId ?? '') ?? '';
    const order = { pumpfun: 1, pumpswap: 2, raydium: 3 };
    return (order[dexA as keyof typeof order] ?? 4) - (order[dexB as keyof typeof order] ?? 4);
  });
  const p = sorted[0];
  const dex = normalizeDexId(p.dexId ?? '');
  if (!dex) return null;
  return {
    pair_address: p.pairAddress,
    dex,
    base_symbol: p.baseToken?.symbol?.trim() || '',
  };
}

/** Resolve pair from DexScreener API only (for retry when DB/previous pair address is invalid). */
async function getPairFromApi(baseTokenAddress: string): Promise<PairInfo | null> {
  try {
    const pairs = await fetchTokenPairs(CHAIN, baseTokenAddress.trim());
    return pickPairFromApiPairs(pairs);
  } catch {
    return null;
  }
}

/** Resolve pair from DB, then DexScreener API for tokens not in DB. Returns null if no supported pair. */
async function getPairForBaseToken(baseTokenAddress: string): Promise<PairInfo | null> {
  const fromDb = getPairFromDb(baseTokenAddress);
  if (fromDb) return fromDb;

  try {
    const pairs = await fetchTokenPairs(CHAIN, baseTokenAddress.trim());
    return pickPairFromApiPairs(pairs);
  } catch {
    return null;
  }
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');

  const rpcUrl = getSolanaRpcUrl();
  if (!rpcUrl) {
    console.error('HELIUS_RPC_URL is not set. Set it in .env');
    process.exit(1);
  }

  let signer: Keypair;
  try {
    signer = getSolanaSigner();
  } catch (e) {
    console.error('SOLANA_PRIVATE_KEY is not set or invalid. Set it in .env');
    process.exit(1);
  }

  const accountRow = getAccountById(SOLANA_DEFAULT_ACCOUNT_ID);
  if (!accountRow || accountRow.chain !== 'solana') {
    console.error('Solana account not found or wrong chain.');
    process.exit(1);
  }

  const account: AccountForExecutor = {
    account_id: accountRow.account_id,
    mode: 'live',
    chain: accountRow.chain,
    address: accountRow.address,
    available_balance: accountRow.available_balance,
    starting_equity: accountRow.starting_equity,
    max_total_risk_pct: accountRow.max_total_risk_pct ?? 15,
  };

  const openMints = getOpenDecisionMints(SOLANA_DEFAULT_ACCOUNT_ID);
  const connection = new Connection(rpcUrl, { commitment: 'confirmed' });

  getWalletTokenBalances(connection, signer.publicKey)
    .then((balances) => {
      const dust = balances.filter(
        (b) => b.mint !== WSOL_MINT && !openMints.has(b.mint)
      );
      if (dust.length === 0) {
        console.log('No dust tokens to sell (all tokens have an open position or wallet has no tokens).');
        return;
      }
      console.log(`Found ${dust.length} dust token(s):`);
      for (const d of dust) {
        const pairDb = getPairFromDb(d.mint);
        const name = pairDb?.base_symbol?.trim() || d.mint.slice(0, 12) + '…';
        const pairSrc = pairDb ? 'DB' : 'API (will resolve on sell)';
        console.log(`  ${name} (${d.mint.slice(0, 12)}…) amountRaw=${d.amountRaw} pair=${pairDb ? pairDb.pair_address.slice(0, 12) + '…' : '—'} dex=${pairDb?.dex ?? '—'} [${pairSrc}]`);
      }

      if (dryRun) {
        console.log('Dry run: not sending any transactions.');
        return;
      }

      if (process.env.LIVE_TRADING_ENABLED !== 'true') {
        console.error('LIVE_TRADING_ENABLED is not "true". Set it in .env to send dust-sell transactions.');
        process.exit(1);
      }

      return runSells(connection, signer, account, dust);
    })
    .then(() => {
      console.log('Done.');
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

async function runSells(
  connection: Connection,
  signer: Keypair,
  account: AccountForExecutor,
  dust: { mint: string; amountRaw: number }[]
): Promise<void> {
  for (const d of dust) {
    const pair = await getPairForBaseToken(d.mint);
    const tokenName = pair?.base_symbol?.trim() || d.mint.slice(0, 12) + '…';
    if (!pair) {
      console.warn(`Skipping ${tokenName} mint=${d.mint}: no supported pair in DB or DexScreener API`);
      continue;
    }

    const order: ExecutionOrder = {
      pair_address: pair.pair_address,
      token_mint: d.mint,
      entry_dex: pair.dex,
      policy_version: 'dust-script',
      market_mode: 'amm',
      signal: 'SELL',
      entry_price: 0,
      position_size_usd: 0,
      entry_snapshot_id: null,
      entry_score_id: null,
      risk_pct_at_entry: null,
      score_size_multiplier: null,
      entry_snapshot_ts: Math.floor(Date.now() / 1000),
      deployment_id: 'dust-script',
      reason: 'dust',
      sell_token_amount_raw: d.amountRaw,
    };

    const trySellWithLadder = async (p: PairInfo): Promise<{ sold: boolean; lastError?: string }> => {
      const orderForPair: ExecutionOrder = {
        ...order,
        pair_address: p.pair_address,
        entry_dex: p.dex,
      };
      let lastError: string | undefined;
      for (const slippageBps of DUST_SLIPPAGE_BPS_LADDER) {
        try {
          const tx = await buildSwapTransaction({
            account,
            order: orderForPair,
            signer,
            slippageBps,
            connection,
          });
          tx.add(
            ComputeBudgetProgram.setComputeUnitPrice({
              microLamports: DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS,
            })
          );
          const sig = await sendAndConfirmTransaction(connection, tx, [signer], {
            skipPreflight: false,
            maxRetries: MAX_RETRIES,
            commitment: 'confirmed',
          });
          const pct = (slippageBps / 100).toFixed(0);
          console.log(`Sold dust ${p.base_symbol?.trim() || tokenName} mint=${d.mint} pair=${p.pair_address} tx: ${sig} (slippage ${pct}%)`);
          return { sold: true };
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          // continue to next slippage tier
        }
      }
      return { sold: false, lastError };
    };

    let result = await trySellWithLadder(pair);
    if (!result.sold) {
      const isInvalidPairKey =
        (result.lastError ?? '').includes('does not decode to 32-byte') ||
        (result.lastError ?? '').includes('INVALID_PAIR_ADDRESS') ||
        (result.lastError ?? '').includes('Invalid public key') ||
        (result.lastError ?? '').includes('invalid public key');
      const isPoolNotFound = (result.lastError ?? '').includes('Pool account not found');
      if (isInvalidPairKey || isPoolNotFound) {
        const pairFromApi = await getPairFromApi(d.mint);
        if (pairFromApi && pairFromApi.pair_address !== pair.pair_address) {
          result = await trySellWithLadder(pairFromApi);
          if (result.sold) continue;
          const reason = pumpSwapErrorReason(result.lastError ?? '');
          console.warn(
            `Failed to sell ${tokenName} mint=${d.mint} pair=${pairFromApi.pair_address}: ${reason} (API retry)`
          );
          continue;
        }
        const reason = pumpSwapErrorReason(result.lastError ?? '');
        console.warn(
          `Failed to sell ${tokenName} mint=${d.mint} pair=${pair.pair_address}: ${reason} (no different pair from API)`
        );
        continue;
      }
      const reason = pumpSwapErrorReason(result.lastError ?? '');
      console.warn(`Failed to sell ${tokenName} mint=${d.mint} pair=${pair.pair_address}: ${reason}`);
    }
  }
}

main();
