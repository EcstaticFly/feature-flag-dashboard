// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

/*
 * Server rendering: Next.js renders client components on the server too, so
 * the browser client gets imported and constructed where there is no window.
 * It must do nothing there — no request, no timer, no throw — and answer from
 * initialFlags or defaults.
 */

describe('without a window', () => {
  it('imports without touching any browser global', async () => {
    expect(typeof (globalThis as { window?: unknown }).window).toBe('undefined');
    await expect(import('../../src/browser/index.js')).resolves.toBeTruthy();
  });

  it('constructs, answers from initialFlags, and never fetches', async () => {
    const { createBrowserClient } = await import('../../src/browser/index.js');
    const fetch = vi.fn();
    const client = createBrowserClient({
      apiUrl: 'https://flags.example.com',
      clientKey: 'public-client-key-123',
      initialFlags: { beta: true },
      fetch,
    });
    client.start();
    await client.refresh();
    await client.ready();

    expect(client.isEnabled('beta')).toBe(true);
    expect(client.isEnabled('other')).toBe(false);
    expect(client.getStatus().state).toBe('idle');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('identify() still drops the previous identity\'s values, but never fetches', async () => {
    const { createBrowserClient } = await import('../../src/browser/index.js');
    const fetch = vi.fn();
    const client = createBrowserClient({
      apiUrl: 'https://flags.example.com',
      clientKey: 'public-client-key-123',
      initialFlags: { beta: true },
      fetch,
    });

    await client.identify({ signedContext: 'v1.someone-else.sig' });

    // The initial values belonged to the previous identity, so they go — the
    // same rule that keeps one user's flags from ever reaching another.
    expect(client.isEnabled('beta')).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
