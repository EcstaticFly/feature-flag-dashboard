import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * flagpilot/react in a Vite single-page app on React 18 — the shape of Chatzy
 * and Flauntify — against the real flag service.
 *
 * The test flag: enabled, rollout 0%, rule "userId in [alice]", exposed to
 * browsers. Visitor → true, alice → true, heidi → false. heidi's false proves
 * the signed identity reached the flag service.
 */

const API_URL = process.env.FLAGS_API_URL ?? 'http://localhost:4000';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'change-me-please';
const SDK_API_KEY = process.env.E2E_SDK_API_KEY ?? 'dev-only-sdk-api-key-change-me';
const FLAG = `e2e-vite-${Date.now()}`;
const PAGE = `/?flag=${FLAG}`;

let token = '';

async function admin(request: APIRequestContext, method: 'POST' | 'DELETE', path: string, data?: unknown) {
  const response = await request.fetch(`${API_URL}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    data,
  });
  expect(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`).toBe(true);
}

test.beforeAll(async ({ request }) => {
  const login = await request.post(`${API_URL}/api/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  expect(login.ok(), 'admin login failed — is the stack up and seeded? (npm run compose:up)').toBe(true);
  token = ((await login.json()) as { token: string }).token;
  await admin(request, 'POST', '/api/flags', {
    key: FLAG,
    name: 'Vite example e2e',
    enabled: true,
    rolloutPercentage: 0,
    targetingRules: [{ attribute: 'userId', operator: 'in', values: ['alice'] }],
    clientSide: true,
  });
});

test.afterAll(async ({ request }) => {
  if (token) await admin(request, 'DELETE', `/api/flags/${FLAG}`);
});

/** Anything that would mean the SDK hurt the page, or a secret left the server. */
function watchForTrouble(page: Page): { problems: string[]; secretRequests: string[] } {
  const problems: string[] = [];
  const secretRequests: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && /invalid hook call|hook|react/i.test(message.text())) {
      problems.push(`console: ${message.text()}`);
    }
  });
  page.on('request', (request) => {
    const headers = request.headers();
    if ('x-api-key' in headers || Object.values(headers).includes(SDK_API_KEY)) secretRequests.push(request.url());
  });
  return { problems, secretRequests };
}

async function nextBrowserAnswer(page: Page, action: () => Promise<unknown>) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/client/flags') && r.request().method() === 'POST'),
    action(),
  ]);
  const body = JSON.parse(response.request().postData() ?? '{}') as Record<string, unknown>;
  const flags = ((await response.json()) as { flags: Record<string, boolean> }).flags;
  return { status: response.status(), body, value: flags[FLAG] };
}

function builtCode(): string {
  const dir = fileURLToPath(new URL('../dist/assets', import.meta.url));
  return readdirSync(dir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => readFileSync(join(dir, name), 'utf8'))
    .join('\n');
}

test('runs on React 18, with exactly one copy of React in the bundle', async ({ page }) => {
  const { problems } = watchForTrouble(page);
  await page.goto(PAGE);
  await expect(page.getByTestId('react-version')).toHaveText(/^18\./);
  await expect(page.getByTestId('browser-status')).toHaveText('ready');
  // React 19's element marker. If dedupe failed, the SDK would have pulled in React 19.
  expect(builtCode()).not.toContain('react.transitional.element');
  expect(problems).toEqual([]);
});

test('signed identities: visitor true, heidi false, alice true, signed out true', async ({ page }) => {
  const { problems, secretRequests } = watchForTrouble(page);
  const visitor = await nextBrowserAnswer(page, () => page.goto(PAGE));
  expect(visitor.body).toEqual({});
  expect(visitor.value).toBe(true);
  await expect(page.getByTestId('browser-value')).toHaveText('true');

  const heidi = await nextBrowserAnswer(page, () => page.getByRole('button', { name: 'Sign in as heidi' }).click());
  expect(heidi.status).toBe(200);
  expect(Object.keys(heidi.body)).toEqual(['signedContext']); // a token, never a plain user id
  expect(heidi.value).toBe(false);
  await expect(page.getByTestId('user')).toHaveText('heidi');
  await expect(page.getByTestId('browser-value')).toHaveText('false');

  const alice = await nextBrowserAnswer(page, () => page.getByRole('button', { name: 'Sign in as alice' }).click());
  expect(alice.value).toBe(true);
  await expect(page.getByTestId('browser-value')).toHaveText('true');

  const out = await nextBrowserAnswer(page, () => page.getByRole('button', { name: 'Sign out' }).click());
  expect(out.body).toEqual({});
  await expect(page.getByTestId('browser-value')).toHaveText('true');

  expect(problems).toEqual([]);
  expect(secretRequests).toEqual([]);
});

test('a returning visitor gets the cached value even when the flag service is unreachable', async ({ page }) => {
  const { problems } = watchForTrouble(page);
  await page.goto(PAGE);
  await expect(page.getByTestId('browser-status')).toHaveText('ready');
  await expect(page.getByTestId('browser-value')).toHaveText('true');

  await page.route('**/api/client/flags', (route) => route.abort('connectionrefused'));
  await page.reload();
  await expect(page.getByTestId('browser-status')).toHaveText('error');
  await expect(page.getByTestId('browser-value')).toHaveText('true'); // from persist, not the default
  // The app itself keeps working.
  await page.getByRole('button', { name: 'Sign in as alice' }).click();
  await expect(page.getByTestId('user')).toHaveText('alice');
  expect(problems).toEqual([]);
});

test('a first-time visitor with the flag service unreachable gets defaults, and the page works', async ({ page }) => {
  const { problems } = watchForTrouble(page);
  await page.route('**/api/client/flags', (route) => route.abort('connectionrefused'));
  await page.goto(PAGE);
  await expect(page.getByTestId('browser-status')).toHaveText('error');
  await expect(page.getByTestId('browser-value')).toHaveText('false');
  await page.getByRole('button', { name: 'Sign in as heidi' }).click();
  await expect(page.getByTestId('user')).toHaveText('heidi');
  expect(problems).toEqual([]);
});

test('storage blocked entirely (strict privacy settings): values still load', async ({ page }) => {
  const { problems } = watchForTrouble(page);
  // What Safari and Firefox do with storage disabled: even reading the property throws.
  await page.addInitScript(() => {
    for (const name of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(window, name, {
        configurable: true,
        get() {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      });
    }
  });
  await page.goto(PAGE);
  await expect(page.getByTestId('browser-status')).toHaveText('ready');
  await expect(page.getByTestId('browser-value')).toHaveText('true');
  expect(problems).toEqual([]);
});

test('the browser bundle holds the public client key only — no server SDK, no secret', () => {
  const code = builtCode();
  expect(code).toContain('/api/client/flags'); // the control: flagpilot/react is in here
  expect(code).not.toContain('x-api-key');
  expect(code).not.toContain('/api/sdk/flags');
  expect(code).not.toContain(SDK_API_KEY);
});
