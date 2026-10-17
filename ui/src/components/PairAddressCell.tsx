import { useState } from 'react';
import './PairAddressCell.css';

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

interface PairAddressCellProps {
  address: string;
  href?: string;
  copyValue?: string;
  /** Tooltip on the cell; defaults to `address` (e.g. full pubkey when `address` is a symbol label). */
  titleAttr?: string;
}

export function PairAddressCell({ address, href, copyValue, titleAttr }: PairAddressCellProps) {
  const [copied, setCopied] = useState(false);

  const valueToCopy = copyValue ?? address;

  const isPairLabel = address.includes('/');
  const shortAddr =
    isPairLabel || address.length <= 12
      ? address
      : `${address.slice(0, 6)}…${address.slice(-6)}`;

  const copyToClipboard = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    try {
      await navigator.clipboard.writeText(valueToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fallback for older browsers
      const ta = document.createElement('textarea');
      ta.value = valueToCopy;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const textContent = href ? (
    <a href={href} target="_blank" rel="noopener noreferrer" className="pair-addr-link">
      {shortAddr}
    </a>
  ) : (
    <span className="pair-addr-text">{shortAddr}</span>
  );

  return (
    <span className="pair-addr-cell" title={titleAttr ?? address}>
      {textContent}
      <button
        type="button"
        className="pair-addr-copy"
        onClick={copyToClipboard}
        title="Copy address"
        aria-label="Copy address"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </span>
  );
}
