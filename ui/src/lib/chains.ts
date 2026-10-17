/**
 * Chain options for UI. Add new chains here; keep UI chain-agnostic.
 */
export const CHAIN_OPTIONS = [
  { value: 'solana', label: 'Solana' },
] as const;

export type ChainValue = (typeof CHAIN_OPTIONS)[number]['value'];

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

export function validateSolanaAddress(address: string): string | null {
  const t = address.trim();
  if (t !== address) return 'Address must not have leading or trailing spaces';
  if (t.length < 32 || t.length > 44) return 'Solana address must be 32–44 characters';
  if (!BASE58.test(t)) return 'Solana address must be base58 (no 0, O, I, l)';
  return null;
}

export function validateAddressForChain(chain: string, address: string): string | null {
  if (chain === 'solana') return validateSolanaAddress(address);
  return 'Unsupported chain';
}

export function isValidHttpUrl(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  try {
    const u = new URL(t);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
