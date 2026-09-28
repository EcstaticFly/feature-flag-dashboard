import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlagClient, FlagClientError } from '../src/client.js';
import { createFakeFetch, FLAG, respondWith } from './helpers/fake-fetch.js';

const BASE = { apiUrl: 'http://flags.test', apiKey: 'sdk-key-123' };

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('config validation — developer errors fail loudly', () => {
  const fetch = createFakeFetch(respondWith.flags([FLAG()]));

  it.each([
    ['missing apiUrl', { ...BASE, apiUrl: '' }],
    ['whitespace apiUrl', { ...BASE, apiUrl: '   ' }],
    ['missing apiKey', { ...BASE, apiKey: '' }],
    ['whitespace apiKey', { ...BASE, apiKey: '  ' }],
    ['zero refreshIntervalMs', { ...BASE, refreshIntervalMs: 0 }],
    ['negative refreshIntervalMs', { ...BASE, refreshIntervalMs: -1 }],
    ['zero requestTimeoutMs', { ...BASE, requestTimeoutMs: 0 }],
  ])('throws for %s', (_label, config) => {
    expect(() => createFlagClient({ ...config, fetch })).toThrow(FlagClientError);
  });

  it('trims a trailing slash from apiUrl so the path is never doubled', async () => {
    const f = createFakeFetch(respondWith.flags([FLAG()]));
    const client = createFlagClient({ ...BASE, apiUrl: 'http://flags.test///', fetch: f });
    await client.init();
    client.close();

    expect(f.requests[0]?.url).toBe('http://flags.test/api/sdk/flags');
  });
});

describe('init() against a rejecting service', () => {
  it.each([401, 403])('throws when the API rejects the key with %i', async (status) => {
    const fetch = createFakeFetch(respondWith.status(status));
    const client = createFlagClient({ ...BASE, fetch });

    await expect(client.init()).rejects.toThrow(/rejected the API key/);
    client.close();
  });
});

describe('init() against an unavailable service', () => {
  // The milestone's headline requirement: a flag service that is down must not
  // stop the host application from booting.
  it.each([
    ['a network error', respondWith.networkError()],
    ['a 500', respondWith.status(500)],
    ['a 404', respondWith.status(404)],
    ['invalid JSON', respondWith.invalidJson()],
    ['a body with no flags array', respondWith.body({})],
    ['a body whose flags is not an array', respondWith.body({ flags: 'nope' })],
  ])('resolves despite %s, and serves defaults', async (_label, responder) => {
    const fetch = createFakeFetch(responder);
    const client = createFlagClient({ ...BASE, fetch });

    await expect(client.init()).resolves.toBeUndefined();
    expect(client.snapshotSize()).toBe(0);
    expect(client.isEnabled('demo-flag', { userId: 'u1' })).toBe(false);
    expect(console.warn).toHaveBeenCalled();
    client.close();
  });

  it('resolves when the request times out rather than hanging', async () => {
    const fetch = createFakeFetch(respondWith.hang());
    const client = createFlagClient({ ...BASE, fetch, requestTimeoutMs: 50 });

    const started = Date.now();
    await expect(client.init()).resolves.toBeUndefined();

    expect(Date.now() - started).toBeLessThan(2000);
    client.close();
  });

  it('honours the configured default while no flags are loaded', async () => {
    const fetch = createFakeFetch(respondWith.networkError());
    const client = createFlagClient({ ...BASE, fetch, defaultValue: true });

    await client.init();

    expect(client.isEnabled('demo-flag', { userId: 'u1' })).toBe(true);
    client.close();
  });
});

describe('the request it makes', () => {
  it('GETs /api/sdk/flags with the API key and SDK version', async () => {
    const fetch = createFakeFetch(respondWith.flags([FLAG()]));
    const client = createFlagClient({ ...BASE, fetch });

    await client.init();
    client.close();

    expect(fetch.calls).toBe(1);
    const [request] = fetch.requests;
    expect(request?.url).toBe('http://flags.test/api/sdk/flags');
    expect(request?.headers['x-api-key']).toBe('sdk-key-123');
    expect(request?.headers['x-sdk-version']).toBeTruthy();
    expect(request?.headers.accept).toBe('application/json');
  });

  it('loads the flags it receives', async () => {
    const fetch = createFakeFetch(
      respondWith.flags([FLAG(), FLAG({ key: 'second-flag' })]),
    );
    const client = createFlagClient({ ...BASE, fetch });

    await client.init();

    expect(client.snapshotSize()).toBe(2);
    client.close();
  });

  it('skips malformed entries rather than rejecting the whole payload', async () => {
    const fetch = createFakeFetch(
      respondWith.body({ flags: [FLAG(), null, { noKey: true }, FLAG({ key: 'ok' })] }),
    );
    const client = createFlagClient({ ...BASE, fetch });

    await client.init();

    expect(client.snapshotSize()).toBe(2);
    client.close();
  });
});
