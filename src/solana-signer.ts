/**
 * Solana signer loaded exclusively from env (SOLANA_PRIVATE_KEY).
 * Never read from DB or UI. Memoized singleton. Never log the key.
 */
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { getSolanaPrivateKeyRaw } from './config.js';

let memoizedSigner: Keypair | null = null;

/**
 * Parse SOLANA_PRIVATE_KEY. Supports:
 * - base58: single line, 64-byte secret key encoded as base58
 * - JSON array: Phantom-style, e.g. [1,2,...,64]
 * Never logs the key. Throws on missing or invalid.
 */
function parsePrivateKeyToBytes(raw: string): Uint8Array {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error('SOLANA_PRIVATE_KEY_INVALID');
  }
  // JSON array (e.g. [1,2,...,64])
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed) as unknown;
      if (!Array.isArray(arr) || arr.length !== 64) {
        throw new Error('SOLANA_PRIVATE_KEY_INVALID');
      }
      const bytes = new Uint8Array(64);
      for (let i = 0; i < 64; i++) {
        const n = Number(arr[i]);
        if (!Number.isInteger(n) || n < 0 || n > 255) {
          throw new Error('SOLANA_PRIVATE_KEY_INVALID');
        }
        bytes[i] = n;
      }
      return bytes;
    } catch (e) {
      if (e instanceof Error && e.message === 'SOLANA_PRIVATE_KEY_INVALID') throw e;
      throw new Error('SOLANA_PRIVATE_KEY_INVALID');
    }
  }
  // base58
  try {
    const decoded = bs58.decode(trimmed);
    if (decoded.length !== 64) {
      throw new Error('SOLANA_PRIVATE_KEY_INVALID');
    }
    return new Uint8Array(decoded);
  } catch {
    throw new Error('SOLANA_PRIVATE_KEY_INVALID');
  }
}

/**
 * Return the Solana Keypair for live execution. Loaded from SOLANA_PRIVATE_KEY only.
 * Memoized (singleton). Throws if not configured or invalid.
 */
export function getSolanaSigner(): Keypair {
  if (memoizedSigner) return memoizedSigner;
  const raw = getSolanaPrivateKeyRaw();
  if (!raw) {
    throw new Error('SOLANA_PRIVATE_KEY_NOT_CONFIGURED');
  }
  const bytes = parsePrivateKeyToBytes(raw);
  memoizedSigner = Keypair.fromSecretKey(bytes);
  return memoizedSigner;
}

/**
 * Return the Solana public key (base58) derived from SOLANA_PRIVATE_KEY, or undefined if not configured.
 * Used for balance fetch and display when account address is not stored.
 */
export function getSolanaPublicKeyString(): string | undefined {
  try {
    return getSolanaSigner().publicKey.toBase58();
  } catch {
    return undefined;
  }
}
