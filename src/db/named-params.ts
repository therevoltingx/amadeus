/**
 * Convert `$named` placeholders to PostgreSQL `$1`..`$n` (first occurrence order).
 */

const NAME_RE = /\$([a-zA-Z_][a-zA-Z0-9_]*)\b/g;

export function sqlToPgPositional(sql: string, params: Record<string, unknown>): { text: string; values: unknown[] } {
  const order: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(NAME_RE.source, 'g');
  while ((m = re.exec(sql)) !== null) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      order.push(name);
    }
  }
  const values = order.map((name) => {
    if (!(name in params)) {
      throw new Error(`Missing named parameter $${name} for PostgreSQL query`);
    }
    return params[name];
  });
  const nameToIndex = new Map<string, number>();
  order.forEach((name, idx) => nameToIndex.set(name, idx + 1));
  const text = sql.replace(new RegExp(NAME_RE.source, 'g'), (_match, name: string) => {
    const idx = nameToIndex.get(name);
    if (idx == null) throw new Error(`Unknown bind name $${name}`);
    return `$${idx}`;
  });
  return { text, values };
}
