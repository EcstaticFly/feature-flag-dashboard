import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlagClient, type FlagClientConfig } from '../src/client.js';
import { createFakeFetch, FLAG, respondWith } from './helpers/fake-fetch.js';

const BASE = { apiUrl: 'http://flags.test', apiKey: 'sdk-key-123' };

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/*
 * Since 0.2.0 a bad config is not an exception. A thrown error at startup
 * would let a typo — or a rotation on the flag service's side — crash the host
 * app. Instead it is reported loudly and the client serves defaults, without
 * ever making a request.
 */
describe('config validation — loud, but never thrown', () => {
  it.each([
    ['missing apiUrl', { ...BASE, apiUrl: '' }],
    ['whitespace apiUrl', { ...BASE, apiUrl: '   ' }],
    ['missing apiKey', { ...BASE, apiKey: '' }],
    ['whitespace apiKey', { ...BASE, apiKey: '  ' }],
    ['zero refreshIntervalMs', { ...BASE, refreshIntervalMs: 0 }],
    ['negative refreshIntervalMs', { ...BASE, refreshIntervalMs: -1 }],
    ['zero requestTimeoutMs', { ...BASE, requestTimeoutMs: 0 }],
  ])('returns a misconfigured client for %s', async (_label, config) => {
    const fetch = createFakeFetch(respondWith.flags([FLAG({ rolloutPercentage: 100 })]));

    const client = createFlagClient({ ...config, fetch });
    const result = await client.init();

    expect(result.ok).toBe(false);
    expect(result.status.state).toBe('misconfigured');
    expect(result.status.lastError).toBeTruthy();
    expect(client.isEnabled('demo-flag', { userId: 'u1' })).toBe(false);
    expect(client.isEnabled('demo-flag', { userId: 'u1' }, true)).toBe(true);
    expect(fetch.calls).toBe(0);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'http://flags.test'],
  ])('survives being handed %s instead of a config', async (_label, config) => {
    expect(() => createFlagClient(config as unknown as FlagClientConfig)).not.toThrow();
    const client = createFlagClient(config as unknown as FlagClientConfig);
    await expect(client.init()).resolves.toMatchObject({ ok: false });
  });

  it('survives a config whose properties throw when read', async () => {
    const hostile = {
      get apiUrl(): string {
        throw new Error('boom');
      },
    } as unknown as FlagClientConfig;
    expect(() => createFlagClient(hostile)).not.toThrow();
    expect(createFlagClient(hostile).status().state).toBe('misconfigured');
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
  // The case that motivated the contract change: the flag service's operator
  // rotates the SDK key, and every host app restarts. None of them may crash.
  it.each([401, 403])('resolves, reports unauthorized and serves defaults on %i', async (status) => {
    const fetch = createFakeFetch(respondWith.status(status));
    const client = createFlagClient({ ...BASE, fetch });

    const result = await client.init();

    expect(result).toMatchObject({ ok: false, status: { state: 'unauthorized', hasValues: false } });
    expect(client.isEnabled('demo-flag', { userId: 'u1' })).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/rejected the SDK key/));
    client.close();
  });

  it('retries a rejected key every five minutes rather than on every tick, and recovers', async () => {
    vi.useFakeTimers();
    try {
      const fetch = createFakeFetch(respondWith.status(401));
      const client = createFlagClient({ ...BASE, fetch, refreshIntervalMs: 30_000 });
      await client.init();
      expect(fetch.calls).toBe(1);

      // Four and a half minutes of ticks: no further attempts.
      await vi.advanceTimersByTimeAsync(270_000);
      expect(fetch.calls).toBe(1);

      // The key is fixed on the flag service; the retry at five minutes picks it up.
      fetch.setResponder(respondWith.flags([FLAG({ rolloutPercentage: 100 })]));
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetch.calls).toBe(2);
      expect(client.status().state).toBe('ready');
      expect(client.isEnabled('demo-flag', { userId: 'u1' })).toBe(true);

      // Recovered, so the normal 30-second cadence resumes.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetch.calls).toBe(3);
      client.close();
    } finally {
      vi.useRealTimers();
    }
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

    await expect(client.init()).resolves.toMatchObject({ ok: false, status: { state: 'degraded' } });
    expect(client.snapshotSize()).toBe(0);
    expect(client.isEnabled('demo-flag', { userId: 'u1' })).toBe(false);
    expect(console.warn).toHaveBeenCalled();
    client.close();
  });

  it('resolves when the request times out rather than hanging', async () => {
    const fetch = createFakeFetch(respondWith.hang());
    const client = createFlagClient({ ...BASE, fetch, requestTimeoutMs: 50 });

    const started = Date.now();
    await expect(client.init()).resolves.toMatchObject({ ok: false });

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
