// Loads packages/api/.env when run locally via `npm run db:seed`; a no-op in
// Docker, where the variables come from the environment.
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { hashPassword } from '../auth/password.js';
import { createDb } from './client.js';
import { users } from './schema.js';
import { scriptConnectTimeoutMs, waitForDatabase } from './wait.js';

/**
 * Creates (or updates) the single admin account. There is no signup flow —
 * v1 has exactly one admin, seeded here.
 *
 * Re-running is safe and rotates the password, so a forgotten password is
 * recoverable without touching SQL.
 */
export async function seedAdmin(
  databaseUrl: string,
  email: string,
  password: string,
): Promise<{ id: string; email: string; created: boolean }> {
  const normalizedEmail = email.trim().toLowerCase();
  const passwordHash = await hashPassword(password);
  const { pool, db } = createDb(databaseUrl, { connectTimeoutMs: scriptConnectTimeoutMs() });

  try {
    const existing = await db.select({ id: users.id }).from(users);
    const [row] = await db
      .insert(users)
      .values({ email: normalizedEmail, passwordHash, role: 'admin' })
      .onConflictDoUpdate({ target: users.email, set: { passwordHash } })
      .returning({ id: users.id, email: users.email });

    const created = !existing.some((u) => u.id === row!.id);
    return { id: row!.id, email: row!.email, created };
  } finally {
    await pool.end();
  }
}

/** The admin password committed to `.env.example` and `docker-compose.yml`. */
const DEV_ADMIN_PASSWORD = 'change-me-please';

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  const { DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
  const missing = Object.entries({ DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD })
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    console.error(`[seed] missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
  if (ADMIN_PASSWORD!.length < 12) {
    console.error('[seed] ADMIN_PASSWORD must be at least 12 characters');
    process.exit(1);
  }
  /*
   * The placeholder password is committed to this repo, so seeding a real
   * deployment with it would publish the admin account. It passes the length
   * check above, which is exactly why it needs naming explicitly.
   *
   * Same opt-in as the API's credential guard: docker-compose sets it because
   * that stack is throwaway by design.
   */
  if (ADMIN_PASSWORD === DEV_ADMIN_PASSWORD && process.env.ALLOW_DEV_CREDENTIALS !== 'true') {
    console.error(
      "[seed] refusing to seed: ADMIN_PASSWORD is this repository's public placeholder.\n" +
        '[seed] set a real password, or ALLOW_DEV_CREDENTIALS=true for a local stack.',
    );
    process.exit(1);
  }

  // Same reasoning as migrate: this runs at container start on a free tier.
  waitForDatabase(DATABASE_URL!, { label: 'seed', connectTimeoutMs: scriptConnectTimeoutMs() })
    .then(() => seedAdmin(DATABASE_URL!, ADMIN_EMAIL!, ADMIN_PASSWORD!))
    .then(({ email, created }) => {
      console.log(`[seed] admin ${created ? 'created' : 'password updated'}: ${email}`);
      process.exit(0);
    })
    .catch((err: unknown) => {
      console.error('[seed] failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
