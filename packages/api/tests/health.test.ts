import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import type { HealthResponse } from '../src/routes/health.js';

// /health touches none of the database, cache or auth, so stubs are enough
// here; the real wiring is covered by the integration tests.
const STUBS: Omit<AppDeps, 'checks' | 'health'> = {
  db: {} as Db,
  flags: {} as AppDeps['flags'],
  cache: {} as AppDeps['cache'],
  fallback: false,
  auth: {
    jwtSecret: 'test-secret-that-is-at-least-32-characters-long',
    jwtExpiresInSeconds: 3600,
    sdkApiKey: 'test-sdk-api-key-1234',
  },
};

const ok = async () => {};
const failing = async () => {
  throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
};
const hanging = () => new Promise<void>(() => {});

describe('GET /health', () => {
  it('returns 200 with every check ok when all dependencies are reachable', async () => {
    const app = createApp({ ...STUBS, checks: { postgres: ok, redis: ok } });

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    const body = res.body as HealthResponse;
    expect(body.status).toBe('ok');
    expect(body.checks.postgres?.status).toBe('ok');
    expect(body.checks.redis?.status).toBe('ok');
  });

  it('returns 503 and names the failing dependency when one check rejects', async () => {
    const app = createApp({ ...STUBS, checks: { postgres: ok, redis: failing } });

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    const body = res.body as HealthResponse;
    expect(body.status).toBe('degraded');
    expect(body.checks.postgres?.status).toBe('ok');
    expect(body.checks.redis).toMatchObject({
      status: 'error',
      error: 'connect ECONNREFUSED 127.0.0.1:6379',
    });
  });

  it('returns 503 within the timeout instead of hanging when a check never settles', async () => {
    const app = createApp({
      ...STUBS,
      checks: { postgres: ok, redis: hanging },
      health: { timeoutMs: 100 },
    });

    const started = Date.now();
    const res = await request(app).get('/health');
    const elapsed = Date.now() - started;

    expect(res.status).toBe(503);
    expect(elapsed).toBeLessThan(2000);
    const body = res.body as HealthResponse;
    expect(body.checks.redis).toMatchObject({ status: 'error', error: 'timed out after 100ms' });
  });

  it('captures a synchronous throw inside a check as an error, not a crash', async () => {
    const app = createApp({
      ...STUBS,
      checks: {
        postgres: () => {
          throw new Error('boom');
        },
      },
    });

    const res = await request(app).get('/health');

    expect(res.status).toBe(503);
    expect((res.body as HealthResponse).checks.postgres).toMatchObject({
      status: 'error',
      error: 'boom',
    });
  });
});
