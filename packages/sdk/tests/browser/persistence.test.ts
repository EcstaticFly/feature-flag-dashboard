// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserClient, type BrowserClientConfig } from '../../src/browser/index.js';
import { storageKeyFor } from '../../src/browser/persistence.js';
import { BASE, createScriptedFetch, flagsResponse, flush, silenceConsole, type ScriptedFetch } from './helpers.js';

/*
 * `persist: true` — the optional last-known-values cache. Every way storage can
 * fail has to leave the client working, from memory.
 */

let fetch: ScriptedFetch;
const make = (extra: Partial<BrowserClientConfig> = {}) =>
  createBrowserClient({ ...BASE, fetch, persist: true, ...extra });

beforeEach(() => {
  vi.useFakeTimers();
  fetch = createScriptedFetch();
  silenceConsole();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function loadOnce(extra: Partial<BrowserClientConfig>, flags: Record<string, boolean>) {
  const client = make(extra);
  await vi.advanceTimersByTimeAsync(0);
  fetch.requests.at(-1)!.respond(flagsResponse(flags));
  await flush();
  client.close();
}

describe('the cache', () => {
  it('serves the last-known values instantly on the next page load', async () => {
    await loadOnce({ signedContext: 'v1.alice.sig' }, { beta: true });
    const reload = make({ signedContext: 'v1.alice.sig', autoStart: false });
    expect(reload.isEnabled('beta')).toBe(true);
  });

  it('never shows one user\'s cached flags to another on the same browser', async () => {
    await loadOnce({ signedContext: 'v1.alice.sig' }, { 'alice-only': true });
    const bob = make({ signedContext: 'v1.bob.sig', autoStart: false });
    expect(bob.isEnabled('alice-only')).toBe(false);
    const anonymous = make({ autoStart: false });
    expect(anonymous.isEnabled('alice-only')).toBe(false);
  });

  it('is not written at all unless persist is on', async () => {
    const client = createBrowserClient({ ...BASE, fetch });
    await vi.advanceTimersByTimeAsync(0);
    fetch.requests[0]!.respond(flagsResponse({ beta: true }));
    await flush();
    client.close();
    expect(localStorage.length).toBe(0);
  });

  it('keeps one entry per client key, however many users sign in', async () => {
    await loadOnce({ signedContext: 'v1.alice.sig' }, { a: true });
    await loadOnce({ signedContext: 'v1.bob.sig' }, { b: true });
    await loadOnce({}, { c: true });
    expect(localStorage.length).toBe(1);
  });

  it('stores only booleans and hashes — no user id, token or key', async () => {
    await loadOnce({ signedContext: 'v1.alice-token.sig' }, { beta: true });
    const raw = localStorage.getItem(storageKeyFor(BASE.clientKey))!;
    expect(raw).not.toContain('alice');
    expect(raw).not.toContain(BASE.clientKey);
    expect(storageKeyFor(BASE.clientKey)).not.toContain(BASE.clientKey);
  });

  it('ignores an entry older than seven days', async () => {
    await loadOnce({}, { beta: true });
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
    expect(make({ autoStart: false }).isEnabled('beta')).toBe(false);
  });

  it('lets server-rendered initialFlags win over the cache, so hydration matches', async () => {
    await loadOnce({}, { beta: true });
    const client = make({ autoStart: false, initialFlags: { beta: false } });
    expect(client.isEnabled('beta')).toBe(false);
  });

  it('ignores a corrupt entry', () => {
    localStorage.setItem(storageKeyFor(BASE.clientKey), '{not json');
    expect(() => make({ autoStart: false })).not.toThrow();
    expect(make({ autoStart: false }).isEnabled('beta')).toBe(false);
  });

  it('ignores an entry with the wrong shape', () => {
    localStorage.setItem(storageKeyFor(BASE.clientKey), JSON.stringify({ v: 1, i: 'x', t: Date.now(), f: 'nope' }));
    expect(make({ autoStart: false }).isEnabled('beta')).toBe(false);
  });
});

describe('when storage is unavailable', () => {
  function blockStorage(): () => void {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        // What Chrome and Firefox throw when site data is blocked.
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    return () => {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
    };
  }

  it('works from memory when even reading `localStorage` throws', async () => {
    const restore = blockStorage();
    try {
      const client = make();
      await vi.advanceTimersByTimeAsync(0);
      fetch.requests[0]!.respond(flagsResponse({ beta: true }));
      await flush();
      expect(client.isEnabled('beta')).toBe(true);
      expect(client.getStatus().state).toBe('ready');
    } finally {
      restore();
    }
  });

  it('works from memory when every write hits the quota', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    const client = make();
    await vi.advanceTimersByTimeAsync(0);
    fetch.requests[0]!.respond(flagsResponse({ beta: true }));
    await flush();
    expect(client.isEnabled('beta')).toBe(true);
  });

  it('works from memory when reads throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => make({ autoStart: false })).not.toThrow();
  });
});
