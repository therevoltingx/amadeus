/**
 * Chain-specific address validators. Add new chains here; keep core logic chain-agnostic.
 */

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** True if the string contains only base58 characters (no 0, O, I, l). */
export function isBase58(s: string): boolean {
  if (!s || s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    if (!BASE58_ALPHABET.includes(s[i])) return false;
  }
  return true;
}

/** Remove any character that is not base58. Use to fix stray newlines/spaces in stored addresses. */
export function sanitizeToBase58(s: string): string {
  if (!s) return '';
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (BASE58_ALPHABET.includes(s[i])) out += s[i];
  }
  return out;
}

/**
 * Validate a Solana wallet address: base58, 32–44 chars, no whitespace.
 */
export function validateSolanaAddress(address: string): { valid: boolean; error?: string } {
  const trimmed = address.trim();
  if (trimmed !== address) {
    return { valid: false, error: 'Address must not have leading or trailing whitespace' };
  }
  if (trimmed.length < 32 || trimmed.length > 44) {
    return { valid: false, error: 'Solana address must be 32–44 characters' };
  }
  if (!isBase58(trimmed)) {
    return { valid: false, error: 'Solana address must be base58 (no 0, O, I, l)' };
  }
  return { valid: true };
}

const CHAIN_VALIDATORS: Record<string, (address: string) => { valid: boolean; error?: string }> = {
  solana: validateSolanaAddress,
};

/**
 * Validate address for a given chain. Returns { valid, error? }.
 */
export function validateAddressForChain(chain: string, address: string): { valid: boolean; error?: string } {
  const validator = CHAIN_VALIDATORS[chain];
  if (!validator) {
    return { valid: false, error: `Unknown chain: ${chain}` };
  }
  return validator(address);
}

export const SUPPORTED_CHAINS = ['solana'] as const;
export type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

export function isSupportedChain(chain: string): chain is SupportedChain {
  return SUPPORTED_CHAINS.includes(chain as SupportedChain);
}
