import { evaluateFlag, type FlagConfig } from '@feature-flags/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH, startTestApp, type TestApp } from './helpers/test-app.js';

/**
 * Chaos: kill the infrastructure underneath a running API and assert it
 * degrades predictably rather than catastrophically (NFR-04).
 *
 * The containers are stopped for real, in order, and never restarted — the
 * tests run in sequence and each one depends on the previous one's damage.
 */

let ctx: TestApp;

const auth = () => ({ Authorization: `Bearer ${ctx.token}` });
const sdkKey = () => ({ 'x-api-key': AUTH.sdkApiKey });

const KEY = 'chaos-flag';
const CONFIG: FlagConfig = {
  key: KEY,
  enabled: true,
  rolloutPercentage: 40,
  targetingRules: [],
};

beforeAll(async () => {
  // fallback:false is the default fail-closed policy.
  ctx = await startTestApp({ withRedis: true, fallback: false });
  await request(ctx.app)
    .post('/api/flags')
    .set(auth())
    .send({ key: KEY, name: 'Chaos', enabled: true, rolloutPercentage: 40 })
    .expect(201);

  // Warm both tiers.
  await request(ctx.app).get('/api/sdk/flags').set(sdkKey()).expect(200);
  await request(ctx.app).get(`/api/flags/${KEY}/evaluate?userId=user_1`).set(sdkKey()).expect(200);
});

afterAll(async () => {
  await ctx?.close();
});

describe('Redis stopped mid-run', () => {
  it('keeps evaluating correctly, from Postgres', async () => {
    await ctx.redis!.stop();

    for (const userId of ['user_1', 'user_2', 'user_3', 'brand-new-user']) {
      const res = await request(ctx.app)
        .get(`/api/flags/${KEY}/evaluate?userId=${userId}`)
        .set(sdkKey());

      expect(res.status).toBe(200);
      // Not merely "did not crash" — still the right answer.
      expect(res.body.enabled).toBe(evaluateFlag(CONFIG, { userId }));
    }
  });

  it('still serves the SDK its flag list', async () => {
    const res = await request(ctx.app).get('/api/sdk/flags').set(sdkKey());
    expect(res.status).toBe(200);
    expect(res.body.flags).toContainEqual(expect.objectContaining({ key: KEY }));
  });

  it('still accepts mutations, even though invalidation cannot be published', async () => {
    await request(ctx.app)
      .patch(`/api/flags/${KEY}`)
      .set(auth())
      .send({ rolloutPercentage: 100 })
      .expect(200);

    const res = await request(ctx.app)
      .get(`/api/flags/${KEY}/evaluate?userId=user_1`)
      .set(sdkKey());
    expect(res.body.enabled).toBe(true);
  });

  it('reports the outage on /health rather than hiding it', async () => {
    const res = await request(ctx.app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.checks.redis.status).toBe('error');
    expect(res.body.checks.postgres.status).toBe('ok');
  });
});

describe('Postgres stopped as well', () => {
  it('still answers correctly for a cached flag, even for an unseen user', async () => {
    await ctx.postgres.stop();

    // The cache is keyed by FLAG, not by user, so a brand-new user is still
    // answered from the cached config. This is the property that keeps a host
    // app working for its entire user base through an outage.
    const res = await request(ctx.app)
      .get(`/api/flags/${KEY}/evaluate?userId=never-seen-before`)
      .set(sdkKey());

    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(
      evaluateFlag({ ...CONFIG, rolloutPercentage: 100 }, { userId: 'never-seen-before' }),
    );
  });

  it('falls back to the configured default for a flag no tier can resolve', async () => {
    // A key this instance has never cached: Redis is gone, Postgres is gone,
    // so nothing can say whether it exists. The fail-closed policy decides.
    // 200, not 500 — the evaluation path never throws (NFR-04).
    const res = await request(ctx.app)
      .get('/api/flags/never-cached-flag/evaluate?userId=user_1')
      .set(sdkKey());

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, reason: 'unavailable' });
  });

  it('tells the SDK to keep its own snapshot rather than reporting zero flags', async () => {
    const res = await request(ctx.app).get('/api/sdk/flags').set(sdkKey());

    // Either the stale in-process snapshot (200) or an honest 503 — but never
    // `{"flags":[]}`, which would read as "every flag was deleted" and switch
    // off every feature at once.
    expect([200, 503]).toContain(res.status);
    if (res.status === 200) expect(res.body.flags.length).toBeGreaterThan(0);
    else expect(res.body.error.code).toBe('flags_unavailable');
  });

  it('is still alive and still answering /health', async () => {
    const res = await request(ctx.app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.checks.postgres.status).toBe('error');
    expect(res.body.checks.redis.status).toBe('error');
  });
});
