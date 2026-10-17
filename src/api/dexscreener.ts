const DEXSCREENER_BASE = 'https://api.dexscreener.com';

export interface DexScreenerToken {
  address: string;
  name: string;
  symbol: string;
}

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: DexScreenerToken;
  quoteToken: DexScreenerToken;
  pairCreatedAt?: number;
  creatorWallet?: string | null;
  priceUsd?: string;
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  volume?: { m5?: number; h1?: number; h6?: number; h24?: number };
  txns?: {
    m5?: { buys: number; sells: number };
    h1?: { buys: number; sells: number };
    h6?: { buys: number; sells: number };
    h24?: { buys: number; sells: number };
  };
  liquidity?: { usd?: number; base?: number; quote?: number };
  fdv?: number;
  marketCap?: number;
  /** Holder count from pair detail page (e.g. "Holders (N)" tab). Set when scraping the page. */
  holderCount?: number | null;
  /** Mint authority from Audit section (1 = yes, 0 = no). Set when scraping the pair detail page. */
  hasMintAuthority?: number | null;
  /** Freeze authority from Audit section (1 = yes, 0 = no). Set when scraping the pair detail page. */
  hasFreezeAuthority?: number | null;
}

export interface TokenProfile {
  chainId: string;
  tokenAddress: string;
  url: string;
}

export async function fetchTokenProfiles(): Promise<TokenProfile[]> {
  const res = await fetch(`${DEXSCREENER_BASE}/token-profiles/latest/v1`);
  if (!res.ok) throw new Error(`DexScreener token-profiles failed: ${res.status}`);
  const data: unknown = await res.json();
  if (!Array.isArray(data)) return [];
  return data.filter(
    (p): p is TokenProfile =>
      p != null &&
      typeof p.chainId === 'string' &&
      typeof p.tokenAddress === 'string'
  );
}

/** Parse "X <unit>" into seconds. Supports s,m,h,d and full names (min, minutes, hour, hours, etc.). */
function parseAgeUnitToSeconds(num: number, unit: string): number {
  const u = unit.toLowerCase().replace(/s$/, '');
  if (u === 's' || u === 'sec' || u === 'second') return num * 1;
  if (u === 'm' || u === 'min' || u === 'minute') return num * 60;
  if (u === 'h' || u === 'hr' || u === 'hour') return num * 3600;
  if (u === 'd' || u === 'day') return num * 86400;
  if (u === 'wk' || u === 'week') return num * 604800;
  if (u === 'mo' || u === 'month') return num * 2592000;
  if (u === 'y' || u === 'yr' || u === 'year') return num * 31536000;
  return num * 60;
}

const AGE_UNIT_PATTERN =
  '(s|m|h|d|min|mins|minute|minutes|hr|hrs|hour|hours|sec|secs|second|seconds|day|days|wk|wks|week|weeks|mo|month|months|yr|yrs|year|years)';

/**
 * Extract pair created_at (epoch seconds) from "Pair created X ago" on the pair detail page HTML.
 * Handles formats like "6m ago", "6 min ago", "6 minutes ago", "2y 7mo 8d ago" (first segment only).
 */
export function parsePairCreatedAtFromHtml(html: string): number | null {
  const now = Math.floor(Date.now() / 1000);
  const patterns: Array<RegExp> = [
    new RegExp(`Pair\\s+created\\s+(\\d+)\\s*${AGE_UNIT_PATTERN}(?:\\s*ago)?`, 'i'),
    new RegExp(`Pair\\s+created[\\s\\S]{0,120}?(\\d+)\\s*${AGE_UNIT_PATTERN}(?:\\s*ago)?`, 'i'),
    new RegExp(`(\\d+)\\s*${AGE_UNIT_PATTERN}\\s*ago`, 'i'),
    new RegExp(`age[^0-9]*(\\d+)\\s*${AGE_UNIT_PATTERN}\\b`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const num = parseInt(m[1], 10);
      const unit = m[2];
      if (Number.isFinite(num) && num >= 0 && num <= 9999) {
        const secondsAgo = parseAgeUnitToSeconds(num, unit);
        return now - secondsAgo;
      }
    }
  }
  return null;
}

/** Extract pairCreatedAt from raw API response (pairCreatedAt or pair_created_at). Returns seconds since epoch. */
export function parsePairCreatedAt(pair: Record<string, unknown>): number | null {
  const raw = pair['pairCreatedAt'] ?? pair['pair_created_at'];
  if (raw == null || typeof raw !== 'number' || !Number.isFinite(raw))
    return null;
  const ts = raw;
  // DexScreener returns milliseconds; if already seconds (1e9–1e10 range), use as-is
  if (ts >= 1e12) return Math.floor(ts / 1000);
  if (ts >= 1e9 && ts <= 1e10) return Math.floor(ts);
  return Math.floor(ts / 1000);
}

export async function fetchTokenPairs(
  chainId: string,
  tokenAddress: string
): Promise<DexScreenerPair[]> {
  const res = await fetch(
    `${DEXSCREENER_BASE}/token-pairs/v1/${chainId}/${tokenAddress}`
  );
  if (!res.ok) return [];
  const pairs: DexScreenerPair[] = await res.json();
  return Array.isArray(pairs) ? pairs : [];
}

/** Fetch a single pair by chain and pair address. Returns null on 404 or error. */
export async function fetchPairByAddress(
  chainId: string,
  pairAddress: string
): Promise<DexScreenerPair | null> {
  const res = await fetch(
    `${DEXSCREENER_BASE}/latest/dex/pairs/${chainId}/${encodeURIComponent(pairAddress)}`
  );
  if (!res.ok) return null;
  const data: unknown = await res.json();
  if (data != null && typeof data === 'object' && 'pairs' in data) {
    const arr = (data as { pairs: unknown }).pairs;
    if (Array.isArray(arr) && arr.length > 0) return arr[0] as DexScreenerPair;
  }
  if (Array.isArray(data) && data.length > 0) return data[0] as DexScreenerPair;
  if (data != null && typeof data === 'object' && 'pairAddress' in data)
    return data as DexScreenerPair;
  return null;
}
