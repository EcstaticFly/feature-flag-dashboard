// @vitest-environment happy-dom
import { act } from '@testing-library/react';
import type { ReactElement } from 'react';
import { hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserClient } from 'flagpilot/browser';
import { FlagProvider, useFlag } from 'flagpilot/react';

/*
 * Hydration: the browser must first render exactly what the server sent, or
 * React reports a mismatch. A cached value from an earlier visit (persist) is
 * the classic way to get this wrong, so every test here plants a real cached
 * entry — written by the SDK itself — that disagrees with the server.
 */

const API_URL = 'https://flags.example.com';
const CLIENT_KEY = 'public-client-key-123';

function Page() {
  return <p>{String(useFlag('beta'))}</p>;
}

interface Pending {
  respond(flags: Record<string, boolean>): void;
}

let requests: Pending[];
let waiters: Array<() => void>;
let errors: ReturnType<typeof vi.spyOn>;
/** React 19 reports hydration mismatches here, not necessarily on console.error. */
let recoverable: unknown[];
let root: Root | undefined;

beforeEach(() => {
  requests = [];
  waiters = [];
  recoverable = [];
  errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.stubGlobal(
    'fetch',
    () =>
      new Promise<Response>((resolve) => {
        requests.push({
          respond: (flags) => resolve(new Response(JSON.stringify({ flags }), { status: 200 })),
        });
        waiters.splice(0).forEach((wake) => wake());
      }),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Resolves once `count` requests have been made (the first fetch is scheduled with setTimeout(0)). */
function requestCount(count: number): Promise<void> {
  return new Promise((resolve) => {
    const check = () => (requests.length >= count ? resolve() : waiters.push(check));
    check();
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** Has the SDK itself write `{ beta: true }` to the persisted cache, as a previous visit would. */
async function plantCachedValue(): Promise<void> {
  const previousVisit = createBrowserClient({ apiUrl: API_URL, clientKey: CLIENT_KEY, persist: true });
  await requestCount(1);
  requests[0]!.respond({ beta: true });
  await previousVisit.ready();
  expect(previousVisit.isEnabled('beta')).toBe(true);
  previousVisit.close();
  expect(localStorage.length).toBe(1);
  requests = [];
}

function serverRender(app: ReactElement): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = renderToString(app);
  document.body.appendChild(container);
  return container;
}

function hydrate(container: HTMLElement, app: ReactElement): Root {
  return hydrateRoot(container, app, { onRecoverableError: (error) => recoverable.push(error) });
}

function hydrationErrors(): string[] {
  return [
    ...recoverable.map(String),
    ...errors.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => /hydrat|did not match|server rendered|recoverable/i.test(message)),
  ];
}

describe('hydration', () => {
  it('with initialFlags: hydrates to the server value, ignoring the cache, then applies the live value', async () => {
    const app = (
      <FlagProvider apiUrl={API_URL} clientKey={CLIENT_KEY} initialFlags={{ beta: false }} options={{ persist: true }}>
        <Page />
      </FlagProvider>
    );
    // Rendered before the cache exists: a real server has no localStorage.
    const container = serverRender(app);
    expect(container.textContent).toBe('false');
    await plantCachedValue();

    await act(async () => {
      root = hydrate(container, app);
    });
    // initialFlags win over the cache, so the first client render matches the server's.
    expect(container.textContent).toBe('false');

    await requestCount(1);
    await act(async () => {
      requests[0]!.respond({ beta: true });
      await flush();
    });
    expect(container.textContent).toBe('true');
    expect(hydrationErrors()).toEqual([]);
  });

  it('without initialFlags: hydrates to the server default, then shows the cached value, with no mismatch', async () => {
    const app = (
      <FlagProvider apiUrl={API_URL} clientKey={CLIENT_KEY} options={{ persist: true }}>
        <Page />
      </FlagProvider>
    );
    // Rendered before the cache exists: a real server has no localStorage.
    const container = serverRender(app);
    expect(container.textContent).toBe('false');
    await plantCachedValue();

    await act(async () => {
      root = hydrate(container, app);
    });
    // React hydrates with the server snapshot, then re-renders with the cached
    // value straight away, before the network answers.
    expect(container.textContent).toBe('true');
    expect(hydrationErrors()).toEqual([]);
  });
});
