// Load packages/api/.env when run locally via `npm run db:migrate`; a no-op in
// Docker, where DATABASE_URL comes from docker-compose.yml.
import 'dotenv/config';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDb } from './client.js';
import { scriptConnectTimeoutMs, waitForDatabase } from './wait.js';

// Resolves to <package>/drizzle whether we run from src/ (tsx) or dist/ (node).
const MIGRATIONS_FOLDER = resolve(dirname(fileURLToPath(import.meta.url)), '../../drizzle');

/**
 * Applies all pending migrations from the `drizzle/` folder.
 * Safe to call repeatedly: Drizzle records applied migrations in
 * `__drizzle_migrations` and skips those already run.
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const { pool, db } = createDb(databaseUrl, { connectTimeoutMs: scriptConnectTimeoutMs() });
  try {
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await pool.end();
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate] DATABASE_URL is not set');
    process.exit(1);
  }
  // Wait first: on Render's free tier this runs in the container's start
  // command, so a cold Neon instance would otherwise fail the whole deploy.
  waitForDatabase(url, { label: 'migrate', connectTimeoutMs: scriptConnectTimeoutMs() })
    .then(() => runMigrations(url))
    .then(() => {
      console.log(`[migrate] migrations up to date (${MIGRATIONS_FOLDER})`);
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error('[migrate] failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
