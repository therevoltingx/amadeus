/**
 * Account balance worker: polls active live Solana accounts and updates balance_native
 * using global HELIUS_RPC_URL. Paper accounts are skipped. Cached in DB only.
 */
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { getSolanaRpcUrl, warnIfSolanaRpcMissing } from '../config.js';
import { db, SOLANA_DEFAULT_ACCOUNT_ID } from '../db.js';
import { getSolanaPublicKeyString } from '../solana-signer.js';
import { fetchNativeBalance } from '../balance-fetcher.js';

const POLL_INTERVAL_MS = 90_000; // 90 seconds (within 60–120s)
const LOG_PREFIX = '[account-balance-worker]';

async function runBalanceSync(): Promise<void> {
  const rows = db
    .prepare(
      `SELECT account_id, mode, chain, address
       FROM accounts WHERE mode = 'live' AND chain = 'solana'`
    )
    .all() as { account_id: string; mode: string; chain: string | null; address: string | null }[];

  if (rows.length === 0) {
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const updateStmt = db.prepare(
    `UPDATE accounts SET balance_native = $balanceNative, balance_last_updated = $balanceLastUpdated, updated_at = $updatedAt WHERE account_id = $accountId`
  );
  const updateAddressStmt = db.prepare(
    `UPDATE accounts SET address = $address, updated_at = $updatedAt WHERE account_id = $accountId AND (address IS NULL OR address = '')`
  );

  const derivedAddress = getSolanaPublicKeyString();
  for (const account of rows) {
    const usedDerived = !account.address?.trim() && !!derivedAddress;
    const accountForBalance = usedDerived
      ? { ...account, address: derivedAddress }
      : account;
    try {
      const balance = await fetchNativeBalance(accountForBalance);
      if (balance !== null) {
        updateStmt.run({ balanceNative: balance, balanceLastUpdated: now, updatedAt: now, accountId: account.account_id });
        if (usedDerived && derivedAddress) {
          updateAddressStmt.run({ address: derivedAddress, updatedAt: now, accountId: account.account_id });
        }
        console.log(
          JSON.stringify({
            event: 'balance_synced',
            account_id: account.account_id,
            chain: account.chain ?? 'solana',
            balance_native: balance,
          })
        );
        console.log(`${LOG_PREFIX} ${account.account_id} balance: ${balance.toFixed(4)} SOL`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        JSON.stringify({
          event: 'balance_sync_failed',
          account_id: account.account_id,
          error: msg,
        })
      );
    }
  }
}

function main(): void {
  const rpcPresent = !!getSolanaRpcUrl();
  console.log(
    JSON.stringify({
      event: 'solana_rpc_configured',
      rpc_present: rpcPresent,
    })
  );
  const liveSolanaCount = (db.prepare(
    `SELECT COUNT(*) AS n FROM accounts WHERE mode = 'live' AND chain = 'solana'`
  ).get() as { n: number }).n;
  warnIfSolanaRpcMissing(liveSolanaCount);
  console.log(`${LOG_PREFIX} Starting (poll every ${POLL_INTERVAL_MS / 1000}s, all live Solana accounts)`);
  void runBalanceSync();
  setInterval(() => void runBalanceSync(), POLL_INTERVAL_MS);
}

const isMain =
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1]?.endsWith('account-balance-worker.js');

if (isMain) {
  main();
}

export { runBalanceSync };
