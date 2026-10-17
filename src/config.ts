/**
 * Global runtime config.
 * LIVE_TRADING_ENABLED must be 'true' to execute live trades.
 * HELIUS_RPC_URL is the single RPC endpoint (Helius only; no direct Solana RPC).
 * SOLANA_PRIVATE_KEY is the signer for live Solana execution (env only, never in DB/UI).
 * LIVE_EXECUTION_DRY_RUN when 'true' skips sending live transactions (simulate only).
 */
export function isLiveTradingEnabled(): boolean {
  return process.env.LIVE_TRADING_ENABLED === 'true';
}

/** When true, live Solana executor does not send transactions (simulate only). */
export function isLiveExecutionDryRun(): boolean {
  return process.env.LIVE_EXECUTION_DRY_RUN === 'true';
}

/** Global RPC URL (Helius only). From env HELIUS_RPC_URL. Used for all Solana RPC and balance fetch. */
export function getSolanaRpcUrl(): string | undefined {
  const u = process.env.HELIUS_RPC_URL?.trim();
  return u && u.length > 0 ? u : undefined;
}

/** Same as getSolanaRpcUrl(); Helius is the only supported RPC provider. */
export function getHeliusRpcUrl(): string | undefined {
  return getSolanaRpcUrl();
}

/**
 * Call at boot when live Solana accounts exist. If HELIUS_RPC_URL is missing, logs a loud warning.
 * Does NOT crash — keeps local dev smooth.
 */
export function warnIfSolanaRpcMissing(liveSolanaAccountCount: number): void {
  if (liveSolanaAccountCount === 0) return;
  const rpc = getSolanaRpcUrl();
  if (rpc) return;
  console.warn(
    '[config] HELIUS_RPC_URL is not set but you have %d live Solana account(s). Balance sync and RPC will fail until HELIUS_RPC_URL is set.',
    liveSolanaAccountCount
  );
}

/** Raw SOLANA_PRIVATE_KEY string from env. Never log or expose. */
export function getSolanaPrivateKeyRaw(): string | undefined {
  const raw = process.env.SOLANA_PRIVATE_KEY;
  if (!raw || typeof raw !== 'string') return undefined;
  const t = raw.trim();
  return t.length > 0 ? t : undefined;
}

/** If live Solana accounts exist and SOLANA_PRIVATE_KEY is missing, log warning. Does NOT crash. */
export function warnIfSolanaKeyMissing(liveSolanaAccountCount: number): void {
  if (liveSolanaAccountCount === 0) return;
  if (getSolanaPrivateKeyRaw()) return;
  console.warn(
    '[config] SOLANA_PRIVATE_KEY is not set but you have live Solana account(s). Live execution will fail until SOLANA_PRIVATE_KEY is set.'
  );
}

/** Parsed set of enabled DEX ids (lowercase). null = allow all (no filter). */
let enabledDexesCache: Set<string> | null | undefined = undefined;

/**
 * DEXes allowed for ingestion (pairs worker, dexscreener scraper, snapshots worker).
 * From env ENABLED_DEXES (comma-separated, e.g. raydium,pumpswap,pumpfun).
 * If unset or empty string, returns null = no filter (all DEXes allowed).
 */
export function getEnabledDexes(): Set<string> | null {
  if (enabledDexesCache !== undefined) return enabledDexesCache;
  const raw = process.env.ENABLED_DEXES?.trim();
  if (!raw) {
    enabledDexesCache = null;
    return null;
  }
  const set = new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  enabledDexesCache = set.size > 0 ? set : null;
  return enabledDexesCache;
}
