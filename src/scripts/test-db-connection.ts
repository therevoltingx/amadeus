/**
 * Verify DATABASE_URL and run a simple ping against PostgreSQL.
 */
import 'dotenv/config';
import { db } from '../db.js';

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url.replace(/:[^:@]+@/, ':***@');
  }
}

function main(): void {
  const raw = process.env.DATABASE_URL?.trim();
  if (!raw) {
    console.error('DATABASE_URL is not set. PostgreSQL is required.');
    process.exit(1);
  }
  console.log('DATABASE_URL (masked):', maskUrl(raw));

  try {
    const versionRow = db.prepare(`SELECT version() AS v`).get() as { v: string };
    console.log('Server:', versionRow.v.split('\n')[0]);

    const ping = db.prepare(`SELECT 1 AS ok`).get() as { ok: number };
    console.log('Ping SELECT 1:', ping.ok === 1 ? 'ok' : ping);

    const countRow = db
      .prepare(`SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`)
      .get() as { n: number };
    console.log('Table count:', countRow.n);

    console.log('\nConnection test passed.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('Connection test failed:', msg);
    process.exit(1);
  }
}

main();
