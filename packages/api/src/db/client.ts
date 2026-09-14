import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>['db'];

/**
 * Creates a pg Pool and a Drizzle instance bound to it.
 *
 * `connectionTimeoutMillis` is deliberately short: when Postgres is unreachable
 * we want callers (notably /health) to get a rejection quickly, not a hang.
 */
export function createDb(databaseUrl: string) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 1500,
    max: 10,
  });

  // Idle-client errors (e.g. Postgres restarted) are emitted on the pool; an
  // unhandled 'error' event would crash the process (NFR-04).
  pool.on('error', (err) => {
    console.error('[db] pool error:', err.message);
  });

  const db = drizzle(pool, { schema });
  return { pool, db };
}
