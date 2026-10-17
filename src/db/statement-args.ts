/**
 * Normalize `prepare(sql).run/get/all` args: a single object with keys matching $name placeholders.
 */

function isPlainParamObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Buffer);
}

export function normalizeStatementArgs(sql: string, args: unknown[]): { sql: string; params: Record<string, unknown> } {
  if (/\?/.test(sql)) {
    throw new Error(
      'SQL must use named placeholders ($paramName), not ?. Pass a single object to .run({ ... }) / .get({ ... }) / .all({ ... }).'
    );
  }
  if (args.length === 0) {
    return { sql, params: {} };
  }
  if (args.length === 1 && isPlainParamObject(args[0])) {
    return { sql, params: args[0] as Record<string, unknown> };
  }
  throw new Error(
    'SQL uses named parameters ($name); pass a single object, e.g. .run({ accountId: "paper-default" })'
  );
}
