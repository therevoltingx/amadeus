import { existsSync } from 'node:fs';
import { createSyncFn, TsRunner, type SynckitOptions } from 'synckit';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { AmadeusDatabase, AmadeusStatement, RunResult } from './types.js';
import type { PgWorkerRequest } from './pg-worker.js';

class PostgresStatement implements AmadeusStatement {
  constructor(
    private readonly sync: (r: PgWorkerRequest) => unknown,
    private readonly sql: string
  ) {}

  run(...args: unknown[]): RunResult {
    return this.sync({ op: 'run', sql: this.sql, args }) as RunResult;
  }

  get(...args: unknown[]): unknown {
    return this.sync({ op: 'get', sql: this.sql, args });
  }

  all(...args: unknown[]): unknown[] {
    return this.sync({ op: 'all', sql: this.sql, args }) as unknown[];
  }
}

class PostgresAmadeusDatabase implements AmadeusDatabase {
  private readonly sync: (r: PgWorkerRequest) => unknown;

  constructor(connectionString: string, workerPath: string, ddlPath: string) {
    const synckitTimeoutMs = Number(process.env.AMADEUS_DB_SYNCKIT_TIMEOUT_MS ?? 120_000);
    const synckitOpts: SynckitOptions = {
      timeout: Number.isFinite(synckitTimeoutMs) && synckitTimeoutMs > 0 ? synckitTimeoutMs : 120_000,
    };
    // tsx dev loads pg-database.ts; the worker must run with a TS loader. Node's experimental
    // strip-types worker path often never completes startup → main thread blocks forever on Atomics.wait.
    if (workerPath.endsWith('.ts')) {
      synckitOpts.tsRunner = TsRunner.TSX;
    }
    this.sync = createSyncFn(workerPath, synckitOpts);
    this.sync({ op: 'init', connectionString, ddlPath });
  }

  prepare(sql: string): AmadeusStatement {
    return new PostgresStatement(this.sync, sql);
  }

  exec(sql: string): void {
    this.sync({ op: 'exec', sql });
  }

  pragma(_source: string, _options?: unknown): unknown {
    return undefined;
  }

  transaction<T>(fn: () => T): () => T {
    const sync = this.sync;
    return () => {
      sync({ op: 'txBegin' });
      try {
        const result = fn();
        sync({ op: 'txCommit' });
        return result;
      } catch (err) {
        sync({ op: 'txRollback' });
        throw err;
      }
    };
  }
}

function resolvePgWorkerPath(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const fromUrl = fileURLToPath(import.meta.url);
  if (fromUrl.endsWith('.js')) {
    return path.join(dir, 'pg-worker.js');
  }
  const distWorker = path.join(process.cwd(), 'dist/db/pg-worker.js');
  if (process.env.AMADEUS_PG_USE_DIST_WORKER === '1' && existsSync(distWorker)) {
    return distWorker;
  }
  return path.join(dir, 'pg-worker.ts');
}

function resolveBesideThisModule(filename: string): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(dir, filename);
}

export function createPostgresAmadeusDatabase(connectionString: string): AmadeusDatabase {
  const workerPath = resolvePgWorkerPath();
  const ddlPath = resolveBesideThisModule(path.join('schema', 'postgres-ddl.sql'));
  return new PostgresAmadeusDatabase(connectionString, workerPath, ddlPath);
}
