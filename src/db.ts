/**
 * Database entry: PostgreSQL only (`DATABASE_URL`). Expect an empty database: on first connect the
 * worker runs `src/db/schema/postgres-ddl.sql` once (full CREATEs only, no versioned migrations).
 * After that, default rows are seeded (snapshot cursor, accounts). Use named parameters (`$name`)
 * in SQL; pass a single params object to `.run()` / `.get()` / `.all()`.
 */
import './db/load-env.js';
import type { AmadeusDatabase } from './db/types.js';
import { createPostgresAmadeusDatabase } from './db/pg-database.js';
import { DEFAULT_PAPER_ACCOUNT_ID, SOLANA_DEFAULT_ACCOUNT_ID } from './db/constants.js';
import { getSolanaPublicKeyString } from './solana-signer.js';

export { DEFAULT_PAPER_ACCOUNT_ID, SOLANA_DEFAULT_ACCOUNT_ID };

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'DATABASE_URL is required (postgresql://…). SQLite is no longer supported in the main app.'
    );
  }
  const lower = url.toLowerCase();
  if (!lower.startsWith('postgres://') && !lower.startsWith('postgresql://')) {
    throw new Error('DATABASE_URL must be a postgres:// or postgresql:// connection string.');
  }
  return url;
}

function createDatabase(): AmadeusDatabase {
  return createPostgresAmadeusDatabase(requireDatabaseUrl());
}

export const db = createDatabase();

const now = Math.floor(Date.now() / 1000);
const solanaAddress = getSolanaPublicKeyString();
if (solanaAddress) {
  db.prepare(
    `UPDATE accounts SET address = $address, updated_at = $now WHERE account_id = $accountId AND (address IS NULL OR address = '')`
  ).run({ address: solanaAddress, now, accountId: SOLANA_DEFAULT_ACCOUNT_ID });
}
