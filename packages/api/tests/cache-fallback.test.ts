import type { FlagConfig } from '@feature-flags/core';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { fallbackValue, loadConfig } from '../src/config.js';
import type { Db } from '../src/db/client.js';
import { parseUserContext } from '../src/routes/evaluate.js';
import { CacheUnavailableError, createFlagCache } from '../src/services/cache/flag-cache.js';

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/d',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a-secret-that-is-at-least-32-characters-long',
  SDK_API_KEY: 'sdk-key-at-least-16-chars',
};

describe('fallback policy', () => {
  it('defaults to fail-closed, so an unreadable flag is off', () => {
    const config = loadConfig(BASE_ENV as NodeJS.ProcessEnv);
    expect(config.FLAG_FALLBACK_POLICY).toBe('fail-closed');
    expect(fallbackValue(config.FLAG_FALLBACK_POLICY)).toBe(false);
  });

  it('maps fail-open to true', () => {
    const config = loadConfig({
      ...BASE_ENV,
      FLAG_FALLBACK_POLICY: 'fail-open',
    } as NodeJS.ProcessEnv);
    expect(fallbackValue(config.FLAG_FALLBACK_POLICY)).toBe(true);
  });

  it('rejects an unrecognised policy rather than guessing', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, FLAG_FALLBACK_POLICY: 'maybe' } as NodeJS.ProcessEnv),
    ).toThrow(/FLAG_FALLBACK_POLICY/);
  });

  it('defaults the cache TTL to 30 seconds', () => {
    expect(loadConfig(BASE_ENV as NodeJS.ProcessEnv).FLAG_CACHE_TTL_SECONDS).toBe(30);
  });
});

describe('parseUserContext', () => {
  it('reads userId and attr.* parameters', () => {
    expect(parseUserContext({ userId: 'u_1', 'attr.plan': 'pro', 'attr.email': 'a@b.com' })).toEqual(
      { userId: 'u_1', attributes: { plan: 'pro', email: 'a@b.com' } },
    );
  });

  it('omits attributes entirely when none are given', () => {
    expect(parseUserContext({ userId: 'u_1' })).toEqual({ userId: 'u_1' });
  });

  it('returns undefined when the query carries no context at all', () => {
    expect(parseUserContext({})).toBeUndefined();
  });

  it('ignores parameters that are not attr.*', () => {
    expect(parseUserContext({ userId: 'u', plan: 'pro' })).toEqual({ userId: 'u' });
  });

  it('takes the first value of a repeated parameter', () => {
    expect(parseUserContext({ userId: ['first', 'second'] })).toEqual({ userId: 'first' });
  });
});

/** A Redis stand-in whose every command rejects, as if the server were down. */
function deadRedis(): Redis {
  const fail = () => Promise.reject(new Error('ECONNREFUSED'));
  return {
    status: 'ready',
    connect: fail,
    get: fail,
    setex: fail,
    del: fail,
    publish: fail,
    subscribe: fail,
    unsubscribe: fail,
    on: () => undefined,
  } as unknown as Redis;
}

const CONFIG: FlagConfig = {
  key: 'demo',
  enabled: true,
  rolloutPercentage: 50,
  targetingRules: [],
};

describe('flag cache with Redis unreachable', () => {
  it('still resolves from the database, without throwing', async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]),
            orderBy: () => Promise.resolve([]),
          }),
        }),
      }),
    } as unknown as Db;

    const redis = deadRedis();
    const cache = createFlagCache({ redis, subscriber: redis, db, ttlSeconds: 30 });

    // Reaches the database tier and gets an empty result set, rather than
    // surfacing the Redis error.
    await expect(cache.getAll()).resolves.toEqual([]);
    await expect(cache.getFlag('demo')).resolves.toBeUndefined();
    expect(cache.stats().dbLoads).toBeGreaterThan(0);

    // Invalidation cannot reach Redis either, and must stay silent about it.
    await expect(cache.invalidate('demo')).resolves.toBeUndefined();
    await expect(cache.start()).resolves.toBeUndefined();
  });

  it('raises CacheUnavailableError only when the database is down too', async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.reject(new Error('db down')),
            orderBy: () => Promise.reject(new Error('db down')),
          }),
        }),
      }),
    } as unknown as Db;

    const redis = deadRedis();
    const cache = createFlagCache({ redis, subscriber: redis, db, ttlSeconds: 30 });

    await expect(cache.getAll()).rejects.toBeInstanceOf(CacheUnavailableError);
    await expect(cache.getFlag('demo')).rejects.toBeInstanceOf(CacheUnavailableError);
  });

  it('serves a stale snapshot rather than failing when the database dies later', async () => {
    let healthy = true;
    const rows = [
      {
        id: 'x',
        key: CONFIG.key,
        name: 'Demo',
        description: null,
        enabled: CONFIG.enabled,
        rolloutPercentage: CONFIG.rolloutPercentage,
        targetingRules: CONFIG.targetingRules,
        deletedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => (healthy ? Promise.resolve(rows) : Promise.reject(new Error('db down'))),
            limit: () => (healthy ? Promise.resolve(rows) : Promise.reject(new Error('db down'))),
          }),
        }),
      }),
    } as unknown as Db;

    const redis = deadRedis();
    const cache = createFlagCache({ redis, subscriber: redis, db, ttlSeconds: 0.001 });

    expect(await cache.getAll()).toEqual([CONFIG]);

    healthy = false;
    await new Promise((r) => setTimeout(r, 20)); // let the TTL lapse
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Expired, and the database is gone — the last known good value is still
    // far better than an empty list, which would read as "all flags deleted".
    expect(await cache.getAll()).toEqual([CONFIG]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
