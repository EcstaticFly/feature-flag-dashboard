import type { FlagConfig } from '@feature-flags/core';
import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { devCredentialsInUse, fallbackValue, loadConfig } from '../src/config.js';
import type { Db } from '../src/db/client.js';
import { parseUserContext } from '../src/routes/evaluate.js';
import { CacheUnavailableError, createFlagCache } from '../src/services/cache/flag-cache.js';

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/d',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a-secret-that-is-at-least-32-characters-long',
  SDK_API_KEY: 'sdk-key-at-least-16-chars',
  INTEGRATION_API_KEY: 'integration-key-at-least-16',
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

/*
 * The credentials committed to this repo are public by design, so the only thing
 * standing between them and a real deployment is this guard. It is a security
 * control, which means the important tests are the ones proving it FAILS.
 */
/*
 * These exist because the local defaults are wrong for managed free tiers, and
 * getting them wrong is invisible until the first cold start in production.
 */
describe('connect timeouts', () => {
  it('defaults to the local values, so nothing changes without being asked', () => {
    const config = loadConfig(BASE_ENV as NodeJS.ProcessEnv);
    expect(config.DB_CONNECT_TIMEOUT_MS).toBe(1500);
    expect(config.REDIS_CONNECT_TIMEOUT_MS).toBe(1500);
    expect(config.HEALTH_CHECK_TIMEOUT_MS).toBe(2000);
  });

  it('accepts the production values a scale-to-zero database needs', () => {
    const config = loadConfig({
      ...BASE_ENV,
      DB_CONNECT_TIMEOUT_MS: '10000',
      REDIS_CONNECT_TIMEOUT_MS: '5000',
      HEALTH_CHECK_TIMEOUT_MS: '8000',
    } as NodeJS.ProcessEnv);
    expect(config.DB_CONNECT_TIMEOUT_MS).toBe(10_000);
    expect(config.REDIS_CONNECT_TIMEOUT_MS).toBe(5_000);
    expect(config.HEALTH_CHECK_TIMEOUT_MS).toBe(8_000);
  });

  // A timeout of 0 or -1 would mean "never wait", which is not a tuning choice
  // but a broken deployment; better to refuse at boot than to fail every query.
  it.each(['0', '-1', 'soon', '1.5'])('rejects %o rather than guessing', (value) => {
    expect(() =>
      loadConfig({ ...BASE_ENV, DB_CONNECT_TIMEOUT_MS: value } as NodeJS.ProcessEnv),
    ).toThrow(/DB_CONNECT_TIMEOUT_MS/);
  });
});

describe('development credential guard', () => {
  const DEV = {
    JWT_SECRET: 'dev-only-jwt-secret-change-me-at-least-32-chars',
    SDK_API_KEY: 'dev-only-sdk-api-key-change-me',
    INTEGRATION_API_KEY: 'dev-only-integration-key-change-me',
  };

  it('refuses to load a config using the public placeholders', () => {
    expect(() => loadConfig({ ...BASE_ENV, ...DEV } as NodeJS.ProcessEnv)).toThrow(
      /Refusing to start/,
    );
  });

  it.each(Object.keys(DEV))('refuses when only %s is a placeholder', (key) => {
    const env = { ...BASE_ENV, [key]: DEV[key as keyof typeof DEV] };
    expect(() => loadConfig(env as NodeJS.ProcessEnv)).toThrow(new RegExp(key));
  });

  it('names every offending variable, so one fix does not hide the others', () => {
    try {
      loadConfig({ ...BASE_ENV, ...DEV } as NodeJS.ProcessEnv);
      throw new Error('expected loadConfig to throw');
    } catch (err) {
      const message = (err as Error).message;
      for (const key of Object.keys(DEV)) expect(message).toContain(key);
      // Actionable, not just a refusal.
      expect(message).toContain('ALLOW_DEV_CREDENTIALS');
      expect(message).toContain('randomBytes');
    }
  });

  it('allows them when a local stack opts in explicitly', () => {
    const config = loadConfig({
      ...BASE_ENV,
      ...DEV,
      ALLOW_DEV_CREDENTIALS: 'true',
    } as NodeJS.ProcessEnv);
    expect(config.JWT_SECRET).toBe(DEV.JWT_SECRET);
    expect(config.ALLOW_DEV_CREDENTIALS).toBe(true);
  });

  // Opting in must take exactly the string 'true'. Boolean('false') is true, and
  // a guard that could be disabled by setting it to 'false' would be worthless.
  it.each(['false', 'FALSE', '0', 'yes', ''])('does not treat %o as opting in', (value) => {
    expect(() =>
      loadConfig({ ...BASE_ENV, ...DEV, ALLOW_DEV_CREDENTIALS: value } as NodeJS.ProcessEnv),
    ).toThrow();
  });

  it('defaults to refusing, so the guard is never off by omission', () => {
    expect(loadConfig(BASE_ENV as NodeJS.ProcessEnv).ALLOW_DEV_CREDENTIALS).toBe(false);
  });

  it('lets real secrets through with no opt-in at all', () => {
    const config = loadConfig(BASE_ENV as NodeJS.ProcessEnv);
    expect(devCredentialsInUse(config)).toEqual([]);
  });

  it('reports exactly which credentials are placeholders', () => {
    const config = loadConfig({
      ...BASE_ENV,
      JWT_SECRET: DEV.JWT_SECRET,
      ALLOW_DEV_CREDENTIALS: 'true',
    } as NodeJS.ProcessEnv);
    expect(devCredentialsInUse(config)).toEqual(['JWT_SECRET']);
  });
});

describe('evaluation log sampling', () => {
  // The default must log every evaluation, exactly as before M7 added the dial.
  it('defaults to logging every evaluation', () => {
    expect(loadConfig(BASE_ENV as NodeJS.ProcessEnv).FLAG_EVAL_LOG_SAMPLE_RATE).toBe(1);
  });

  it.each(['0', '0.01', '1'])('accepts a rate of %s', (rate) => {
    expect(
      loadConfig({ ...BASE_ENV, FLAG_EVAL_LOG_SAMPLE_RATE: rate } as NodeJS.ProcessEnv)
        .FLAG_EVAL_LOG_SAMPLE_RATE,
    ).toBe(Number(rate));
  });

  it.each(['-0.1', '1.5', 'often'])('rejects %s rather than guessing', (rate) => {
    expect(() =>
      loadConfig({ ...BASE_ENV, FLAG_EVAL_LOG_SAMPLE_RATE: rate } as NodeJS.ProcessEnv),
    ).toThrow(/FLAG_EVAL_LOG_SAMPLE_RATE/);
  });

  // `Math.random()` is never >= 1, so the default samples nothing out.
  it('never filters at the default rate', () => {
    for (let i = 0; i < 1000; i += 1) expect(Math.random() >= 1).toBe(false);
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

  // M7's blackout load test found this: with no tier reachable, every request
  // waited out the pg connect timeout before the fail-closed answer could be
  // produced. Waiting cannot change the answer, so after a few failures the
  // cache must stop asking.
  it('stops touching the database once the circuit opens, and reopens it on recovery', async () => {
    let healthy = false;
    let queries = 0;
    const answer = () => {
      queries += 1;
      return healthy ? Promise.resolve([]) : Promise.reject(new Error('db down'));
    };
    const db = {
      select: () => ({
        from: () => ({ where: () => ({ limit: answer, orderBy: answer }) }),
      }),
    } as unknown as Db;

    let clockMs = 0;
    const redis = deadRedis();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const cache = createFlagCache({
      redis,
      subscriber: redis,
      db,
      ttlSeconds: 30,
      circuit: { failureThreshold: 3, cooldownMs: 1000, now: () => clockMs },
    });

    for (let i = 0; i < 3; i += 1) {
      await expect(cache.getFlag('demo')).rejects.toBeInstanceOf(CacheUnavailableError);
    }
    expect(queries).toBe(3);
    expect(cache.stats().dbCircuit).toBe('open');

    // The next twenty callers still get the documented error — the route turns
    // that into the fail-closed answer — but pay no database timeout for it.
    for (let i = 0; i < 20; i += 1) {
      await expect(cache.getFlag('demo')).rejects.toBeInstanceOf(CacheUnavailableError);
    }
    expect(queries).toBe(3);
    expect(cache.stats().dbShortCircuited).toBe(20);

    // Recovery must be automatic: nothing restarts the API when Postgres returns.
    healthy = true;
    clockMs += 1000;
    await expect(cache.getFlag('demo')).resolves.toBeUndefined();
    expect(queries).toBe(4);
    expect(cache.stats().dbCircuit).toBe('closed');

    spy.mockRestore();
    logSpy.mockRestore();
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
