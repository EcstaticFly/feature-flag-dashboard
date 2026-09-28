import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlagClient } from '../src/client.js';
import { createFakeFetch, FLAG, respondWith, until } from './helpers/fake-fetch.js';

const BASE = { apiUrl: 'http://flags.test', apiKey: 'sdk-key-123', refreshIntervalMs: 25 };
const USER = { userId: 'user_1' };

/** `user_1` is outside a 25% rollout and inside a 100% one — see the M2 golden tests. */
const AT_25 = FLAG({ rolloutPercentage: 25 });
const AT_100 = FLAG({ rolloutPercentage: 100 });

const warnings = () => vi.mocked(console.warn).mock.calls.map(([m]) => String(m));

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('background refresh', () => {
  it('picks up a change made on the server (FR-09)', async () => {
    const fetch = createFakeFetch(respondWith.flags([AT_25]));
    const client = createFlagClient({ ...BASE, fetch });
    await client.init();
    expect(client.isEnabled('demo-flag', USER)).toBe(false);

    fetch.setResponder(respondWith.flags([AT_100]));

    expect(await until(() => client.isEnabled('demo-flag', USER))).toBe(true);
    client.close();
  });

  it('picks up a newly created flag', async () => {
    const fetch = createFakeFetch(respondWith.flags([AT_25]));
    const client = createFlagClient({ ...BASE, fetch });
    await client.init();
    expect(client.snapshotSize()).toBe(1);

    fetch.setResponder(respondWith.flags([AT_25, FLAG({ key: 'brand-new' })]));

    expect(await until(() => client.snapshotSize() === 2)).toBe(true);
    client.close();
  });

  it('keeps polling on a timer', async () => {
    const fetch = createFakeFetch(respondWith.flags([AT_25]));
    const client = createFlagClient({ ...BASE, fetch });
    await client.init();

    expect(await until(() => fetch.calls >= 3)).toBe(true);
    client.close();
  });
});

describe('a failing refresh keeps the last good snapshot', () => {
  it.each([
    ['a 500', respondWith.status(500)],
    ['a 401 after init', respondWith.status(401)],
    ['a network error', respondWith.networkError()],
    ['invalid JSON', respondWith.invalidJson()],
    ['an empty body', respondWith.body({})],
    ['a non-array flags field', respondWith.body({ flags: 'nope' })],
  ])('survives %s', async (_label, responder) => {
    const fetch = createFakeFetch(respondWith.flags([AT_100]));
    const client = createFlagClient({ ...BASE, fetch });
    await client.init();
    expect(client.isEnabled('demo-flag', USER)).toBe(true);

    fetch.setResponder(responder);
    const callsBefore = fetch.calls;
    await until(() => fetch.calls > callsBefore + 2);

    // Still the value from before the outage — not the default, not a throw.
    expect(client.isEnabled('demo-flag', USER)).toBe(true);
    expect(client.snapshotSize()).toBe(1);
    client.close();
  });

  it('survives a hanging request via its own timeout', async () => {
    const fetch = createFakeFetch(respondWith.flags([AT_100]));
    const client = createFlagClient({ ...BASE, fetch, requestTimeoutMs: 30 });
    await client.init();

    fetch.setResponder(respondWith.hang());
    await until(() => fetch.calls >= 3);

    expect(client.isEnabled('demo-flag', USER)).toBe(true);
    client.close();
  });

  it('resumes updating once the service recovers', async () => {
    const fetch = createFakeFetch(respondWith.flags([AT_25]));
    const client = createFlagClient({ ...BASE, fetch });
    await client.init();

    fetch.setResponder(respondWith.networkError());
    await until(() => warnings().some((w) => w.includes('refresh failed')));
    expect(client.isEnabled('demo-flag', USER)).toBe(false);

    fetch.setResponder(respondWith.flags([AT_100]));

    expect(await until(() => client.isEnabled('demo-flag', USER))).toBe(true);
    client.close();
  });
});

describe('log volume', () => {
  it('warns once per failure streak, not once per attempt', async () => {
    const fetch = createFakeFetch(respondWith.flags([AT_25]));
    const client = createFlagClient({ ...BASE, fetch });
    await client.init();

    fetch.setResponder(respondWith.networkError());
    const callsBefore = fetch.calls;
    // Let several refreshes fail. A flag service down for an hour must not
    // produce thousands of identical lines.
    await until(() => fetch.calls > callsBefore + 5);

    expect(warnings().filter((w) => w.includes('refresh failed'))).toHaveLength(1);
    client.close();
  });

  it('logs a recovery, then warns again if it fails a second time', async () => {
    const fetch = createFakeFetch(respondWith.flags([AT_25]));
    const client = createFlagClient({ ...BASE, fetch });
    await client.init();

    fetch.setResponder(respondWith.networkError());
    await until(() => warnings().some((w) => w.includes('refresh failed')));

    fetch.setResponder(respondWith.flags([AT_25]));
    expect(await until(() => warnings().some((w) => w.includes('recovered')))).toBe(true);

    fetch.setResponder(respondWith.networkError());
    expect(
      await until(() => warnings().filter((w) => w.includes('refresh failed')).length === 2),
    ).toBe(true);
    client.close();
  });
});

describe('lifecycle', () => {
  it('close() stops further requests', async () => {
    const fetch = createFakeFetch(respondWith.flags([AT_25]));
    const client = createFlagClient({ ...BASE, fetch });
    await client.init();
    await until(() => fetch.calls >= 2);

    client.close();
    const afterClose = fetch.calls;
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(fetch.calls).toBe(afterClose);
  });

  it('close() is safe to call twice', async () => {
    const fetch = createFakeFetch(respondWith.flags([AT_25]));
    const client = createFlagClient({ ...BASE, fetch });
    await client.init();

    expect(() => {
      client.close();
      client.close();
    }).not.toThrow();
  });

  it('still answers from its snapshot after close()', async () => {
    const fetch = createFakeFetch(respondWith.flags([AT_100]));
    const client = createFlagClient({ ...BASE, fetch });
    await client.init();
    client.close();

    expect(client.isEnabled('demo-flag', USER)).toBe(true);
  });

  it('keeps two clients independent', async () => {
    const fetchA = createFakeFetch(respondWith.flags([AT_25]));
    const fetchB = createFakeFetch(respondWith.flags([AT_100]));
    const a = createFlagClient({ ...BASE, fetch: fetchA });
    const b = createFlagClient({ ...BASE, fetch: fetchB });
    await Promise.all([a.init(), b.init()]);

    expect(a.isEnabled('demo-flag', USER)).toBe(false);
    expect(b.isEnabled('demo-flag', USER)).toBe(true);
    a.close();
    b.close();
  });

  it('does not hold the process open — the refresh timer is unref’d', async () => {
    // A ref'd interval would keep Node alive for a full interval after the host
    // app finished its work. Capture the client's own timer and check it
    // directly; inspecting every handle in the process would also pick up
    // Vitest's.
    const realSetInterval = globalThis.setInterval;
    let handle: NodeJS.Timeout | undefined;
    const spy = vi
      .spyOn(globalThis, 'setInterval')
      .mockImplementation(((fn: () => void, ms: number) => {
        handle = realSetInterval(fn, ms);
        return handle;
      }) as unknown as typeof globalThis.setInterval);

    const fetch = createFakeFetch(respondWith.flags([AT_25]));
    const client = createFlagClient({ ...BASE, fetch, refreshIntervalMs: 60_000 });
    await client.init();
    spy.mockRestore();

    expect(handle).toBeDefined();
    expect(handle?.hasRef()).toBe(false);
    client.close();
  });
});
