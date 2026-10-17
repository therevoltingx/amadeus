/**
 * Chain-aware native balance fetcher. No private keys; read-only RPC.
 * Uses single global Solana RPC from config. Paper accounts are skipped.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { getSolanaRpcUrl } from './config.js';

export interface AccountForBalance {
  account_id: string;
  mode: string;
  chain: string | null;
  address: string | null;
}

const LAMPORTS_PER_SOL = 1e9;
const RPC_TIMEOUT_MS = 5_000;

/**
 * Fetch Solana native balance (SOL) using global HELIUS_RPC_URL.
 * Throws if HELIUS_RPC_URL not configured. Worker must catch and log.
 */
export async function fetchSolanaBalance(account: AccountForBalance): Promise<number | null> {
  const rpcUrl = getSolanaRpcUrl();
  if (!rpcUrl) {
    throw new Error('HELIUS_RPC_URL not configured');
  }
  if (!account.address?.trim()) {
    console.warn(`[balance-fetcher] Solana account ${account.account_id} missing address`);
    return null;
  }
  try {
    const connection = new Connection(rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: RPC_TIMEOUT_MS,
    });
    const publicKey = new PublicKey(account.address.trim());
    const balancePromise = connection.getBalance(publicKey, 'confirmed');
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('RPC timeout')), RPC_TIMEOUT_MS)
    );
    const balanceLamports = await Promise.race([balancePromise, timeoutPromise]);
    const sol = balanceLamports / LAMPORTS_PER_SOL;
    return sol;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        event: 'balance_sync_failed',
        account_id: account.account_id,
        error: msg,
      })
    );
    return null;
  }
}

/**
 * Fetch native balance for an account. Chain-aware; paper accounts return null.
 * On unsupported chain or failure, returns null (worker survives RPC hiccups).
 */
export async function fetchNativeBalance(account: AccountForBalance): Promise<number | null> {
  if (account.mode === 'paper') {
    return null;
  }
  const chain = (account.chain ?? '').toLowerCase();
  if (chain === 'solana') {
    return fetchSolanaBalance(account);
  }
  console.warn(`[balance-fetcher] Unsupported chain for balance: ${chain}`);
  return null;
}
