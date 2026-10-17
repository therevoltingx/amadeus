/**
 * Moralis API for Solana token holder data.
 * Used only when MORALIS_API_KEY is set in the environment.
 */
import type { HolderInfo } from '../types/holder.js';

const MORALIS_BASE = 'https://solana-gateway.moralis.io';
const MORALIS_NETWORK = 'mainnet';

function getApiKey(): string {
  return process.env.MORALIS_API_KEY ?? '';
}

/**
 * Fetch holder count for a Solana token from Moralis token holder stats.
 * GET /token/:network/holders/:address → { totalHolders: number }
 */
async function fetchHolderCount(tokenAddress: string): Promise<number | null> {
  const key = getApiKey();
  if (!key) return null;
  const url = `${MORALIS_BASE}/token/${MORALIS_NETWORK}/holders/${encodeURIComponent(tokenAddress)}`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'X-API-Key': key },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { totalHolders?: number };
    const n = data?.totalHolders;
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Fetch top token holders and derive top holder % and top 5 holder %.
 * GET /token/:network/:address/top-holders?limit=5 → { result: [ { percentageRelativeToTotalSupply } ] }
 */
async function fetchTopHolderPcts(tokenAddress: string): Promise<{
  topHolderPct: number | null;
  top5HolderPct: number | null;
}> {
  const key = getApiKey();
  if (!key) return { topHolderPct: null, top5HolderPct: null };
  const url = `${MORALIS_BASE}/token/${MORALIS_NETWORK}/${encodeURIComponent(tokenAddress)}/top-holders?limit=5`;
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'X-API-Key': key },
    });
    if (!res.ok) return { topHolderPct: null, top5HolderPct: null };
    const data = (await res.json()) as {
      result?: Array<{ percentageRelativeToTotalSupply?: string | number }>;
    };
    const list = data?.result;
    if (!Array.isArray(list) || list.length === 0)
      return { topHolderPct: null, top5HolderPct: null };

    const pcts = list
      .slice(0, 5)
      .map((h) => {
        const v = h?.percentageRelativeToTotalSupply;
        if (v == null) return null;
        const n = typeof v === 'string' ? parseFloat(v) : Number(v);
        return Number.isFinite(n) ? n : null;
      })
      .filter((n): n is number => n !== null);

    const topHolderPct = pcts[0] ?? null;
    const top5HolderPct =
      pcts.length > 0 ? pcts.reduce((a, b) => a + b, 0) : null;
    return { topHolderPct, top5HolderPct };
  } catch {
    return { topHolderPct: null, top5HolderPct: null };
  }
}

/**
 * Get holder info for a Solana token from Moralis. Returns null if MORALIS_API_KEY is not set
 * or if the API calls fail. Runs holder-stats and top-holders in parallel.
 */
export async function getTokenHolderInfo(tokenAddress: string): Promise<HolderInfo | null> {
  if (!getApiKey()) return null;
  const [holderCount, { topHolderPct, top5HolderPct }] = await Promise.all([
    fetchHolderCount(tokenAddress),
    fetchTopHolderPcts(tokenAddress),
  ]);
  const hasAny =
    holderCount != null || topHolderPct != null || top5HolderPct != null;
  if (!hasAny) return null;
  return {
    topHolderPct: topHolderPct ?? null,
    top5HolderPct: top5HolderPct ?? null,
    holderCount: holderCount ?? null,
    walletConcentrationScore: top5HolderPct ?? null,
  };
}
