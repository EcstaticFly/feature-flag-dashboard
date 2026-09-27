import { computeBucket, evaluateFlag, type FlagConfig } from '@feature-flags/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH, startTestApp, type TestApp } from './helpers/test-app.js';

let ctx: TestApp;

const auth = () => ({ Authorization: `Bearer ${ctx.token}` });
const sdkKey = () => ({ 'x-api-key': AUTH.sdkApiKey });

const KEY = 'checkout-v2';
const CONFIG: FlagConfig = {
  key: KEY,
  enabled: true,
  rolloutPercentage: 30,
  targetingRules: [
    { attribute: 'plan', operator: 'eq', values: ['pro'] },
    { attribute: 'userId', operator: 'in', values: ['always-in'] },
  ],
};

const evaluate = (query: string) =>
  request(ctx.app).get(`/api/flags/${KEY}/evaluate${query}`).set(sdkKey());

beforeAll(async () => {
  ctx = await startTestApp({ withRedis: true });
  await request(ctx.app)
    .post('/api/flags')
    .set(auth())
    .send({
      key: KEY,
      name: 'Checkout v2',
      enabled: true,
      rolloutPercentage: CONFIG.rolloutPercentage,
      targetingRules: CONFIG.targetingRules,
    })
    .expect(201);
});

afterAll(async () => {
  await ctx?.close();
});

describe('authorization', () => {
  it('requires a credential', async () => {
    expect((await request(ctx.app).get(`/api/flags/${KEY}/evaluate?userId=u`)).status).toBe(401);
  });

  it('accepts the SDK key', async () => {
    expect((await evaluate('?userId=u')).status).toBe(200);
  });

  it('accepts an admin token too', async () => {
    const res = await request(ctx.app).get(`/api/flags/${KEY}/evaluate?userId=u`).set(auth());
    expect(res.status).toBe(200);
  });

  it('does not let the SDK key reach the CRUD routes it sits beside', async () => {
    expect((await request(ctx.app).get(`/api/flags/${KEY}`).set(sdkKey())).status).toBe(401);
  });
});

describe('evaluation', () => {
  // The whole point of packages/core: the server and the SDK must agree.
  it.each(['user_1', 'user_2', 'user_7', 'user_42', 'always-in'])(
    'agrees with the core evaluator for %s',
    async (userId) => {
      const res = await evaluate(`?userId=${userId}`);
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(evaluateFlag(CONFIG, { userId }));
    },
  );

  it('reports the bucket and the reason', async () => {
    const res = await evaluate('?userId=user_1');
    expect(res.body).toMatchObject({
      key: KEY,
      userId: 'user_1',
      bucket: computeBucket('user_1', KEY),
    });
    expect(['rollout_in', 'rollout_out']).toContain(res.body.reason);
  });

  it('is deterministic across repeated calls', async () => {
    const first = (await evaluate('?userId=user_9')).body;
    for (let i = 0; i < 5; i += 1) {
      expect((await evaluate('?userId=user_9')).body).toEqual(first);
    }
  });

  it('applies an allowlist rule regardless of bucket', async () => {
    const res = await evaluate('?userId=always-in');
    expect(res.body).toMatchObject({ enabled: true, reason: 'rule_match', ruleIndex: 1 });
  });

  it('reads attr.* parameters into the targeting context', async () => {
    const res = await evaluate('?userId=user_2&attr.plan=pro');
    expect(res.body).toMatchObject({ enabled: true, reason: 'rule_match', ruleIndex: 0 });
  });

  it('matches attributes case- and whitespace-insensitively', async () => {
    const res = await evaluate('?userId=user_2&attr.plan=%20PRO%20');
    expect(res.body.enabled).toBe(true);
  });

  it('treats a request with no userId as anonymous', async () => {
    const res = await evaluate('');
    expect(res.body).toMatchObject({ enabled: true, reason: 'anonymous' });
  });

  it('honours the kill switch', async () => {
    await request(ctx.app).patch(`/api/flags/${KEY}`).set(auth()).send({ enabled: false }).expect(200);
    try {
      const res = await evaluate('?userId=always-in');
      expect(res.body).toMatchObject({ enabled: false, reason: 'kill_switch' });
    } finally {
      await request(ctx.app).patch(`/api/flags/${KEY}`).set(auth()).send({ enabled: true });
    }
  });

  it('reflects a rollout change immediately', async () => {
    await request(ctx.app)
      .patch(`/api/flags/${KEY}`)
      .set(auth())
      .send({ rolloutPercentage: 100 })
      .expect(200);
    try {
      expect((await evaluate('?userId=user_1')).body.enabled).toBe(true);
    } finally {
      await request(ctx.app)
        .patch(`/api/flags/${KEY}`)
        .set(auth())
        .send({ rolloutPercentage: CONFIG.rolloutPercentage });
    }
  });
});

describe('errors', () => {
  it('returns 404 for a flag that does not exist', async () => {
    const res = await request(ctx.app)
      .get('/api/flags/no-such-flag/evaluate?userId=u')
      .set(sdkKey());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('flag_not_found');
  });

  it('returns 404 once a flag is soft-deleted', async () => {
    await request(ctx.app)
      .post('/api/flags')
      .set(auth())
      .send({ key: 'short-lived', name: 'x', enabled: true, rolloutPercentage: 100 })
      .expect(201);
    expect((await request(ctx.app).get('/api/flags/short-lived/evaluate').set(sdkKey())).status).toBe(
      200,
    );

    await request(ctx.app).delete('/api/flags/short-lived').set(auth()).expect(204);

    expect((await request(ctx.app).get('/api/flags/short-lived/evaluate').set(sdkKey())).status).toBe(
      404,
    );
  });

  it('returns 400 for a key that is not a valid slug', async () => {
    const res = await request(ctx.app).get('/api/flags/Not_A_Slug/evaluate').set(sdkKey());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_flag_key');
  });
});
