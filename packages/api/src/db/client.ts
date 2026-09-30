import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = ReturnType<typeof createDb>['db'];

export interface DbOptions {
  /**
   * How long to wait for a connection before rejecting.
   *
   * Short by default: when Postgres is unreachable, callers (notably /health)
   * should get a rejection quickly rather than a hang. Raise it for a managed
   * database that scales to zero — waking Neon takes seconds, and treating that
   * as an outage is worse than waiting for it. See `DB_CONNECT_TIMEOUT_MS`.
   */
  connectTimeoutMs?: number;
}

/** Creates a pg Pool and a Drizzle instance bound to it. */
export function createDb(databaseUrl: string, { connectTimeoutMs = 1500 }: DbOptions = {}) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: connectTimeoutMs,
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
