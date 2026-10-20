// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react';
import { StrictMode, useRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The BUILT package, by name: exactly what a consumer installs, "use client"
// banner and all. The same file runs against React 18 in an isolated consumer
// project (scripts/test-react-18.mjs).
import { FlagProvider, useFlag, useFlagClient, useFlags, useFlagStatus } from 'flagpilot/react';

/*
 * `fetch` is stubbed globally: the provider's client looks it up at call time,
 * exactly as it would in a page.
 */

interface PendingRequest {
  body: unknown;
  respond(flags: Record<string, unknown>, status?: number): void;
}

let pending: PendingRequest[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  pending = [];
  fetchMock = vi.fn(
    (_url: string, init: { body: string }) =>
      new Promise<Response>((resolve) => {
        pending.push({
          body: JSON.parse(init.body),
          respond: (flags, status = 200) =>
            resolve(new Response(JSON.stringify(status === 200 ? { flags } : { error: { code: 'x' } }), { status })),
        });
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const PROPS = { apiUrl: 'https://flags.example.com', clientKey: 'public-client-key-123' };

async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function answer(index: number, flags: Record<string, unknown>): Promise<void> {
  await act(async () => {
    pending[index]!.respond(flags);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

function Beta({ testId = 'beta' }: { testId?: string }) {
  return <span data-testid={testId}>{String(useFlag('beta'))}</span>;
}

describe('FlagProvider + useFlag', () => {
  it('renders the default first, then the value from the flag service', async () => {
    render(
      <FlagProvider {...PROPS}>
        <Beta />
      </FlagProvider>,
    );
    expect(screen.getByTestId('beta').textContent).toBe('false');
    await settle();
    await answer(0, { beta: true });
    expect(screen.getByTestId('beta').textContent).toBe('true');
  });

  it('starts from initialFlags, so the first paint is already right', () => {
    render(
      <FlagProvider {...PROPS} initialFlags={{ beta: true }}>
        <Beta />
      </FlagProvider>,
    );
    expect(screen.getByTestId('beta').textContent).toBe('true');
  });

  it('honours a per-call default and the provider default', async () => {
    function Both() {
      return (
        <>
          <span data-testid="call">{String(useFlag('missing', true))}</span>
          <span data-testid="provider">{String(useFlag('missing'))}</span>
        </>
      );
    }
    render(
      <FlagProvider {...PROPS} options={{ defaultValue: true }}>
        <Both />
      </FlagProvider>,
    );
    expect(screen.getByTestId('call').textContent).toBe('true');
    expect(screen.getByTestId('provider').textContent).toBe('true');
  });

  it('re-renders a component only when its own flag changes', async () => {
    let renders = 0;
    function Counted() {
      renders += 1;
      return <span>{String(useFlag('beta'))}</span>;
    }
    render(
      <FlagProvider {...PROPS} options={{ refreshIntervalMs: 15_000 }}>
        <Counted />
      </FlagProvider>,
    );
    await settle();
    await answer(0, { beta: true, other: false });
    const afterFirstLoad = renders;

    // A refresh that changes only a different flag.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    await answer(1, { beta: true, other: true });
    expect(renders).toBe(afterFirstLoad);
  });
});

describe('never breaks the page', () => {
  it('a hook outside any provider returns the default, without throwing', () => {
    function Orphan() {
      return <span data-testid="orphan">{String(useFlag('beta', true))}</span>;
    }
    expect(() => render(<Orphan />)).not.toThrow();
    expect(screen.getByTestId('orphan').textContent).toBe('true');
  });

  it('every hook outside a provider has a safe answer', () => {
    function Orphans() {
      const flags = useFlags();
      const status = useFlagStatus();
      const client = useFlagClient();
      return <span data-testid="o">{`${Object.keys(flags).length}|${status.state}|${client === null}`}</span>;
    }
    render(<Orphans />);
    expect(screen.getByTestId('o').textContent).toBe('0|idle|true');
  });

  it('a misconfigured provider still renders its children, with defaults', () => {
    render(
      <FlagProvider apiUrl="" clientKey="">
        <Beta />
      </FlagProvider>,
    );
    expect(screen.getByTestId('beta').textContent).toBe('false');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a flag service that is down renders defaults, not an error', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
    render(
      <FlagProvider {...PROPS}>
        <Beta />
      </FlagProvider>,
    );
    await settle();
    expect(screen.getByTestId('beta').textContent).toBe('false');
  });
});

describe('lifecycle', () => {
  it('Strict Mode (mount → unmount → mount) makes exactly one request', async () => {
    render(
      <StrictMode>
        <FlagProvider {...PROPS}>
          <Beta />
        </FlagProvider>
      </StrictMode>,
    );
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await answer(0, { beta: true });
    expect(screen.getByTestId('beta').textContent).toBe('true');
  });

  it('stops polling when unmounted', async () => {
    const { unmount } = render(
      <FlagProvider {...PROPS} options={{ refreshIntervalMs: 15_000 }}>
        <Beta />
      </FlagProvider>,
    );
    await settle();
    await answer(0, {});
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not refetch when given a new-but-equal context object every render', async () => {
    function Rerenderer() {
      const renders = useRef(0);
      renders.current += 1;
      return (
        <FlagProvider {...PROPS} options={{ refreshIntervalMs: 60_000 }} signedContext={undefined} context={{}}>
          <Beta />
        </FlagProvider>
      );
    }
    const { rerender } = render(<Rerenderer />);
    await settle();
    await answer(0, {});
    for (let i = 0; i < 5; i += 1) rerender(<Rerenderer />);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('calls identify() only when the identity really changes (attribute order does not count)', async () => {
    let client: ReturnType<typeof useFlagClient> = null;
    function Grab() {
      client = useFlagClient();
      return null;
    }
    const app = (attributes: Record<string, string>) => (
      <FlagProvider {...PROPS} context={{ userId: 'u1', attributes }}>
        <Grab />
      </FlagProvider>
    );
    const { rerender } = render(app({ plan: 'pro', country: 'IN' }));
    await settle();
    const identify = vi.spyOn(client!, 'identify');

    rerender(app({ country: 'IN', plan: 'pro' }));
    rerender(app({ plan: 'pro', country: 'IN' }));
    await settle();
    expect(identify).not.toHaveBeenCalled();

    rerender(app({ plan: 'free', country: 'IN' }));
    await settle();
    expect(identify).toHaveBeenCalledTimes(1);
    expect(identify).toHaveBeenCalledWith({ context: { userId: 'u1', attributes: { plan: 'free', country: 'IN' } } });
  });

  it('switching user calls the service for the new identity and drops the old values at once', async () => {
    const { rerender } = render(
      <FlagProvider {...PROPS} signedContext="v1.alice.sig">
        <Beta />
      </FlagProvider>,
    );
    await settle();
    expect(pending[0]!.body).toEqual({ signedContext: 'v1.alice.sig' });
    await answer(0, { beta: true });
    expect(screen.getByTestId('beta').textContent).toBe('true');

    rerender(
      <FlagProvider {...PROPS} signedContext="v1.bob.sig">
        <Beta />
      </FlagProvider>,
    );
    await settle();
    // Bob's request is in flight; nothing of Alice's is shown meanwhile.
    expect(screen.getByTestId('beta').textContent).toBe('false');
    expect(pending.at(-1)!.body).toEqual({ signedContext: 'v1.bob.sig' });
    await answer(pending.length - 1, { beta: false });
    expect(screen.getByTestId('beta').textContent).toBe('false');
  });

  it('useFlagStatus moves from loading to ready', async () => {
    function Status() {
      return <span data-testid="status">{useFlagStatus().state}</span>;
    }
    render(
      <FlagProvider {...PROPS}>
        <Status />
      </FlagProvider>,
    );
    await settle();
    expect(screen.getByTestId('status').textContent).toBe('loading');
    await answer(0, {});
    expect(screen.getByTestId('status').textContent).toBe('ready');
  });
});
