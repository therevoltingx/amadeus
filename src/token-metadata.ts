/**
 * Fetch token name and symbol from Metaplex Token Metadata account data (on-chain).
 * No external SDK; parses the standard metadata account layout.
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { stripPgNul } from './db/pg-text.js';
import { getHeliusRpcUrl } from './config.js';

/** Metaplex Token Metadata program ID. */
const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
);

/** Fixed offset after key (1) + update_authority (32) + mint (32). Data struct starts with name. */
const DATA_OFFSET = 1 + 32 + 32;

/** Max chars to store for name/symbol (DB and display). */
const MAX_NAME_LEN = 32;
const MAX_SYMBOL_LEN = 10;

export interface TokenNameSymbol {
  name: string;
  symbol: string;
}

/**
 * Derive the Metaplex metadata PDA for a mint.
 */
function getMetadataPda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from('metadata', 'utf8'),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID
  );
  return pda;
}

/**
 * Read u32 LE from buffer at offset.
 */
function readU32LE(buf: Uint8Array, offset: number): number {
  return (
    buf[offset]! |
    (buf[offset + 1]! << 8) |
    (buf[offset + 2]! << 16) |
    (buf[offset + 3]! << 24)
  ) >>> 0;
}

/**
 * Parse name and symbol from metadata account data.
 * Layout from offset DATA_OFFSET: u32 name_len (LE), name bytes, u32 symbol_len (LE), symbol bytes.
 */
function parseNameSymbolFromData(data: Uint8Array): TokenNameSymbol | null {
  if (data.length < DATA_OFFSET + 4 + 4) return null;
  let offset = DATA_OFFSET;

  const nameLen = readU32LE(data, offset);
  offset += 4;
  if (nameLen <= 0 || nameLen > 256 || offset + nameLen + 4 > data.length)
    return null;
  const nameBytes = data.subarray(offset, offset + nameLen);
  offset += nameLen;

  const symbolLen = readU32LE(data, offset);
  offset += 4;
  if (symbolLen <= 0 || symbolLen > 64 || offset + symbolLen > data.length)
    return null;
  const symbolBytes = data.subarray(offset, offset + symbolLen);

  let name: string;
  let symbol: string;
  try {
    name = new TextDecoder('utf8', { fatal: false }).decode(nameBytes).trim();
    symbol = new TextDecoder('utf8', { fatal: false })
      .decode(symbolBytes)
      .trim();
  } catch {
    return null;
  }
  if (!name && !symbol) return null;
  return {
    name: stripPgNul(name).slice(0, MAX_NAME_LEN) || 'Unknown',
    symbol: stripPgNul(symbol).slice(0, MAX_SYMBOL_LEN) || '?',
  };
}

/**
 * Fetch token name and symbol from the Metaplex metadata account for the given mint.
 * Returns null if the account is missing, unparseable, or on RPC error.
 */
export async function getTokenNameSymbol(
  connection: Connection,
  mintAddress: string | PublicKey
): Promise<TokenNameSymbol | null> {
  const mint = typeof mintAddress === 'string' ? new PublicKey(mintAddress) : mintAddress;
  const metadataPda = getMetadataPda(mint);
  try {
    const accountInfo = await connection.getAccountInfo(metadataPda);
    if (!accountInfo?.data || accountInfo.data.length < DATA_OFFSET + 8) return null;
    return parseNameSymbolFromData(accountInfo.data);
  } catch {
    return null;
  }
}

/** Helius DAS getAsset response shape (subset we use). */
interface HeliusGetAssetResult {
  result?: {
    content?: {
      metadata?: { name?: string; symbol?: string };
    };
  };
}

/**
 * Fetch token name and symbol via Helius DAS getAsset (same RPC endpoint as standard Solana RPC).
 * Returns null on missing URL, non-2xx, or when metadata has no name/symbol.
 */
export async function getTokenNameSymbolFromHelius(
  heliusRpcUrl: string,
  mintAddress: string
): Promise<TokenNameSymbol | null> {
  try {
    const res = await fetch(heliusRpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'getAsset',
        params: { id: mintAddress, options: { showFungible: true } },
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as HeliusGetAssetResult;
    const meta = data?.result?.content?.metadata;
    if (!meta) return null;
    const name =
      typeof meta.name === 'string'
        ? stripPgNul(meta.name).trim().slice(0, MAX_NAME_LEN) || 'Unknown'
        : 'Unknown';
    const symbol =
      typeof meta.symbol === 'string'
        ? stripPgNul(meta.symbol).trim().slice(0, MAX_SYMBOL_LEN) || '?'
        : '?';
    if (!name && !symbol) return null;
    return { name: name || 'Unknown', symbol: symbol || '?' };
  } catch {
    return null;
  }
}

export interface GetTokenNameSymbolWithFallbackOptions {
  /** Override Helius RPC URL; otherwise uses getHeliusRpcUrl() from config. */
  heliusRpcUrl?: string;
}

/**
 * Fetch token name and symbol: try Metaplex first; only call Helius when Metaplex returns null
 * (do not call Helius if the name/symbol is already known from Metaplex).
 */
export async function getTokenNameSymbolWithFallback(
  connection: Connection,
  mintAddress: string | PublicKey,
  options?: GetTokenNameSymbolWithFallbackOptions
): Promise<TokenNameSymbol | null> {
  const meta = await getTokenNameSymbol(connection, mintAddress);
  if (meta != null && (meta.name?.trim() || meta.symbol?.trim())) {
    return meta;
  }
  const heliusUrl = options?.heliusRpcUrl ?? getHeliusRpcUrl();
  if (!heliusUrl) return null;
  const mintStr = typeof mintAddress === 'string' ? mintAddress : mintAddress.toBase58();
  return getTokenNameSymbolFromHelius(heliusUrl, mintStr);
}
