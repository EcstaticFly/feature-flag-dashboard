// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserClient, type BrowserClientConfig } from '../../src/browser/index.js';
import {
  BASE,
  createScriptedFetch,
  flagsResponse,
  flush,
  json,
  setOnline,
  setVisibility,
  silenceConsole,
  type ScriptedFetch,
} from './helpers.js';

let fetch: ScriptedFetch;
let consoleSpies: ReturnType<typeof silenceConsole>;

beforeEach(() => {
  vi.useFakeTimers();
  fetch = createScriptedFetch();
  consoleSpies = silenceConsole();
  setVisibility('visible');
  setOnline(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const make = (extra: Partial<BrowserClientConfig> = {}) => createBrowserClient({ ...BASE, fetch, ...extra });

/** Starts the client and lets its first (0ms) tick issue the request. */
async function started(extra: Partial<BrowserClientConfig> = {}) {
  const client = make(extra);
  await vi.advanceTimersByTimeAsync(0);
  return client;
}

describe('construction never throws, whatever it is given', () => {
  it.each([
    ['no apiUrl', { apiUrl: '' }],
    ['a malformed apiUrl', { apiUrl: 'not a url' }],
    ['plain http to a remote host', { apiUrl: 'http://flags.example.com' }],
    ['a protocol-relative URL', { apiUrl: '//evil.example' }],
    ['credentials in the URL', { apiUrl: 'https://user:pass@flags.example.com' }],
    ['a query string', { apiUrl: 'https://flags.example.com/?x=1' }],
    ['a non-web scheme', { apiUrl: 'ftp://flags.example.com' }],
    ['no clientKey', { clientKey: '' }],
    ['a clientKey with spaces', { clientKey: 'has spaces in it' }],
    ['an oversized clientKey', { clientKey: 'k'.repeat(257) }],
  ])('%s → misconfigured: defaults forever, no request, one error', async (_label, extra) => {
    const client = make(extra as Partial<BrowserClientConfig>);
    await vi.advanceTimersByTimeAsync(120_000);

    expect(client.getStatus().state).toBe('misconfigured');
    expect(client.isEnabled('anything')).toBe(false);
    expect(client.isEnabled('anything', true)).toBe(true);
    expect(fetch.requests).toHaveLength(0);
    expect(consoleSpies.error).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, 'https://flags.example.com', 42])('survives %o instead of a config', (config) => {
    expect(() => createBrowserClient(config as never)).not.toThrow();
    expect(createBrowserClient(config as never).getStatus().state).toBe('misconfigured');
  });

  it('survives a config whose getters throw', () => {
    const hostile = {
      get apiUrl(): string {
        throw new Error('boom');
      },
    } as never;
    expect(() => createBrowserClient(hostile)).not.toThrow();
  });

  it('keeps initialFlags even when misconfigured, so server-rendered values still show', () => {
    const client = make({ clientKey: '', initialFlags: { beta: true } });
    expect(client.isEnabled('beta')).toBe(true);
  });

  it('accepts http only for localhost', () => {
    for (const apiUrl of ['http://localhost:4000', 'http://127.0.0.1:4000', 'http://[::1]:4000']) {
      expect(make({ apiUrl }).getStatus().state).toBe('idle');
    }
  });
});

describe('the request it makes', () => {
  it('POSTs to the browser endpoint with the public key, and nothing a browser could leak', async () => {
    await started();
    const [request] = fetch.requests;
    expect(request!.url).toBe('https://flags.example.com/api/client/flags');
    expect(request!.init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    expect(request!.headers).toEqual({
      'content-type': 'application/json',
      'x-flagpilot-client-key': 'public-client-key-123',
    });
    expect(request!.body).toEqual({});
  });

  it('sends a signed context exactly as given, unread', async () => {
    await started({ signedContext: 'v1.abc.def' });
    expect(fetch.requests[0]!.body).toEqual({ signedContext: 'v1.abc.def' });
  });

  it('prefers the signed context when both are given', async () => {
    await started({ signedContext: 'v1.abc.def', context: { userId: 'alice' } });
    expect(fetch.requests[0]!.body).toEqual({ signedContext: 'v1.abc.def' });
  });

  it('sends a validated copy of a plain context', async () => {
    await started({ context: { userId: 'alice', attributes: { plan: 'pro' } } });
    expect(fetch.requests[0]!.body).toEqual({ context: { userId: 'alice', attributes: { plan: 'pro' } } });
  });

  it('appends the endpoint to a same-origin proxy path', async () => {
    await started({ apiUrl: '/flagpilot/' });
    expect(fetch.requests[0]!.url).toBe('/flagpilot/api/client/flags');
  });

  it('keeps a path prefix on an absolute URL', async () => {
    await started({ apiUrl: 'https://example.com/flags/' });
    expect(fetch.requests[0]!.url).toBe('https://example.com/flags/api/client/flags');
  });

  it('calls fetch with the global object as `this` — avoiding Chrome\'s "Illegal invocation"', async () => {
    let receiver: unknown;
    const strictFetch = function (this: unknown) {
      receiver = this;
      return Promise.resolve(flagsResponse({}));
    };
    await started({ fetch: strictFetch as never });
    expect(receiver).toBe(globalThis);
  });

  it('refuses to send an invalid context, rather than silently going anonymous', async () => {
    const client = await started({ context: { userId: 'u1', attributes: { nested: {} } } as never });
    expect(fetch.requests).toHaveLength(0);
    expect(client.getStatus()).toMatchObject({ state: 'error', lastError: expect.stringContaining('invalid context') });
  });
});

describe('what it accepts from a response', () => {
  it('keeps only booleans under well-formed flag keys', async () => {
    const client = await started();
    fetch.requests[0]!.respond(
      json({
        flags: {
          good: true,
          off: false,
          'Bad-Case': true,
          has_underscore: true,
          stringy: 'true',
          numeric: 1,
          ['k'.repeat(65)]: true,
        },
      }),
    );
    await flush();
    expect({ ...client.getAll() }).toEqual({ good: true, off: false });
  });

  it('never lets __proto__ in a response affect anything', async () => {
    const client = await started();
    fetch.requests[0]!.respond(new Response('{"flags":{"__proto__":{"evil":true},"good":true}}', { status: 200 }));
    await flush();
    expect({ ...client.getAll() }).toEqual({ good: true });
    expect(client.isEnabled('evil')).toBe(false);
  });

  it('keeps last-known values when a response is malformed', async () => {
    const client = await started();
    fetch.requests[0]!.respond(flagsResponse({ beta: true }));
    await flush();

    void client.refresh();
    await flush();
    fetch.requests[1]!.respond(new Response('<html>oops</html>', { status: 200 }));
    await flush();
    expect(client.isEnabled('beta')).toBe(true);
    expect(client.getStatus().state).toBe('error');
  });

  it('refuses an oversized response by its declared length, before reading it', async () => {
    const client = await started();
    fetch.requests[0]!.respond(
      new Response('{"flags":{}}', { status: 200, headers: { 'content-length': String(300 * 1024) } }),
    );
    await flush();
    expect(client.getStatus().lastError).toBe('response too large');
  });
});

describe('failures degrade, never break', () => {
  it('serves defaults while the service is unreachable, and backs off', async () => {
    const client = await started();
    fetch.requests[0]!.fail();
    await flush();
    expect(client.isEnabled('beta')).toBe(false);
    expect(client.getStatus().state).toBe('error');

    // Backoff: roughly 1s, then 2s (with ±20% jitter).
    await vi.advanceTimersByTimeAsync(1300);
    expect(fetch.requests).toHaveLength(2);
    fetch.requests[1]!.fail();
    await flush();
    await vi.advanceTimersByTimeAsync(1500);
    expect(fetch.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetch.requests).toHaveLength(3);
  });

  it('logs one warning per failure streak, then a recovery', async () => {
    // Requests that fail immediately, so the streak is exactly what the timer
    // schedule produces — no request left pending across an advance.
    let reachable = false;
    let calls = 0;
    const failingThenOk = () => {
      calls += 1;
      return reachable ? Promise.resolve(flagsResponse({ beta: true })) : Promise.reject(new TypeError('Failed to fetch'));
    };
    const client = await started({ fetch: failingThenOk as never });

    // Two minutes down: several attempts on a growing backoff, one warning.
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(calls).toBeGreaterThan(4);
    const failureWarnings = consoleSpies.warn.mock.calls.filter((c) => String(c[0]).includes('could not load flags'));
    expect(failureWarnings).toHaveLength(1);

    reachable = true;
    // The backoff is capped at the refresh interval (60s) and then jittered by
    // up to +20%, so the next attempt can be as far as 72s away.
    await vi.advanceTimersByTimeAsync(73_000);
    expect(client.getStatus().state).toBe('ready');
    expect(client.isEnabled('beta')).toBe(true);
    expect(consoleSpies.warn.mock.calls.some((c) => String(c[0]).includes('reachable again'))).toBe(true);
  });

  it('turns a hung request into a timeout, then retries', async () => {
    const client = await started({ requestTimeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.getStatus().lastError).toBe('timed out after 2000ms');
    expect(fetch.requests[0]!.aborted()).toBe(false); // still pending: the deadline, not abort, ended it
  });

  it.each([
    [401, 'invalid_client_key', /public CLIENT_API_KEY/],
    [403, 'signed_context_required', /signed by your server/],
    [403, 'invalid_signed_context', /signContext\(\)/],
    [404, 'not_found', /no browser endpoint/],
  ])('explains a %i %s once, and waits 5 minutes before retrying', async (status, code, message) => {
    const client = await started();
    fetch.requests[0]!.respond(json({ error: { code, message: 'x' } }, status));
    await flush();
    expect(client.getStatus().state).toBe('error');
    expect(consoleSpies.error).toHaveBeenCalledWith(expect.stringMatching(message));

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(fetch.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch.requests).toHaveLength(2);
  });

  it('treats 503 as transient: last-known values kept, normal backoff', async () => {
    const client = await started();
    fetch.requests[0]!.respond(flagsResponse({ beta: true }));
    await flush();
    await vi.advanceTimersByTimeAsync(60_000);
    fetch.requests[1]!.respond(json({ error: { code: 'flags_unavailable' } }, 503));
    await flush();
    expect(client.isEnabled('beta')).toBe(true);
    await vi.advanceTimersByTimeAsync(1300);
    expect(fetch.requests).toHaveLength(3);
  });
});

describe('identity changes', () => {
  it('discards a slow answer for the previous user — A\'s flags never land on B', async () => {
    const client = await started({ signedContext: 'v1.alice.sig' });
    const aliceRequest = fetch.requests[0]!;

    const identifyDone = client.identify({ signedContext: 'v1.bob.sig' });
    await flush();
    const bobRequest = fetch.requests[1]!;
    expect(aliceRequest.aborted()).toBe(true);

    // Alice's answer arrives late, after Bob's request has started.
    aliceRequest.respond(flagsResponse({ 'alice-only': true }));
    bobRequest.respond(flagsResponse({ 'bob-only': true }));
    await identifyDone;
    await flush();

    expect({ ...client.getAll() }).toEqual({ 'bob-only': true });
  });

  /*
   * Aborting is not enough on its own: without an AbortController, with a
   * fetch that ignores the signal, or when a response has already landed but
   * not been processed, the old answer still arrives. Only the currency check
   * stops it. These use a fetch that ignores aborts entirely.
   */
  describe('when aborting cannot stop the old response', () => {
    function abortIgnoringFetch() {
      const pending: Array<(r: Response) => void> = [];
      const fn = () => new Promise<Response>((resolve) => pending.push(resolve));
      return { fn, pending };
    }

    it('a late answer for the previous user is discarded', async () => {
      const { fn, pending } = abortIgnoringFetch();
      const client = await started({ fetch: fn as never, signedContext: 'v1.alice.sig' });
      void client.identify({ signedContext: 'v1.bob.sig' });
      await flush();
      expect(pending).toHaveLength(2);

      pending[1]!(flagsResponse({ 'bob-only': true }));
      await flush();
      pending[0]!(flagsResponse({ 'alice-only': true })); // Alice's, arriving last
      await flush();

      expect({ ...client.getAll() }).toEqual({ 'bob-only': true });
    });

    it('an early answer for the previous user cannot clear the new request', async () => {
      const { fn, pending } = abortIgnoringFetch();
      const client = await started({ fetch: fn as never, signedContext: 'v1.alice.sig' });
      void client.identify({ signedContext: 'v1.bob.sig' });
      await flush();

      pending[0]!(flagsResponse({ 'alice-only': true })); // Alice's lands first
      await flush();
      expect(client.isEnabled('alice-only')).toBe(false);

      pending[1]!(flagsResponse({ 'bob-only': true }));
      await flush();
      expect({ ...client.getAll() }).toEqual({ 'bob-only': true });
      expect(client.getStatus().state).toBe('ready');
    });
  });

  it('drops the previous user\'s values immediately, before the new ones arrive', async () => {
    const client = await started({ signedContext: 'v1.alice.sig' });
    fetch.requests[0]!.respond(flagsResponse({ 'alice-only': true }));
    await flush();
    expect(client.isEnabled('alice-only')).toBe(true);

    void client.identify({});
    await flush();
    // Signed out: nothing of Alice's is visible while the anonymous request is in flight.
    expect(client.isEnabled('alice-only')).toBe(false);
  });

  it('does not refetch when identify() is called with the same identity', async () => {
    const client = await started({ signedContext: 'v1.alice.sig' });
    fetch.requests[0]!.respond(flagsResponse({}));
    await flush();
    await client.identify({ signedContext: 'v1.alice.sig' });
    expect(fetch.requests).toHaveLength(1);
  });

  it('identify() with an invalid context serves defaults rather than guessing', async () => {
    const client = await started();
    fetch.requests[0]!.respond(flagsResponse({ beta: true }));
    await flush();
    await client.identify({ context: { userId: 42 } as never });
    expect(client.isEnabled('beta')).toBe(false);
    expect(client.getStatus().state).toBe('error');
  });
});

describe('page lifecycle', () => {
  it('stops polling while hidden, and refreshes when shown again if stale', async () => {
    const client = await started();
    fetch.requests[0]!.respond(flagsResponse({}));
    await flush();

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fetch.requests).toHaveLength(1);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch.requests).toHaveLength(2);
    client.close();
  });

  it('still makes the first request in a tab opened in the background', async () => {
    setVisibility('hidden');
    await started();
    expect(fetch.requests).toHaveLength(1);
  });

  it('waits while offline, then refreshes as soon as the browser is back online', async () => {
    setOnline(false);
    await started();
    expect(fetch.requests).toHaveLength(0);
    setOnline(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch.requests).toHaveLength(1);
  });

  it('rechecks on its own if the browser claims to be offline but never fires `online`', async () => {
    setOnline(false);
    await started();
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetch.requests).toHaveLength(1);
  });

  it('refreshes a page restored from the back/forward cache when its values are stale', async () => {
    await started();
    fetch.requests[0]!.respond(flagsResponse({}));
    await flush();
    vi.setSystemTime(Date.now() + 2 * 60_000);
    const pageshow = Object.assign(new Event('pageshow'), { persisted: true });
    window.dispatchEvent(pageshow);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch.requests.length).toBeGreaterThanOrEqual(2);
  });

  it('registers no unload or beforeunload listener, which would disable the back/forward cache', async () => {
    const add = vi.spyOn(window, 'addEventListener');
    await started();
    const types = add.mock.calls.map((c) => c[0]);
    expect(types).not.toContain('unload');
    expect(types).not.toContain('beforeunload');
  });
});

describe('isolation from the host page', () => {
  it('a subscriber that throws does not stop the others', async () => {
    const client = await started();
    const after = vi.fn();
    client.subscribe(() => {
      throw new Error('host bug');
    });
    client.subscribe(after);
    fetch.requests[0]!.respond(flagsResponse({ beta: true }));
    await flush();
    expect(after).toHaveBeenCalled();
    expect(client.isEnabled('beta')).toBe(true);
  });

  it('a polluted Object.prototype cannot make an unknown flag read as on', async () => {
    const client = await started();
    fetch.requests[0]!.respond(flagsResponse({}));
    await flush();
    (Object.prototype as Record<string, unknown>).polluted = true;
    try {
      expect(client.isEnabled('polluted')).toBe(false);
    } finally {
      delete (Object.prototype as Record<string, unknown>).polluted;
    }
  });

  it('getAll() returns the same frozen object until something changes', async () => {
    const client = await started({ refreshIntervalMs: 15_000 });
    fetch.requests[0]!.respond(flagsResponse({ beta: true }));
    await flush();
    const first = client.getAll();
    expect(Object.isFrozen(first)).toBe(true);

    await vi.advanceTimersByTimeAsync(15_000);
    fetch.requests[1]!.respond(flagsResponse({ beta: true }));
    await flush();
    expect(client.getAll()).toBe(first);

    await vi.advanceTimersByTimeAsync(15_000);
    fetch.requests[2]!.respond(flagsResponse({ beta: false }));
    await flush();
    expect(client.getAll()).not.toBe(first);
  });

  it('unsubscribe is idempotent', async () => {
    const client = await started();
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);
    unsubscribe();
    unsubscribe();
    fetch.requests[0]!.respond(flagsResponse({ beta: true }));
    await flush();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('lifecycle controls', () => {
  it('start → stop → start (React Strict Mode) results in exactly one request', async () => {
    const client = make({ autoStart: false });
    client.start();
    client.stop();
    client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch.requests).toHaveLength(1);
  });

  it('close() stops everything but keeps the values readable', async () => {
    const client = await started();
    fetch.requests[0]!.respond(flagsResponse({ beta: true }));
    await flush();
    client.close();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(fetch.requests).toHaveLength(1);
    expect(client.isEnabled('beta')).toBe(true);
    expect(client.getStatus().state).toBe('closed');
    await expect(client.refresh()).resolves.toBeUndefined();
    await expect(client.identify({ signedContext: 'v1.x.y' })).resolves.toBeUndefined();
  });

  it('refreshIntervalMs: 0 fetches until the first success, then never polls', async () => {
    await started({ refreshIntervalMs: 0 });
    fetch.requests[0]!.fail();
    await flush();
    await vi.advanceTimersByTimeAsync(1300);
    fetch.requests[1]!.respond(flagsResponse({}));
    await flush();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fetch.requests).toHaveLength(2);
  });

  it('clamps an aggressive refresh interval to 15 seconds', async () => {
    await started({ refreshIntervalMs: 100 });
    fetch.requests[0]!.respond(flagsResponse({}));
    await flush();
    await vi.advanceTimersByTimeAsync(14_000);
    expect(fetch.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetch.requests).toHaveLength(2);
  });

  it('ready() resolves after the first fetch settles — success or not — and never rejects', async () => {
    const client = await started();
    const ready = client.ready(10_000);
    fetch.requests[0]!.fail();
    await flush();
    await expect(ready).resolves.toBeUndefined();
  });

  it('ready() resolves on its timeout if the service never answers', async () => {
    const client = make({ requestTimeoutMs: 30_000 });
    const ready = client.ready(500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(ready).resolves.toBeUndefined();
  });

  it('warns about an unknown flag only after a load, and once', async () => {
    const client = await started();
    client.isEnabled('missing');
    expect(consoleSpies.warn).not.toHaveBeenCalledWith(expect.stringContaining("unknown flag 'missing'"));
    fetch.requests[0]!.respond(flagsResponse({}));
    await flush();
    client.isEnabled('missing');
    client.isEnabled('missing');
    const warnings = consoleSpies.warn.mock.calls.filter((c) => String(c[0]).includes("unknown flag 'missing'"));
    expect(warnings).toHaveLength(1);
  });

  it('logLevel: silent logs nothing at all', async () => {
    make({ clientKey: '', logLevel: 'silent' });
    expect(consoleSpies.error).not.toHaveBeenCalled();
    expect(consoleSpies.warn).not.toHaveBeenCalled();
  });
});
