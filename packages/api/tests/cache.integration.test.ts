import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client.js';
import { createFlagCache, type FlagCache } from '../src/services/cache/flag-cache.js';
import { createRedis, ensureConnected } from '../src/services/cache/redis.js';
import { createFlagService } from '../src/services/flags/flag-service.js';
import { AUTH, startTestApp, type TestApp } from './helpers/test-app.js';

let ctx: TestApp;

const auth = () => ({ Authorization: `Bearer ${ctx.token}` });
const sdkKey = () => ({ 'x-api-key': AUTH.sdkApiKey });

/** Direct Redis access, for asserting what is actually cached. */
async function inspector() {
  const client = createRedis(ctx.redisUrl);
  await ensureConnected(client);
  return client;
}

const until = async (predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

beforeAll(async () => {
  ctx = await startTestApp({ withRedis: true });
  await request(ctx.app)
    .post('/api/flags')
    .set(auth())
    .send({ key: 'cached-flag', name: 'Cached', enabled: true, rolloutPercentage: 10 });
});

afterAll(async () => {
  await ctx?.close();
});

describe('cache tiers', () => {
  it('loads from Postgres on a cold read and writes it to Redis', async () => {
    const redis = await inspector();
    try {
      await redis.del('flags:all');
      const before = ctx.cache.stats().dbLoads;

      const res = await request(ctx.app).get('/api/sdk/flags').set(sdkKey());

      expect(res.status).toBe(200);
      expect(ctx.cache.stats().dbLoads).toBe(before + 1);
      expect(await redis.get('flags:all')).toContain('cached-flag');
    } finally {
      redis.disconnect();
    }
  });

  it('serves the next read from the in-process tier, without touching Postgres', async () => {
    await request(ctx.app).get('/api/sdk/flags').set(sdkKey());
    const before = ctx.cache.stats();

    await request(ctx.app).get('/api/sdk/flags').set(sdkKey());

    const after = ctx.cache.stats();
    expect(after.dbLoads).toBe(before.dbLoads);
    expect(after.l1Hits).toBe(before.l1Hits + 1);
  });

  it('falls back to Postgres and repopulates when the Redis key is gone', async () => {
    const redis = await inspector();
    try {
      // Clear both tiers: Redis directly, and L1 via an invalidation.
      await ctx.cache.invalidate('cached-flag');
      expect(await redis.get('flags:all')).toBeNull();

      const before = ctx.cache.stats().dbLoads;
      const res = await request(ctx.app).get('/api/sdk/flags').set(sdkKey());

      expect(res.status).toBe(200);
      expect(ctx.cache.stats().dbLoads).toBe(before + 1);
      expect(await redis.get('flags:all')).toContain('cached-flag');
    } finally {
      redis.disconnect();
    }
  });

  it('caches an individual flag under its own key for /evaluate', async () => {
    const redis = await inspector();
    try {
      await redis.del('flag:cached-flag');
      await request(ctx.app)
        .get('/api/flags/cached-flag/evaluate?userId=user_1')
        .set(sdkKey())
        .expect(200);

      expect(await redis.get('flag:cached-flag')).toContain('cached-flag');
    } finally {
      redis.disconnect();
    }
  });
});

describe('invalidation', () => {
  it('clears both Redis keys when a flag is mutated', async () => {
    const redis = await inspector();
    try {
      await request(ctx.app).get('/api/sdk/flags').set(sdkKey());
      await request(ctx.app).get('/api/flags/cached-flag/evaluate?userId=u').set(sdkKey());
      expect(await redis.get('flags:all')).not.toBeNull();
      expect(await redis.get('flag:cached-flag')).not.toBeNull();

      await request(ctx.app)
        .patch('/api/flags/cached-flag')
        .set(auth())
        .send({ rolloutPercentage: 90 })
        .expect(200);

      expect(await redis.get('flags:all')).toBeNull();
      expect(await redis.get('flag:cached-flag')).toBeNull();
    } finally {
      redis.disconnect();
    }
  });

  it('makes a change visible immediately through the API', async () => {
    await request(ctx.app)
      .patch('/api/flags/cached-flag')
      .set(auth())
      .send({ rolloutPercentage: 100 })
      .expect(200);

    const res = await request(ctx.app).get('/api/sdk/flags').set(sdkKey());
    expect(res.body.flags).toContainEqual(
      expect.objectContaining({ key: 'cached-flag', rolloutPercentage: 100 }),
    );
  });
});

describe('propagation to other instances (NFR-02)', () => {
  it('drops a second instance’s in-process copy within 2s of a mutation', async () => {
    // A second FlagCache over the same Redis and database stands in for a
    // second API instance: it has its own L1, which only pub/sub can reach.
    const { pool, db } = createDb(ctx.connectionUri);
    const redis = createRedis(ctx.redisUrl);
    const subscriber = createRedis(ctx.redisUrl);
    const other = createFlagCache({ redis, subscriber, db, ttlSeconds: 300 });
    await other.start();

    try {
      await request(ctx.app)
        .patch('/api/flags/cached-flag')
        .set(auth())
        .send({ rolloutPercentage: 10 })
        .expect(200);

      // Warm the second instance so it is definitely holding a local copy.
      expect((await other.getFlag('cached-flag'))?.rolloutPercentage).toBe(10);

      // Mutate through the first instance only.
      await request(ctx.app)
        .patch('/api/flags/cached-flag')
        .set(auth())
        .send({ rolloutPercentage: 55 })
        .expect(200);

      // Its TTL is 300s, so nothing but the published invalidation can have
      // told it to look again.
      const propagated = await until(
        async () => (await other.getFlag('cached-flag'))?.rolloutPercentage === 55,
      );
      expect(propagated).toBe(true);
    } finally {
      await other.close();
      redis.disconnect();
      subscriber.disconnect();
      await pool.end();
    }
  });
});

describe('TTL safety net', () => {
  it('refreshes a stale local copy even when the invalidation never arrives', async () => {
    // Deliberately never subscribed: this is the "missed pub/sub message" path
    // the short TTL exists to cover.
    const { pool, db } = createDb(ctx.connectionUri);
    const redis = createRedis(ctx.redisUrl);
    const deaf = createFlagCache({ redis, subscriber: redis, db, ttlSeconds: 1 });

    try {
      await request(ctx.app)
        .patch('/api/flags/cached-flag')
        .set(auth())
        .send({ rolloutPercentage: 20 })
        .expect(200);
      expect((await deaf.getFlag('cached-flag'))?.rolloutPercentage).toBe(20);

      // Change it behind the deaf instance's back, then bypass Redis too so the
      // only way it can notice is by its own entry expiring.
      await request(ctx.app)
        .patch('/api/flags/cached-flag')
        .set(auth())
        .send({ rolloutPercentage: 77 })
        .expect(200);

      const refreshed = await until(
        async () => (await deaf.getFlag('cached-flag'))?.rolloutPercentage === 77,
        4000,
      );
      expect(refreshed).toBe(true);
    } finally {
      redis.disconnect();
      await pool.end();
    }
  });
});

describe('service-level invalidation', () => {
  it('applies to every mutation, including ones made without HTTP (Milestone 6)', async () => {
    const redis = await inspector();
    try {
      const flags = createFlagService(ctx.db, ctx.cache as FlagCache);
      await request(ctx.app).get('/api/sdk/flags').set(sdkKey());
      expect(await redis.get('flags:all')).not.toBeNull();

      // The integration endpoint will call the service directly like this.
      await flags.updateFlag('system:integration', 'cached-flag', { enabled: false });

      expect(await redis.get('flags:all')).toBeNull();
    } finally {
      redis.disconnect();
    }
  });
});
