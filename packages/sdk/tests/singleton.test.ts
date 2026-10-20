import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { close, init, isEnabled } from '../src/index.js';
import { createFakeFetch, FLAG, respondWith } from './helpers/fake-fetch.js';

/**
 * The module-level API — what a host app actually imports. It wraps a single
 * default client so `isEnabled` can be called from anywhere without threading
 * an instance through the codebase.
 */

const BASE = { apiUrl: 'http://flags.test', apiKey: 'sdk-key-123', refreshIntervalMs: 30_000 };
const AT_100 = FLAG({ rolloutPercentage: 100 });

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  close();
  vi.restoreAllMocks();
});

describe('module-level init/isEnabled', () => {
  it('serves flags after init', async () => {
    const fetch = createFakeFetch(respondWith.flags([AT_100]));
    await init({ ...BASE, fetch });

    expect(isEnabled('demo-flag', { userId: 'user_1' })).toBe(true);
  });

  it('returns the default before init, without throwing', () => {
    expect(() => isEnabled('demo-flag', { userId: 'u' })).not.toThrow();
    expect(isEnabled('demo-flag', { userId: 'u' })).toBe(false);
    expect(isEnabled('demo-flag', { userId: 'u' }, true)).toBe(true);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('warns only once before init, however many calls', () => {
    for (let i = 0; i < 100; i += 1) isEnabled('demo-flag', { userId: `u${i}` });
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('keeps the host running on defaults when the key is rejected', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetch = createFakeFetch(respondWith.status(401));

    const result = await init({ ...BASE, fetch });

    expect(result).toMatchObject({ ok: false, status: { state: 'unauthorized' } });
    expect(isEnabled('demo-flag', { userId: 'u' })).toBe(false);
    expect(isEnabled('demo-flag', { userId: 'u' }, true)).toBe(true);
  });

  it('boots even when the flag service is unreachable', async () => {
    const fetch = createFakeFetch(respondWith.networkError());

    await expect(init({ ...BASE, fetch })).resolves.toMatchObject({ ok: false });
    expect(isEnabled('demo-flag', { userId: 'u' })).toBe(false);
    expect(isEnabled('demo-flag', { userId: 'u' }, true)).toBe(true);
  });

  it('replaces the previous client when init is called again', async () => {
    const first = createFakeFetch(respondWith.flags([FLAG({ rolloutPercentage: 0 })]));
    await init({ ...BASE, fetch: first });
    expect(isEnabled('demo-flag', { userId: 'user_1' })).toBe(false);

    const second = createFakeFetch(respondWith.flags([AT_100]));
    await init({ ...BASE, fetch: second });

    expect(isEnabled('demo-flag', { userId: 'user_1' })).toBe(true);
  });

  it('close() returns it to the uninitialised state', async () => {
    const fetch = createFakeFetch(respondWith.flags([AT_100]));
    await init({ ...BASE, fetch });
    expect(isEnabled('demo-flag', { userId: 'user_1' })).toBe(true);

    close();

    expect(isEnabled('demo-flag', { userId: 'user_1' })).toBe(false);
  });

  it('close() is safe before init', () => {
    expect(() => close()).not.toThrow();
  });
});
