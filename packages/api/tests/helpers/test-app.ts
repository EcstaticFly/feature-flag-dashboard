import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedAdmin } from '../../src/db/seed.js';
import type { AuthConfig } from '../../src/middleware/auth.js';

export const ADMIN_EMAIL = 'admin@example.com';
export const ADMIN_PASSWORD = 'integration-test-password';

export const AUTH: AuthConfig = {
  jwtSecret: 'integration-secret-at-least-32-characters-long',
  jwtExpiresInSeconds: 3600,
  sdkApiKey: 'integration-sdk-api-key',
};

export interface TestApp {
  app: Express;
  db: Db;
  /** A valid admin bearer token, obtained through the real login endpoint. */
  token: string;
  adminId: string;
  connectionUri: string;
  close: () => Promise<void>;
}

/**
 * Starts a throwaway Postgres, migrates it, seeds the admin, and builds the app
 * — the same code paths production uses, so the test exercises real wiring.
 * Redis isn't needed until Milestone 3, so /health's redis check is stubbed.
 */
export async function startTestApp(): Promise<TestApp> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    'postgres:16-alpine',
  ).start();
  const connectionUri = container.getConnectionUri();

  await runMigrations(connectionUri);
  const { id: adminId } = await seedAdmin(connectionUri, ADMIN_EMAIL, ADMIN_PASSWORD);

  const { pool, db } = createDb(connectionUri);
  const app = createApp({
    db,
    auth: AUTH,
    checks: {
      postgres: async () => {
        await pool.query('SELECT 1');
      },
    },
  });

  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (login.status !== 200) {
    throw new Error(`test setup: login failed with ${login.status}`);
  }

  return {
    app,
    db,
    token: login.body.token as string,
    adminId,
    connectionUri,
    close: async () => {
      await pool.end();
      await container.stop();
    },
  };
}
