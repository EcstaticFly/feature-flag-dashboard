import { computeBucket, evaluateFlag, type FlagConfig } from '@feature-flags/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlagClient } from '../src/client.js';
import { createFakeFetch, FLAG, respondWith } from './helpers/fake-fetch.js';

const BASE = { apiUrl: 'http://flags.test', apiKey: 'sdk-key-123' };

const ROLLOUT: FlagConfig = FLAG({ key: 'rollout-flag', rolloutPercentage: 30 });
const TARGETED: FlagConfig = FLAG({
  key: 'targeted-flag',
  rolloutPercentage: 0,
  targetingRules: [
    { attribute: 'plan', operator: 'eq', values: ['pro'] },
    { attribute: 'userId', operator: 'in', values: ['vip-user'] },
  ],
});
const OFF: FlagConfig = FLAG({ key: 'off-flag', enabled: false, rolloutPercentage: 100 });

async function client(overrides: Record<string, unknown> = {}) {
  const fetch = createFakeFetch(respondWith.flags([ROLLOUT, TARGETED, OFF]));
  const c = createFlagClient({ ...BASE, fetch, ...overrides });
  await c.init();
  return { c, fetch };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('agreement with the API', () => {
  // The whole reason @feature-flags/core is a separate package: the SDK and the
  // API must answer identically for the same user, or a user would see one
  // variant from the server and another from the SDK.
  it.each(['user_1', 'user_2', 'user_7', 'user_42', 'vip-user', 'anon'])(
    'matches evaluateFlag for %s across every flag',
    async (userId) => {
      const { c } = await client();
      for (const flag of [ROLLOUT, TARGETED, OFF]) {
        expect(c.isEnabled(flag.key, { userId })).toBe(evaluateFlag(flag, { userId }));
      }
      c.close();
    },
  );

  it('applies targeting attributes', async () => {
    const { c } = await client();

    expect(c.isEnabled('targeted-flag', { userId: 'u1', attributes: { plan: 'pro' } })).toBe(true);
    expect(c.isEnabled('targeted-flag', { userId: 'u1', attributes: { plan: 'free' } })).toBe(false);
    expect(c.isEnabled('targeted-flag', { userId: 'vip-user' })).toBe(true);
    c.close();
  });

  it('honours the kill switch regardless of rollout', async () => {
    const { c } = await client();
    expect(c.isEnabled('off-flag', { userId: 'user_1' })).toBe(false);
    c.close();
  });

  it('is deterministic: the same user gets the same answer every time', async () => {
    const { c } = await client();
    const first = c.isEnabled('rollout-flag', { userId: 'user_9' });
    for (let i = 0; i < 100; i += 1) {
      expect(c.isEnabled('rollout-flag', { userId: 'user_9' })).toBe(first);
    }
    c.close();
  });

  it('includes roughly the configured share of users', async () => {
    const { c } = await client();
    const users = Array.from({ length: 10_000 }, (_, i) => `user_${i}`);
    const share = users.filter((userId) => c.isEnabled('rollout-flag', { userId })).length / 100;

    expect(Math.abs(share - 30)).toBeLessThanOrEqual(3);
    c.close();
  });
});

describe('no network on the hot path', () => {
  // FR-08: resolving a flag must not cost a round trip.
  it('makes zero HTTP requests across 10,000 checks', async () => {
    const { c, fetch } = await client();
    const afterInit = fetch.calls;
    expect(afterInit).toBe(1);

    const started = performance.now();
    for (let i = 0; i < 10_000; i += 1) {
      c.isEnabled('rollout-flag', { userId: `user_${i}` });
    }
    const elapsed = performance.now() - started;

    expect(fetch.calls).toBe(afterInit);
    // In-process hashing; a network call per check could never manage this.
    expect(elapsed).toBeLessThan(1000);
    c.close();
  });

  it('is synchronous — it returns a boolean, not a promise', async () => {
    const { c } = await client();
    expect(typeof c.isEnabled('rollout-flag', { userId: 'u' })).toBe('boolean');
    c.close();
  });
});

describe('never throws, always answers', () => {
  it('returns the per-call default for an unknown flag', async () => {
    const { c } = await client();

    expect(c.isEnabled('no-such-flag', { userId: 'u1' })).toBe(false);
    expect(c.isEnabled('no-such-flag', { userId: 'u1' }, true)).toBe(true);
    c.close();
  });

  it('falls back to the client default when no per-call default is given', async () => {
    const { c } = await client({ defaultValue: true });
    expect(c.isEnabled('no-such-flag', { userId: 'u1' })).toBe(true);
    c.close();
  });

  it('prefers the per-call default over the client default', async () => {
    const { c } = await client({ defaultValue: true });
    expect(c.isEnabled('no-such-flag', { userId: 'u1' }, false)).toBe(false);
    c.close();
  });

  it('warns once per unknown key, not once per call', async () => {
    const { c } = await client();
    for (let i = 0; i < 500; i += 1) c.isEnabled('missing', { userId: `u${i}` });

    const warnings = vi
      .mocked(console.warn)
      .mock.calls.filter(([msg]) => String(msg).includes("unknown flag 'missing'"));
    expect(warnings).toHaveLength(1);
    c.close();
  });

  it('returns the default before init() instead of throwing', () => {
    const fetch = createFakeFetch(respondWith.flags([ROLLOUT]));
    const c = createFlagClient({ ...BASE, fetch });

    expect(() => c.isEnabled('rollout-flag', { userId: 'u1' })).not.toThrow();
    expect(c.isEnabled('rollout-flag', { userId: 'u1' })).toBe(false);
    expect(c.isEnabled('rollout-flag', { userId: 'u1' }, true)).toBe(true);
    c.close();
  });

  it.each([
    ['no context', undefined],
    ['an empty userId', { userId: '' }],
    ['odd attribute types', { userId: 'u', attributes: { n: 42, b: true } }],
  ])('survives %s', async (_label, context) => {
    const { c } = await client();
    expect(() => c.isEnabled('rollout-flag', context as never)).not.toThrow();
    c.close();
  });

  it('returns the default if a snapshot entry is somehow corrupt', async () => {
    // A rule shape the evaluator has never seen must not take down a host app.
    const fetch = createFakeFetch(
      respondWith.body({ flags: [{ key: 'weird', enabled: true, targetingRules: 'not-an-array' }] }),
    );
    const c = createFlagClient({ ...BASE, fetch });
    await c.init();

    expect(() => c.isEnabled('weird', { userId: 'u1' })).not.toThrow();
    c.close();
  });
});

describe('buckets match the server', () => {
  it('uses the same hash, so a bucket is the same in both places', async () => {
    const { c } = await client();
    // bucket 0..99; a user below the percentage is in.
    const user = 'user_1';
    const bucket = computeBucket(user, 'rollout-flag');
    expect(c.isEnabled('rollout-flag', { userId: user })).toBe(bucket < 30);
    c.close();
  });
});
