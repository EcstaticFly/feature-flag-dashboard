import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createDb } from '../src/db/client.js';
import type { HealthResponse } from '../src/routes/health.js';
import { createRedis, pingRedis } from '../src/services/cache/redis.js';

let postgres: StartedPostgreSqlContainer;
let redis: StartedRedisContainer;

function buildApp(databaseUrl: string, redisUrl: string) {
  const { pool } = createDb(databaseUrl);
  const redisClient = createRedis(redisUrl);
  const app = createApp({
    checks: {
      postgres: async () => {
        await pool.query('SELECT 1');
      },
      redis: () => pingRedis(redisClient),
    },
  });
  const close = async () => {
    await pool.end();
    redisClient.disconnect();
  };
  return { app, close };
}

describe('GET /health against real dependencies', () => {
  beforeAll(async () => {
    [postgres, redis] = await Promise.all([
      new PostgreSqlContainer('postgres:16-alpine').start(),
      new RedisContainer('redis:7-alpine').start(),
    ]);
  });

  afterAll(async () => {
    await Promise.all([postgres?.stop(), redis?.stop()]);
  });

  it('returns 200 when Postgres and Redis are both reachable', async () => {
    const { app, close } = buildApp(postgres.getConnectionUri(), redis.getConnectionUrl());
    try {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect((res.body as HealthResponse).checks).toMatchObject({
        postgres: { status: 'ok' },
        redis: { status: 'ok' },
      });
    } finally {
      await close();
    }
  });

  it('returns 503 (not a hang) when Redis is unreachable but Postgres is fine', async () => {
    // Port 1 is reserved and never listening → immediate ECONNREFUSED.
    const { app, close } = buildApp(postgres.getConnectionUri(), 'redis://127.0.0.1:1');
    try {
      const started = Date.now();
      const res = await request(app).get('/health');
      expect(Date.now() - started).toBeLessThan(5000);

      expect(res.status).toBe(503);
      const body = res.body as HealthResponse;
      expect(body.status).toBe('degraded');
      expect(body.checks.postgres?.status).toBe('ok');
      expect(body.checks.redis?.status).toBe('error');
    } finally {
      await close();
    }
  });

  it('returns 503 (not a hang) when Postgres is unreachable but Redis is fine', async () => {
    const { app, close } = buildApp(
      'postgres://nobody:nothing@127.0.0.1:1/nowhere',
      redis.getConnectionUrl(),
    );
    try {
      const started = Date.now();
      const res = await request(app).get('/health');
      expect(Date.now() - started).toBeLessThan(5000);

      expect(res.status).toBe(503);
      const body = res.body as HealthResponse;
      expect(body.checks.postgres?.status).toBe('error');
      expect(body.checks.redis?.status).toBe('ok');
    } finally {
      await close();
    }
  });
});
