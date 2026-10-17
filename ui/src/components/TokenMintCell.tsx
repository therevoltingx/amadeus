import { useState } from 'react';
import './TokenMintCell.css';

const SOLSCAN_TOKEN_URL = 'https://solscan.io/token';
const DEXSCREENER_TOKEN_URL = 'https://dexscreener.com/solana';

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export type TokenMintCellLinkTo = 'solscan' | 'dexscreener';

interface TokenMintCellProps {
  mint: string;
  symbol?: string | null;
  /** Default 'solscan'. Use 'dexscreener' for Leaderboard token links. */
  linkTo?: TokenMintCellLinkTo;
  /** When set and linkTo is dexscreener, append ?maker= to the URL (e.g. for live wallet in Leaderboard). */
  makerAddress?: string | null;
}

export function TokenMintCell({ mint, symbol, linkTo = 'solscan', makerAddress }: TokenMintCellProps) {
  const [copied, setCopied] = useState(false);

  const displayLabel = symbol && symbol.trim() ? symbol.trim() : (mint.length > 12 ? `${mint.slice(0, 6)}…${mint.slice(-6)}` : mint);
  const baseUrl = linkTo === 'dexscreener' ? DEXSCREENER_TOKEN_URL : SOLSCAN_TOKEN_URL;
  const path = mint ? `${baseUrl}/${mint}` : '';
  const href = path
    ? linkTo === 'dexscreener' && makerAddress?.trim()
      ? `${path}?maker=${encodeURIComponent(makerAddress.trim())}`
      : path
    : undefined;

  const copyToClipboard = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!mint) return;
    try {
      await navigator.clipboard.writeText(mint);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = mint;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const textContent = href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className="token-mint-link">
      {displayLabel}
    </a>
  ) : (
    <span className="token-mint-text">{displayLabel}</span>
  );

  return (
    <span className="token-mint-cell" title={mint || undefined}>
      {textContent}
      {mint && (
        <button
          type="button"
          className="token-mint-copy"
          onClick={copyToClipboard}
          title="Copy address"
          aria-label="Copy address"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      )}
    </span>
  );
}
