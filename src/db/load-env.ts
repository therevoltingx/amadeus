/**
 * Runs before the rest of `db.ts` dependencies so DATABASE_URL from `.env` is visible
 * when the database backend is chosen (entry points do not all import dotenv first).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const envInCwd = path.join(process.cwd(), '.env');
const envInRepoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
if (existsSync(envInCwd)) {
  loadEnv({ path: envInCwd });
} else if (existsSync(envInRepoRoot)) {
  loadEnv({ path: envInRepoRoot });
} else {
  loadEnv();
}
