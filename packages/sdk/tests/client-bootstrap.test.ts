import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlagClient } from '../src/client.js';
import { close, getClientFlags, getStatus, init, signContext } from '../src/index.js';
import { createFakeFetch, FLAG, respondWith } from './helpers/fake-fetch.js';

/*
 * The server SDK's two new jobs, both for browsers it never talks to:
 * getClientFlags bootstraps a server-rendered page, and signContext gives the
 * browser a tamper-proof identity. Neither may ever throw.
 *
 * Bucket facts (frozen hash, pinned in core's golden tests): for
 * 'new-checkout-flow', carol is bucket 2 and alice bucket 34.
 */

const BASE = { apiUrl: 'http://flags.test', apiKey: 'sdk-key-123' };

const CHECKOUT = FLAG({ key: 'new-checkout-flow', rolloutPercentage: 10, clientSide: true });
const SERVER_ONLY = FLAG({ key: 'server-only', rolloutPercentage: 100 });
const KILLED = FLAG({ key: 'killed', enabled: false, rolloutPercentage: 100, clientSide: true });

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  close();
  vi.restoreAllMocks();
});

async function readyClient() {
  const client = createFlagClient({ ...BASE, fetch: createFakeFetch(respondWith.flags([CHECKOUT, SERVER_ONLY, KILLED])) });
  await client.init();
  return client;
}

describe('getClientFlags', () => {
  it('returns only flags exposed to browsers, evaluated for the context', async () => {
    const client = await readyClient();
    expect(client.getClientFlags({ userId: 'carol' })).toEqual({ 'new-checkout-flow': true, killed: false });
    expect(client.getClientFlags({ userId: 'alice' })).toEqual({ 'new-checkout-flow': false, killed: false });
    client.close();
  });

  it('treats a missing context as anonymous, exactly as the browser endpoint does', async () => {
    const client = await readyClient();
    expect(client.getClientFlags()).toEqual({ 'new-checkout-flow': true, killed: false });
    expect(client.getClientFlags({})).toEqual({ 'new-checkout-flow': true, killed: false });
    client.close();
  });

  it('returns {} before flags have loaded', () => {
    const client = createFlagClient({ ...BASE, fetch: createFakeFetch(respondWith.networkError()) });
    expect(client.getClientFlags({ userId: 'carol' })).toEqual({});
    client.close();
  });

  it('returns {} — never throws — for a context the browser endpoint would reject', async () => {
    const client = await readyClient();
    const bad = { userId: 'u1', attributes: { nested: { no: true } } } as never;
    expect(() => client.getClientFlags(bad)).not.toThrow();
    expect(client.getClientFlags(bad)).toEqual({});
    client.close();
  });
});

describe('signContext', () => {
  it('produces a v1 token, the same one every time for the same context', async () => {
    const client = await readyClient();
    const a = await client.signContext({ userId: 'carol', attributes: { plan: 'pro', region: 'eu' } });
    const b = await client.signContext({ attributes: { region: 'eu', plan: 'pro' }, userId: 'carol' });
    expect(a).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    // Deterministic: a Next.js server component re-rendering with the same
    // user produces the same token, so the browser does not refetch.
    expect(a).toBe(b);
    client.close();
  });

  it('differs between users and between SDK keys', async () => {
    const client = await readyClient();
    const other = createFlagClient({ ...BASE, apiKey: 'another-sdk-key', fetch: createFakeFetch(respondWith.networkError()) });
    const carol = await client.signContext({ userId: 'carol' });
    expect(await client.signContext({ userId: 'alice' })).not.toBe(carol);
    expect(await other.signContext({ userId: 'carol' })).not.toBe(carol);
    client.close();
    other.close();
  });

  it('works before init — signing needs only the key, not the flags', async () => {
    const client = createFlagClient({ ...BASE, fetch: createFakeFetch(respondWith.networkError()) });
    expect(await client.signContext({ userId: 'carol' })).toMatch(/^v1\./);
    client.close();
  });

  it('resolves to null, never rejects, for an invalid context', async () => {
    const client = await readyClient();
    // JSON.parse creates `__proto__` as an OWN key — how a hostile value arrives.
    await expect(
      client.signContext(JSON.parse('{"userId":"u1","attributes":{"__proto__":"x"}}')),
    ).resolves.toBeNull();
    await expect(client.signContext({ userId: 42 } as never)).resolves.toBeNull();
    client.close();
  });

  it('resolves to null when the runtime has no Web Crypto', async () => {
    const client = await readyClient();
    vi.stubGlobal('crypto', undefined);
    try {
      await expect(client.signContext({ userId: 'carol' })).resolves.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
    client.close();
  });

  it('resolves to null for a misconfigured client', async () => {
    const client = createFlagClient({ ...BASE, apiKey: '' });
    await expect(client.signContext({ userId: 'carol' })).resolves.toBeNull();
  });
});

describe('module-level helpers', () => {
  it('serve defaults before init and work after it', async () => {
    expect(getClientFlags({ userId: 'carol' })).toEqual({});
    await expect(signContext({ userId: 'carol' })).resolves.toBeNull();
    expect(getStatus()).toEqual({ state: 'idle', hasValues: false, lastUpdated: null, lastError: null });

    await init({ ...BASE, fetch: createFakeFetch(respondWith.flags([CHECKOUT])) });

    expect(getClientFlags({ userId: 'carol' })).toEqual({ 'new-checkout-flow': true });
    expect(await signContext({ userId: 'carol' })).toMatch(/^v1\./);
    expect(getStatus()).toMatchObject({ state: 'ready', hasValues: true });
  });

  /*
   * Next.js can load server code as several module instances, and HMR
   * re-evaluates modules. The default client lives on globalThis so that an
   * init() in one instance is visible to isEnabled() in another.
   */
  it('share one default client across separately loaded copies of the module', async () => {
    await init({ ...BASE, fetch: createFakeFetch(respondWith.flags([CHECKOUT])) });

    vi.resetModules();
    const secondCopy = await import('../src/index.js');
    expect(secondCopy.getClientFlags({ userId: 'carol' })).toEqual({ 'new-checkout-flow': true });
    expect(secondCopy.isEnabled('new-checkout-flow', { userId: 'carol' })).toBe(true);

    // ...and close() from either copy clears it for both.
    secondCopy.close();
    expect(getStatus().state).toBe('idle');
  });
});
