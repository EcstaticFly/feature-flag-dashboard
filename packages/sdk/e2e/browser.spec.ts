import { computeBucket } from '@feature-flags/core';
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

/*
 * flagpilot/browser, in real Chromium, Firefox and WebKit, against the real
 * API with real CORS.
 *
 * Every scenario asserts the same invariant as well as its own result: the
 * host page saw no uncaught error and no unhandled rejection, and kept
 * running. A feature-flag SDK may serve defaults; it may never break the page.
 */

const API = 'http://localhost:4000';
const ON = 'e2e-browser-on';
const ROLLOUT = 'e2e-browser-rollout';
const SERVER_ONLY = 'e2e-server-only';

/** Users whose buckets for ROLLOUT land on either side of 10% — computed, not assumed. */
const userIn = Array.from({ length: 500 }, (_, i) => `user_${i}`).find((u) => computeBucket(u, ROLLOUT) < 10)!;
const userOut = Array.from({ length: 500 }, (_, i) => `user_${i}`).find((u) => computeBucket(u, ROLLOUT) >= 10)!;

async function adminHeaders(api: APIRequestContext): Promise<Record<string, string>> {
  const login = await api.post(`${API}/api/auth/login`, {
    data: { email: 'admin@example.com', password: 'change-me-please' },
  });
  expect(login.ok(), 'admin login failed — is `npm run compose:up` running?').toBe(true);
  return { Authorization: `Bearer ${(await login.json()).token}` };
}

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext();
  const headers = await adminHeaders(api);

  for (const key of [ON, ROLLOUT, SERVER_ONLY]) await api.delete(`${API}/api/flags/${key}`, { headers });
  const create = async (data: Record<string, unknown>) =>
    expect((await api.post(`${API}/api/flags`, { headers, data })).status()).toBe(201);
  await create({ key: ON, name: 'On', enabled: true, rolloutPercentage: 100, clientSide: true });
  await create({ key: ROLLOUT, name: 'Rollout', enabled: true, rolloutPercentage: 10, clientSide: true });
  await create({ key: SERVER_ONLY, name: 'Hidden', enabled: true, rolloutPercentage: 100 });
  await api.dispose();
});

// Leave the database as it was found. Safe per project: workers is 1, so the
// browsers run one after another and each beforeAll recreates the flags.
test.afterAll(async ({ playwright }) => {
  const api = await playwright.request.newContext();
  const headers = await adminHeaders(api);
  for (const key of [ON, ROLLOUT, SERVER_ONLY]) await api.delete(`${API}/api/flags/${key}`, { headers });
  await api.dispose();
});

interface Outcome {
  flags: Record<string, boolean>;
  status: { state: string; lastError: string | null };
  errors: string[];
}

/** Opens the host page with a scenario and returns what the SDK did. */
async function run(
  page: Page,
  query: Record<string, string> = {},
  path = '/',
): Promise<Outcome> {
  const errors: string[] = [];
  page.on('pageerror', (err) => {
    if (!isBrowserNetworkDiagnostic(err)) errors.push(`pageerror: ${err.message}`);
  });
  await page.goto(`${path}?${new URLSearchParams(query)}`);
  await page.waitForFunction(() => (window as { __done?: boolean }).__done === true, null, { timeout: 30_000 });
  const result = await page.evaluate(() => {
    const w = window as unknown as { __results: Omit<Outcome, 'errors'>; __errors: string[] };
    return { ...w.__results, errors: w.__errors };
  });
  await expect(page.locator('#host')).toHaveText('host page finished');
  return { ...result, errors: [...errors, ...result.errors] };
}

const config = (value: Record<string, unknown>) => ({ config: JSON.stringify(value) });

/**
 * WebKit reports a CORS-blocked fetch as "Fetch API cannot load <url> due to
 * access control checks." with an EMPTY stack, and Playwright surfaces that as
 * a `pageerror`. It is the browser's network diagnostic — Chromium logs the
 * same block as a console error — not an exception: probing showed the page's
 * own `error` and `unhandledrejection` listeners (what a host app, or an error
 * tracker, can observe) receive nothing, and the SDK reports the failure in its
 * status. The page-level listeners stay the source of truth; this filter only
 * stops the diagnostic being counted as a thrown error.
 */
function isBrowserNetworkDiagnostic(err: Error): boolean {
  // Playwright's WebKit splits this text at the colon in "http:", so the
  // prefix lands in `name` and the rest in `message`: match the whole thing.
  const text = `${err.name}: ${err.message}`;
  return /Fetch API cannot load .* due to access control checks\.$/.test(text) && !err.stack?.trim();
}

test.describe('what a page receives', () => {
  test('anonymous: exposed flags only, as booleans', async ({ page }) => {
    const outcome = await run(page);
    expect(outcome.errors).toEqual([]);
    expect(outcome.status.state).toBe('ready');
    expect(outcome.flags[ON]).toBe(true);
    expect(outcome.flags[ROLLOUT]).toBe(true); // anonymous sees the plain on/off state
    expect(outcome.flags).not.toHaveProperty(SERVER_ONLY);
  });

  test('a signed user gets their own rollout answer', async ({ page, context }) => {
    const inside = await run(page, { signAs: userIn });
    expect(inside.errors).toEqual([]);
    expect(inside.flags[ROLLOUT]).toBe(true);

    const second = await context.newPage();
    const outside = await run(second, { signAs: userOut });
    expect(outside.errors).toEqual([]);
    expect(outside.flags[ROLLOUT]).toBe(false);
  });

  test('a page cannot name its own user: the request is refused and defaults are served', async ({ page }) => {
    const outcome = await run(page, config({ context: { userId: userIn } }));
    expect(outcome.errors).toEqual([]);
    expect(outcome.status.state).toBe('error');
    expect(outcome.flags).toEqual({});
  });
});

test.describe('failures never reach the host page', () => {
  test('an origin that is not allowed gets defaults', async ({ page }) => {
    const outcome = await run(page, {}, 'http://localhost:5175/');
    expect(outcome.errors).toEqual([]);
    expect(outcome.status.state).toBe('error');
    expect(outcome.flags).toEqual({});
  });

  test('a flag service that is down means defaults', async ({ page }) => {
    await page.route(`${API}/**`, (route) => route.abort('connectionrefused'));
    const outcome = await run(page, { wait: '3000' });
    expect(outcome.errors).toEqual([]);
    expect(outcome.flags).toEqual({});
  });

  test('offline, then back online: defaults first, real values after', async ({ page, context }) => {
    await page.route(`${API}/**`, (route) => route.abort('internetdisconnected'));
    const outcome = await run(page, { wait: '2000' });
    expect(outcome.flags).toEqual({});

    await page.unroute(`${API}/**`);
    await context.setOffline(true);
    await context.setOffline(false); // fires `online`, which triggers a refresh
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __client: { getAll(): Record<string, boolean> } }).__client.getAll()['e2e-browser-on']), { timeout: 15_000 })
      .toBe(true);
    expect(outcome.errors).toEqual([]);
  });

  test('a strict CSP that blocks the flag service means defaults', async ({ page }) => {
    const outcome = await run(page, { wait: '3000' }, '/csp');
    expect(outcome.errors).toEqual([]);
    expect(outcome.flags).toEqual({});
  });

  test('a sandboxed iframe (origin "null") gets defaults', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => {
      if (!isBrowserNetworkDiagnostic(err)) errors.push(err.message);
    });
    await page.goto(`/sandboxed?${new URLSearchParams({ wait: '3000' })}`);
    const frame = page.frameLocator('#frame');
    await expect(frame.locator('#host')).toHaveText('host page finished', { timeout: 30_000 });
    const inFrame = await page.frames()[1]!.evaluate(() => {
      const w = window as unknown as { __results: { flags: Record<string, boolean> }; __errors: string[] };
      return { flags: w.__results.flags, errors: w.__errors };
    });
    expect(inFrame.flags).toEqual({});
    expect(inFrame.errors).toEqual([]);
    expect(errors).toEqual([]);
  });
});

test.describe('storage modes', () => {
  test('blocked storage (a SecurityError on access): works from memory', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get() {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      });
    });
    const outcome = await run(page, config({ persist: true }));
    expect(outcome.errors).toEqual([]);
    expect(outcome.status.state).toBe('ready');
    expect(outcome.flags[ON]).toBe(true);
  });

  test('a normal profile reuses cached values on reload; a fresh private profile has none', async ({ browser }) => {
    // A normal profile: storage lives across page loads.
    const profile: BrowserContext = await browser.newContext({ baseURL: 'http://localhost:5174' });
    const first = await run(await profile.newPage(), config({ persist: true }));
    expect(first.flags[ON]).toBe(true);

    // Reload with the flag service unreachable: values come from the cache.
    const reload = await profile.newPage();
    await reload.route(`${API}/**`, (route) => route.abort('connectionrefused'));
    const cached = await run(reload, { ...config({ persist: true }), wait: '2000' });
    expect(cached.errors).toEqual([]);
    expect(cached.flags[ON]).toBe(true);
    await profile.close();

    // A private window: a fresh, empty profile. Nothing cached, nothing broken.
    const privateWindow = await browser.newContext({ baseURL: 'http://localhost:5174' });
    const fresh = await privateWindow.newPage();
    await fresh.route(`${API}/**`, (route) => route.abort('connectionrefused'));
    const empty = await run(fresh, { ...config({ persist: true }), wait: '2000' });
    expect(empty.errors).toEqual([]);
    expect(empty.flags).toEqual({});
    await privateWindow.close();
  });

  test('without persist, nothing is written to storage at all', async ({ page }) => {
    await run(page);
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
  });
});
