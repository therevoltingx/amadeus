/**
 * Token holder stats from on-chain data via Helius getProgramAccountsV2 (SPL Token + Token-2022).
 * Used by the chain-snapshots worker to fill top_holder_pct, top_5_holder_pct, holder_count.
 * Pump.fun / PumpSwap tokens are often Token-2022, so we query both programs.
 * Requires HELIUS_RPC_URL; basic Solana RPC is not used.
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { getHeliusRpcUrl } from './config.js';
import type { HolderInfo } from './types/holder.js';

/** SPL Token account layout: mint 32, owner 32, amount (u64) at 64. Same for Token-2022. */
const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;
const TOKEN_ACCOUNT_DATA_SIZE = 165;
/** Token-2022 accounts can have variable size (base + extensions); we match by mint only. */
/** Max token accounts to fetch per program for holder stats (enough for top-5 and count). */
const HOLDER_ACCOUNTS_LIMIT = 1000;

function readU64LE(data: Uint8Array, offset: number): bigint {
  if (offset + 8 > data.length) return 0n;
  const view = new DataView(data.buffer, data.byteOffset + offset, 8);
  const lo = view.getUint32(0, true);
  const hi = view.getUint32(4, true);
  return (BigInt(hi) << 32n) | BigInt(lo);
}

/**
 * Fetch mint supply (raw units) from mint account. Supply at offset 36, 8 bytes u64 LE.
 */
async function getMintSupplyRaw(
  connection: Connection,
  mintAddress: string
): Promise<bigint | null> {
  try {
    const info = await connection.getAccountInfo(new PublicKey(mintAddress));
    if (!info?.data || info.data.length < 44) return null;
    return readU64LE(info.data, 36);
  } catch {
    return null;
  }
}

const DATA_SLICE = {
  offset: TOKEN_ACCOUNT_AMOUNT_OFFSET,
  length: 8,
};

/** Helius getProgramAccountsV2: fetch token accounts with limit to reduce RPC load. Throws on 429 so caller can retry. */
async function getProgramAccountsHeliusV2(
  heliusRpcUrl: string,
  programId: string,
  filters: Array<{ dataSize?: number; memcmp?: { offset: number; bytes: string } }>,
  dataSlice: { offset: number; length: number },
  limit: number
): Promise<Array<{ account: { data: Uint8Array } }>> {
  const body = {
    jsonrpc: '2.0',
    id: '1',
    method: 'getProgramAccountsV2',
    params: [
      programId,
      {
        commitment: 'confirmed',
        encoding: 'base64',
        filters,
        dataSlice,
        limit,
      },
    ],
  };
  const res = await fetch(heliusRpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 429) {
    throw new Error(`Server responded with ${res.status} Too Many Requests. Retrying after delay...`);
  }
  if (!res.ok) return [];
  const data = (await res.json()) as {
    result?: { accounts?: Array<{ account: { data: string } }> };
    error?: unknown;
  };
  if (data.error || !data.result?.accounts) return [];
  return data.result.accounts.map((item) => ({
    account: {
      data: new Uint8Array(Buffer.from(item.account.data, 'base64')),
    },
  }));
}

/**
 * Get holder count and top-holder percentages for an SPL or Token-2022 token using getProgramAccounts.
 * Queries both TOKEN_PROGRAM_ID and TOKEN_2022_PROGRAM_ID (Pump.fun tokens are often Token-2022).
 * Uses dataSlice to fetch only the amount field (8 bytes) per account.
 * When supplyRaw is provided (e.g. from pool snapshot), skips getMintSupplyRaw to avoid duplicate RPC.
 * Returns null on RPC failure or if mint supply is 0 (cannot compute %).
 */
export async function getTokenHolderInfoFromChain(
  connection: Connection,
  mintAddress: string,
  options?: { supplyRaw?: bigint | null }
): Promise<HolderInfo | null> {
  try {
    const supplyRaw =
      options?.supplyRaw != null
        ? options.supplyRaw
        : await getMintSupplyRaw(connection, mintAddress);
    if (supplyRaw == null || supplyRaw === 0n) return null;

    const heliusUrl = getHeliusRpcUrl();
    if (!heliusUrl) return null;

    const filtersStandard = [
      { dataSize: TOKEN_ACCOUNT_DATA_SIZE },
      { memcmp: { offset: 0, bytes: mintAddress } },
    ];
    const filters2022 = [{ memcmp: { offset: 0, bytes: mintAddress } }];

    const [tokenAccounts, token2022Accounts] = await Promise.all([
      getProgramAccountsHeliusV2(
        heliusUrl,
        TOKEN_PROGRAM_ID.toBase58(),
        filtersStandard,
        DATA_SLICE,
        HOLDER_ACCOUNTS_LIMIT
      ),
      getProgramAccountsHeliusV2(
        heliusUrl,
        TOKEN_2022_PROGRAM_ID.toBase58(),
        filters2022,
        DATA_SLICE,
        HOLDER_ACCOUNTS_LIMIT
      ),
    ]);

    const accounts = [...tokenAccounts, ...token2022Accounts];
    const amounts = accounts
      .map((a) => readU64LE(a.account.data, 0))
      .filter((a) => a > 0n);
    const holderCount = amounts.length;
    if (holderCount === 0) {
      return {
        holderCount: 0,
        topHolderPct: null,
        top5HolderPct: null,
        walletConcentrationScore: null,
      };
    }
    amounts.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
    const top1 = amounts[0] ?? 0n;
    const top5Sum = amounts.slice(0, 5).reduce((s, n) => s + n, 0n);
    const topHolderPct = Number((top1 * 10000n) / supplyRaw) / 100;
    const top5HolderPct = Number((top5Sum * 10000n) / supplyRaw) / 100;
    const walletConcentrationScore = top5HolderPct;
    return {
      holderCount,
      topHolderPct: Number.isFinite(topHolderPct) ? topHolderPct : null,
      top5HolderPct: Number.isFinite(top5HolderPct) ? top5HolderPct : null,
      walletConcentrationScore: Number.isFinite(walletConcentrationScore)
        ? walletConcentrationScore
        : null,
    };
  } catch {
    return null;
  }
}
