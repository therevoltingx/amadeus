/**
 * Shared database surface (PostgreSQL via worker + synckit).
 */

export interface RunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

export interface AmadeusStatement {
  run(...args: unknown[]): RunResult;
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}

export interface AmadeusDatabase {
  prepare(sql: string): AmadeusStatement;
  /** Run DDL / multi-statement SQL (split and executed in the PostgreSQL worker). */
  exec(sql: string): void;
  /** No-op on PostgreSQL (reserved for API compatibility). */
  pragma(source: string, options?: unknown): unknown;
  /** Transaction wrapper; PostgreSQL uses BEGIN/COMMIT in the worker. */
  transaction<T>(fn: () => T): () => T;
}
