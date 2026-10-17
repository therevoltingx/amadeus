/**
 * Regression: rolling windows on `pair_swap_events` must treat `created_at` as ms (or normalize
 * legacy seconds). Naive `created_at >= $sinceMs` is always false when `created_at` is Unix seconds
 * while `$sinceMs` is from `Date.now()` — 1m/5m/15m all flat, totals still grow.
 *
 * Requires DATABASE_URL (PostgreSQL). Skipped when unset.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';
import { swapEventCreatedAtMsExpr } from '../src/workers/swap-event-time-sql.js';

const PAIR = 'TestPair1111111111111111111111111111111111';
const NOW_MS = 1_740_000_000_000;
const ONE_MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 300_000;

const databaseUrl = process.env.DATABASE_URL?.trim();
const pgEnabled =
  databaseUrl != null &&
  (databaseUrl.toLowerCase().startsWith('postgres://') ||
    databaseUrl.toLowerCase().startsWith('postgresql://'));

describe('pair_swap_events rolling windows (created_at normalization)', { skip: !pgEnabled }, () => {
  const SWAP_EXPR = swapEventCreatedAtMsExpr();
  let client: pg.Client;

  before(async () => {
    client = new pg.Client({ connectionString: databaseUrl });
    await client.connect();
    await client.query(`DROP TABLE IF EXISTS _swap_events_test`);
    await client.query(`
      CREATE TABLE _swap_events_test (
        id SERIAL PRIMARY KEY,
        pair_address TEXT NOT NULL,
        slot BIGINT NOT NULL,
        direction TEXT NOT NULL,
        base_delta TEXT NOT NULL,
        quote_delta TEXT NOT NULL,
        created_at BIGINT NOT NULL
      )
    `);
  });

  after(async () => {
    await client.query(`DROP TABLE IF EXISTS _swap_events_test`);
    await client.end();
  });

  it('replicates the bug: seconds in created_at + naive ms window => zero rolling, non-zero total', async () => {
    const sinceMs = NOW_MS - ONE_MINUTE_MS;
    const createdAtSeconds = Math.floor((NOW_MS - 45_000) / 1000);
    const lamports = 5_000_000;

    await client.query(
      `INSERT INTO _swap_events_test (pair_address, slot, direction, base_delta, quote_delta, created_at)
       VALUES ($1, 1, 'buy', '0', $2, $3)`,
      [PAIR, String(lamports), createdAtSeconds]
    );

    const total = await client.query(
      `SELECT COALESCE(SUM(ABS(quote_delta::bigint)), 0)::text AS lamports
       FROM _swap_events_test WHERE pair_address = $1`,
      [PAIR]
    );
    const naive = await client.query(
      `SELECT COALESCE(SUM(ABS(quote_delta::bigint)), 0)::text AS lamports
       FROM _swap_events_test
       WHERE pair_address = $1 AND created_at >= $2`,
      [PAIR, sinceMs]
    );
    const fixed = await client.query(
      `SELECT COALESCE(SUM(ABS(quote_delta::bigint)), 0)::text AS lamports
       FROM _swap_events_test
       WHERE pair_address = $1 AND ${SWAP_EXPR} >= $2`,
      [PAIR, sinceMs]
    );

    assert.equal(total.rows[0].lamports, String(lamports), 'total should include the row');
    assert.equal(naive.rows[0].lamports, '0', 'naive created_at >= sinceMs must miss second-based rows (bug)');
    assert.equal(fixed.rows[0].lamports, String(lamports), 'normalized time must include the row in the 1m window');

    await client.query(`DELETE FROM _swap_events_test WHERE pair_address = $1`, [PAIR]);
  });

  it('fix: 5m and 15m windows also see second-based timestamps', async () => {
    const since5m = NOW_MS - FIVE_MINUTES_MS;
    const createdAtSeconds = Math.floor((NOW_MS - 120_000) / 1000);
    const lamports = 9_000_000;

    await client.query(
      `INSERT INTO _swap_events_test (pair_address, slot, direction, base_delta, quote_delta, created_at)
       VALUES ($1, 1, 'sell', '0', $2, $3)`,
      [PAIR, String(-lamports), createdAtSeconds]
    );

    const naive = await client.query(
      `SELECT COALESCE(SUM(ABS(quote_delta::bigint)), 0)::text AS lamports
       FROM _swap_events_test WHERE pair_address = $1 AND created_at >= $2`,
      [PAIR, since5m]
    );
    const fixed = await client.query(
      `SELECT COALESCE(SUM(ABS(quote_delta::bigint)), 0)::text AS lamports
       FROM _swap_events_test WHERE pair_address = $1 AND ${SWAP_EXPR} >= $2`,
      [PAIR, since5m]
    );

    assert.equal(naive.rows[0].lamports, '0');
    assert.equal(fixed.rows[0].lamports, String(lamports));

    await client.query(`DELETE FROM _swap_events_test WHERE pair_address = $1`, [PAIR]);
  });

  it('ms-stored created_at still matches naive and normalized queries', async () => {
    const sinceMs = NOW_MS - ONE_MINUTE_MS;
    const createdAtMs = NOW_MS - 20_000;
    const lamports = 1_000_000;

    await client.query(
      `INSERT INTO _swap_events_test (pair_address, slot, direction, base_delta, quote_delta, created_at)
       VALUES ($1, 1, 'buy', '0', $2, $3)`,
      [PAIR, String(lamports), createdAtMs]
    );

    const naive = await client.query(
      `SELECT COALESCE(SUM(ABS(quote_delta::bigint)), 0)::text AS lamports
       FROM _swap_events_test WHERE pair_address = $1 AND created_at >= $2`,
      [PAIR, sinceMs]
    );
    const fixed = await client.query(
      `SELECT COALESCE(SUM(ABS(quote_delta::bigint)), 0)::text AS lamports
       FROM _swap_events_test WHERE pair_address = $1 AND ${SWAP_EXPR} >= $2`,
      [PAIR, sinceMs]
    );

    assert.equal(naive.rows[0].lamports, String(lamports));
    assert.equal(fixed.rows[0].lamports, String(lamports));

    await client.query(`DELETE FROM _swap_events_test WHERE pair_address = $1`, [PAIR]);
  });
});
