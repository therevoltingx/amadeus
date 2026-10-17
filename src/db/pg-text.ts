/**
 * PostgreSQL TEXT / VARCHAR reject code point U+0000.
 * Strip NULs from strings bound for the DB (on-chain metadata can contain 0x00).
 */
export function stripPgNul(s: string): string {
  return s.includes('\0') ? s.replace(/\0/g, '') : s;
}

export function stripPgNulNullable(s: string | null | undefined): string | null {
  if (s == null) return null;
  return stripPgNul(s);
}
