/**
 * PostgreSQL access runs in a worker thread (async pg) while the main thread stays synchronous via synckit.
 *
 * Avoid static `import './x.js'` here: Node's worker + tsx often hangs resolving `.js` when only `.ts`
 * exists. Lazy-import `./x.ts` or `./x.js` based on import.meta.url (see getSqlMods).
 */
import { runAsWorker } from 'synckit';
import fs from 'node:fs';
import pg from 'pg';

/** Keep in sync with `constants.ts` / `pumpswap-rpc-parser.ts` (worker cannot import those via .js paths). */
const DEFAULT_PAPER_ACCOUNT_ID = 'paper-default';
const SOLANA_DEFAULT_ACCOUNT_ID = 'solana-wallet';

export type PgWorkerRequest =
  | { op: 'init'; connectionString: string; ddlPath: string }
  | { op: 'exec'; sql: string }
  | { op: 'run'; sql: string; args: unknown[] }
  | { op: 'get'; sql: string; args: unknown[] }
  | { op: 'all'; sql: string; args: unknown[] }
  | { op: 'txBegin' }
  | { op: 'txCommit' }
  | { op: 'txRollback' };

export type PgWorkerRunResult = { changes: number; lastInsertRowid?: number | bigint };

type SqlMods = {
  normalizeStatementArgs: (sql: string, args: unknown[]) => { sql: string; params: Record<string, unknown> };
  preparePostgresQuery: (sql: string) => string;
  sqlToPgPositional: (sql: string, params: Record<string, unknown>) => { text: string; values: unknown[] };
};

let sqlModsCache: SqlMods | null = null;

async function getSqlMods(): Promise<SqlMods> {
  if (sqlModsCache) return sqlModsCache;
  const ext = import.meta.url.endsWith('.ts') || import.meta.url.endsWith('.mts') ? 'ts' : 'js';
  const [sa, pr, np] = await Promise.all([
    import(`./statement-args.${ext}`) as Promise<typeof import('./statement-args.js')>,
    import(`./pg-rewrite.${ext}`) as Promise<typeof import('./pg-rewrite.js')>,
    import(`./named-params.${ext}`) as Promise<typeof import('./named-params.js')>,
  ]);
  sqlModsCache = {
    normalizeStatementArgs: sa.normalizeStatementArgs,
    preparePostgresQuery: pr.preparePostgresQuery,
    sqlToPgPositional: np.sqlToPgPositional,
  };
  return sqlModsCache;
}

/** If `sql[i]` starts `$tag$...$tag$` or `$$...$$`, return index just past the closing delimiter; else `i`. */
function skipDollarQuotedRegion(sql: string, i: number): number {
  if (sql[i] !== '$') return i;
  if (sql[i + 1] === '$') {
    const j = sql.indexOf('$$', i + 2);
    return j === -1 ? sql.length : j + 2;
  }
  const endTag = sql.indexOf('$', i + 1);
  if (endTag <= i + 1) return i;
  const tag = sql.slice(i + 1, endTag);
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(tag)) return i;
  const openClose = `$${tag}$`;
  const afterOpen = i + openClose.length;
  const closeIdx = sql.indexOf(openClose, afterOpen);
  if (closeIdx === -1) return sql.length;
  return closeIdx + openClose.length;
}

function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let depth = 0;
  let i = 0;
  while (i < sql.length) {
    if (sql[i] === '$') {
      const next = skipDollarQuotedRegion(sql, i);
      if (next > i) {
        cur += sql.slice(i, next);
        i = next;
        continue;
      }
    }
    const c = sql[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ';' && depth === 0) {
      const t = cur.trim();
      if (t) out.push(t);
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  const tail = cur.trim();
  if (tail) out.push(tail);
  return out;
}

let pool: pg.Pool | null = null;
let txClient: pg.PoolClient | null = null;
let inited = false;
/** 0 = none; 1 = outer BEGIN; >1 = nested SAVEPOINTs */
let txDepth = 0;
let savepointSeq = 0;
const savepointStack: string[] = [];

function q(): pg.Pool | pg.PoolClient {
  if (!pool) throw new Error('PostgreSQL pool not initialized');
  return txClient ?? pool;
}

function rowToPlain(row: pg.QueryResultRow): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(row)) {
    o[k] = row[k];
  }
  return o;
}

async function execSql(sql: string): Promise<void> {
  const c = q();
  for (const stmt of splitSqlStatements(sql)) {
    if (!stmt.trim()) continue;
    await c.query(stmt);
  }
}

async function runPrepared(method: 'run' | 'get' | 'all', sql: string, args: unknown[]): Promise<unknown> {
  const { normalizeStatementArgs, preparePostgresQuery, sqlToPgPositional } = await getSqlMods();
  const { sql: normSql, params } = normalizeStatementArgs(sql, args);
  const prepared = preparePostgresQuery(normSql);
  const { text, values } = sqlToPgPositional(prepared, params);
  const res = await q().query(text, values);

  if (method === 'run') {
    const changes = res.rowCount ?? 0;
    let lastInsertRowid: number | bigint | undefined;
    if (res.rows?.length > 0) {
      const row = res.rows[0];
      const keys = Object.keys(row);
      const v = row[keys[0]];
      if (typeof v === 'bigint') lastInsertRowid = v;
      else if (typeof v === 'number') lastInsertRowid = v;
      else if (v != null && (typeof v === 'string' || typeof v === 'object')) {
        const n = Number(v);
        if (!Number.isNaN(n)) lastInsertRowid = n;
      }
    }
    return { changes, lastInsertRowid } satisfies PgWorkerRunResult;
  }
  if (method === 'get') {
    if (!res.rows?.length) return undefined;
    return rowToPlain(res.rows[0]);
  }
  return (res.rows ?? []).map((r) => rowToPlain(r));
}

async function runSeed(p: pg.Pool): Promise<void> {
  const { preparePostgresQuery, sqlToPgPositional } = await getSqlMods();
  const now = Math.floor(Date.now() / 1000);
  const seedQueries: Array<{ sql: string; params: Record<string, unknown> }> = [
    {
      sql: `INSERT OR IGNORE INTO snapshot_cursors (name, last_swap_id) VALUES ($name, $lastSwapId)`,
      params: { name: 'pair_snapshots', lastSwapId: 0 },
    },
    {
      sql: `INSERT OR IGNORE INTO accounts (account_id, mode, chain, address, starting_equity, current_equity, available_balance, max_daily_drawdown_pct, max_total_open_trades, trading_enabled, created_at, updated_at)
   VALUES ($accountId, 'paper', 'paper', '', 100, 100, 100, 15, 20, 1, $now, $now)`,
      params: { accountId: DEFAULT_PAPER_ACCOUNT_ID, now },
    },
    {
      sql: `INSERT OR IGNORE INTO accounts (account_id, mode, chain, address, name, starting_equity, current_equity, available_balance, max_daily_drawdown_pct, max_total_open_trades, max_total_risk_pct, trading_enabled, is_active, created_at, updated_at)
   VALUES ($accountId, 'live', 'solana', NULL, $name, 0, 0, 0, 15, 20, 15, 1, 0, $now, $now)`,
      params: { accountId: SOLANA_DEFAULT_ACCOUNT_ID, name: SOLANA_DEFAULT_ACCOUNT_ID, now },
    },
  ];
  for (const { sql, params } of seedQueries) {
    const prepared = preparePostgresQuery(sql);
    const { text, values } = sqlToPgPositional(prepared, params);
    await p.query(text, values);
  }
}

runAsWorker(async (req: PgWorkerRequest): Promise<unknown> => {
  switch (req.op) {
    case 'init': {
      if (inited) return { ok: true };
      pool = new pg.Pool({
        connectionString: req.connectionString,
        max: 8,
        connectionTimeoutMillis: 15_000,
      });
      const ddl = fs.readFileSync(req.ddlPath, 'utf8');
      for (const stmt of splitSqlStatements(ddl)) {
        if (!stmt.trim()) continue;
        await pool.query(stmt);
      }
      await runSeed(pool);
      inited = true;
      return { ok: true };
    }
    case 'exec':
      await execSql(req.sql);
      return undefined;
    case 'run':
      return runPrepared('run', req.sql, req.args);
    case 'get':
      return runPrepared('get', req.sql, req.args);
    case 'all':
      return runPrepared('all', req.sql, req.args);
    case 'txBegin': {
      if (!pool) throw new Error('PostgreSQL pool not initialized');
      if (txDepth === 0) {
        txClient = await pool.connect();
        await txClient.query('BEGIN');
        txDepth = 1;
      } else {
        savepointSeq += 1;
        const name = `amadeus_sp_${savepointSeq}`;
        await txClient!.query(`SAVEPOINT ${name}`);
        savepointStack.push(name);
        txDepth++;
      }
      return undefined;
    }
    case 'txCommit': {
      if (!txClient || txDepth <= 0) throw new Error('txCommit without active transaction');
      if (txDepth === 1) {
        await txClient.query('COMMIT');
        txClient.release();
        txClient = null;
        txDepth = 0;
        savepointStack.length = 0;
      } else {
        const name = savepointStack.pop();
        if (!name) throw new Error('txCommit nested without savepoint name');
        txDepth--;
        await txClient.query(`RELEASE SAVEPOINT ${name}`);
      }
      return undefined;
    }
    case 'txRollback': {
      if (!txClient || txDepth <= 0) throw new Error('txRollback without active transaction');
      if (txDepth === 1) {
        await txClient.query('ROLLBACK');
        txClient.release();
        txClient = null;
        txDepth = 0;
        savepointStack.length = 0;
      } else {
        const name = savepointStack.pop();
        if (!name) throw new Error('txRollback nested without savepoint name');
        txDepth--;
        await txClient.query(`ROLLBACK TO SAVEPOINT ${name}`);
      }
      return undefined;
    }
    default: {
      const _x: never = req;
      throw new Error(`Unknown op: ${JSON.stringify(_x)}`);
    }
  }
});
