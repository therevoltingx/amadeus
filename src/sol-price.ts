/**
 * SOL price in USD. Single source for any code that converts SOL ↔ USD.
 * When HELIUS_RPC_URL and CHAINLINK_SOL_USD_FEED_ADDRESS are set, uses Chainlink feed via RPC.
 * Otherwise: CoinGecko (fallback: Binance), in-memory cache 1 min.
 */
import { Connection } from '@solana/web3.js';
import { getSolanaRpcUrl } from './config.js';
import { getSolPriceUsdFromChainlink } from './sol-price-chainlink.js';

const SOL_PRICE_CACHE_TTL_MS = 60_000; // 1 minute
let solPriceCache: { price: number; ts: number } | null = null;

/**
 * Returns current SOL price in USD.
 * Use this wherever you need to convert SOL (lamports/native) to or from USD.
 * Pass skipCache=true to force a fresh fetch (e.g. for actual_usd_bought/sold that must match chain).
 */
export async function getSolPriceUsd(skipCache = false): Promise<number> {
  const now = Date.now();
  if (!skipCache && solPriceCache && now - solPriceCache.ts < SOL_PRICE_CACHE_TTL_MS) {
    return solPriceCache.price;
  }

  const rpcUrl = getSolanaRpcUrl();
  const chainlinkFeed = process.env.CHAINLINK_SOL_USD_FEED_ADDRESS?.trim();
  if (rpcUrl && chainlinkFeed) {
    try {
      const connection = new Connection(rpcUrl, { commitment: 'confirmed' });
      const price = await getSolPriceUsdFromChainlink(connection, chainlinkFeed);
      if (price != null && Number.isFinite(price) && price > 0) {
        solPriceCache = { price, ts: now };
        return price;
      }
    } catch {
      // fall through to API fallbacks
    }
  }

  const fetchOpts = { signal: AbortSignal.timeout(10_000) };

  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      fetchOpts
    );
    if (res.ok) {
      const data = (await res.json()) as { solana?: { usd?: number } };
      const price = data?.solana?.usd;
      if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
        solPriceCache = { price, ts: now };
        return price;
      }
    }
  } catch {
    // fall through to Binance
  }

  try {
    const binanceRes = await fetch(
      'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT',
      { signal: AbortSignal.timeout(10_000) }
    );
    if (binanceRes.ok) {
      const binanceData = (await binanceRes.json()) as { price?: string };
      const price = parseFloat(binanceData?.price ?? '');
      if (Number.isFinite(price) && price > 0) {
        solPriceCache = { price, ts: now };
        return price;
      }
    }
  } catch {
    // fall through to stale cache or throw
  }

  if (solPriceCache && Number.isFinite(solPriceCache.price) && solPriceCache.price > 0) {
    return solPriceCache.price;
  }

  throw new Error(
    'SOL_PRICE_API_ERROR: could not get SOL price (Chainlink, CoinGecko and Binance failed) and no cached value available'
  );
}
