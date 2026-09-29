import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { createDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { seedAdmin } from '../../src/db/seed.js';
import type { AuthConfig } from '../../src/middleware/auth.js';
import { createFlagCache, type FlagCache } from '../../src/services/cache/flag-cache.js';
import { createRedis, pingRedis } from '../../src/services/cache/redis.js';
import { createFlagService, type FlagService } from '../../src/services/flags/flag-service.js';

export const ADMIN_EMAIL = 'admin@example.com';
export const ADMIN_PASSWORD = 'integration-test-password';

export const AUTH: AuthConfig = {
  jwtSecret: 'integration-secret-at-least-32-characters-long',
  jwtExpiresInSeconds: 3600,
  sdkApiKey: 'integration-sdk-api-key',
  integrationApiKey: 'integration-alert-key-abc',
};

/** A port nothing listens on, so Redis calls fail immediately. */
export const DEAD_REDIS_URL = 'redis://127.0.0.1:1';

export interface TestAppOptions {
  /** Start a real Redis container. Without one the cache runs Postgres-only. */
  withRedis?: boolean;
  /** Cache TTL; lower it to exercise the expiry safety net. */
  ttlSeconds?: number;
  /** What evaluation returns when nothing is reachable. Default fail-closed. */
  fallback?: boolean;
}

export interface TestApp {
  app: Express;
  db: Db;
  flags: FlagService;
  cache: FlagCache;
  /** A valid admin bearer token, obtained through the real login endpoint. */
  token: string;
  adminId: string;
  connectionUri: string;
  postgres: StartedPostgreSqlContainer;
  redis?: StartedRedisContainer;
  redisUrl: string;
  close: () => Promise<void>;
}

/**
 * Starts a throwaway Postgres (and optionally Redis), migrates, seeds the admin
 * and builds the app — the same code paths production uses.
 *
 * With `withRedis` omitted the cache is pointed at a dead port, so every suite
 * that doesn't care about caching additionally proves the Redis-down path works.
 */
export async function startTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const { withRedis = false, ttlSeconds = 30, fallback = false } = options;

  const postgres = await new PostgreSqlContainer('postgres:16-alpine').start();
  const connectionUri = postgres.getConnectionUri();

  const redisContainer = withRedis ? await new RedisContainer('redis:7-alpine').start() : undefined;
  const redisUrl = redisContainer?.getConnectionUrl() ?? DEAD_REDIS_URL;

  await runMigrations(connectionUri);
  const { id: adminId } = await seedAdmin(connectionUri, ADMIN_EMAIL, ADMIN_PASSWORD);

  const { pool, db } = createDb(connectionUri);
  const redis = createRedis(redisUrl);
  const subscriber = createRedis(redisUrl);

  const cache = createFlagCache({ redis, subscriber, db, ttlSeconds });
  await cache.start();
  const flags = createFlagService(db, cache);

  const app = createApp({
    db,
    flags,
    cache,
    fallback,
    auth: AUTH,
    checks: {
      postgres: async () => {
        await pool.query('SELECT 1');
      },
      redis: () => pingRedis(redis),
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
    flags,
    cache,
    token: login.body.token as string,
    adminId,
    connectionUri,
    postgres,
    redis: redisContainer,
    redisUrl,
    close: async () => {
      await cache.close();
      redis.disconnect();
      subscriber.disconnect();
      await pool.end();
      await Promise.all([postgres.stop(), redisContainer?.stop()].filter(Boolean));
    },
  };
}
