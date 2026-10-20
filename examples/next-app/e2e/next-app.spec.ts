import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * flagpilot in a real Next.js App Router app, against the real flag service.
 *
 * The test flag: enabled, rollout 0%, one rule "userId in [alice]", exposed to
 * browsers. So a visitor sees true (anonymous traffic sees an enabled flag),
 * alice true (the rule) and heidi false (0%). heidi's false is the proof that
 * the signed identity reached the flag service: an unsigned or dropped identity
 * would be treated as a visitor and see true.
 */

const API_URL = process.env.FLAGS_API_URL ?? 'http://localhost:4000';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'change-me-please';
const SDK_API_KEY = process.env.E2E_SDK_API_KEY ?? 'dev-only-sdk-api-key-change-me';
const FLAG = `e2e-next-${Date.now()}`;

let token = '';

async function admin(request: APIRequestContext, method: 'POST' | 'PATCH' | 'DELETE', path: string, data?: unknown) {
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
    name: 'Next.js example e2e',
    enabled: true,
    rolloutPercentage: 0,
    targetingRules: [{ attribute: 'userId', operator: 'in', values: ['alice'] }],
    clientSide: true,
  });
});

test.afterAll(async ({ request }) => {
  if (token) await admin(request, 'DELETE', `/api/flags/${FLAG}`);
});

/** Collects everything that would mean the SDK hurt the page. */
function watchForTrouble(page: Page): { problems: string[]; secretRequests: string[] } {
  const problems: string[] = [];
  const secretRequests: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && /hydrat|did not match|server rendered/i.test(message.text())) {
      problems.push(`console: ${message.text()}`);
    }
  });
  page.on('request', (request) => {
    const headers = request.headers();
    if ('x-api-key' in headers || Object.values(headers).includes(SDK_API_KEY)) secretRequests.push(request.url());
  });
  return { problems, secretRequests };
}

async function signInAs(page: Page, name: 'alice' | 'heidi') {
  await page.getByRole('button', { name: `Sign in as ${name}` }).click();
  await expect(page.getByTestId('user')).toHaveText(name);
}

/** Waits for the browser's own request for these flags and returns what the flag service said. */
async function nextBrowserAnswer(page: Page, action: () => Promise<unknown>) {
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/client/flags') && r.request().method() === 'POST'),
    action(),
  ]);
  const body = JSON.parse(response.request().postData() ?? '{}') as Record<string, unknown>;
  const flags = ((await response.json()) as { flags: Record<string, boolean> }).flags;
  return { status: response.status(), body, value: flags[FLAG] };
}

test.beforeEach(async ({ page }) => {
  // The server SDK refreshes every second in this run; wait until it has the new flag.
  await expect
    .poll(async () => {
      await page.goto(`/?flag=${FLAG}`);
      return page.getByTestId('server-value').textContent();
    })
    .toBe('true');
});

test('the first paint is already right: initialFlags are in the server-rendered HTML', async ({ page, context }) => {
  await context.addCookies([{ name: 'demo_user', value: 'alice', url: 'http://localhost:3001' }]);
  // The raw response, before any JavaScript runs. false is the default, so a
  // true here can only have come from the server SDK's getClientFlags().
  const html = await (await page.request.get(`/?flag=${FLAG}`)).text();
  expect(html).toMatch(/data-testid="server-value"[^>]*>true</);
  expect(html).toMatch(/data-testid="browser-value"[^>]*>true</);
});

test('hydrates cleanly, then the browser confirms the value itself', async ({ page }) => {
  const { problems, secretRequests } = watchForTrouble(page);
  await page.goto(`/?flag=${FLAG}`);
  await expect(page.getByTestId('browser-status')).toHaveText('ready');
  await expect(page.getByTestId('browser-value')).toHaveText('true');
  expect(problems).toEqual([]);
  expect(secretRequests).toEqual([]);
});

test('a signed identity reaches the flag service: heidi false, alice true, visitor true', async ({ page }) => {
  const { problems, secretRequests } = watchForTrouble(page);
  await page.goto(`/?flag=${FLAG}`);
  await expect(page.getByTestId('browser-status')).toHaveText('ready');

  const heidi = await nextBrowserAnswer(page, () => signInAs(page, 'heidi'));
  expect(heidi.status).toBe(200);
  expect(heidi.body).toHaveProperty('signedContext'); // a token, never a plain user id
  expect(heidi.body).not.toHaveProperty('context');
  expect(heidi.value).toBe(false);
  await expect(page.getByTestId('browser-value')).toHaveText('false');
  await expect(page.getByTestId('server-value')).toHaveText('false');

  const alice = await nextBrowserAnswer(page, () => signInAs(page, 'alice'));
  expect(alice.value).toBe(true);
  await expect(page.getByTestId('browser-value')).toHaveText('true');

  const visitor = await nextBrowserAnswer(page, () => page.getByRole('button', { name: 'Sign out' }).click());
  expect(visitor.body).toEqual({});
  expect(visitor.value).toBe(true);
  await expect(page.getByTestId('browser-value')).toHaveText('true');

  expect(problems).toEqual([]);
  expect(secretRequests).toEqual([]);
});

test('a dashboard change reaches the open page without a reload', async ({ page, request }) => {
  await page.goto(`/?flag=${FLAG}`);
  await expect(page.getByTestId('browser-value')).toHaveText('true');

  await admin(request, 'PATCH', `/api/flags/${FLAG}`, { enabled: false });
  try {
    await expect
      .poll(async () => {
        await page.getByRole('button', { name: 'Check now' }).click();
        return page.getByTestId('browser-value').textContent();
      })
      .toBe('false');
  } finally {
    await admin(request, 'PATCH', `/api/flags/${FLAG}`, { enabled: true });
  }
});

test('if the browser cannot reach the flag service, the page still works on the server values', async ({ page }) => {
  const { problems } = watchForTrouble(page);
  await page.route('**/api/client/flags', (route) => route.abort('connectionrefused'));
  await page.goto(`/?flag=${FLAG}`);
  await expect(page.getByTestId('browser-status')).toHaveText('error');
  // Still the server-rendered value: last known beats default.
  await expect(page.getByTestId('browser-value')).toHaveText('true');
  await page.getByRole('button', { name: 'Sign in as heidi' }).click();
  await expect(page.getByTestId('user')).toHaveText('heidi');
  expect(problems).toEqual([]);
});

test('the browser bundle has the browser client only — no server SDK, no key', () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith('.js')) files.push(path);
    }
  };
  walk(fileURLToPath(new URL('../.next/static', import.meta.url)));
  const code = files.map((file) => readFileSync(file, 'utf8')).join('\n');

  expect(code).toContain('/api/client/flags'); // the control: flagpilot/react is in here
  expect(code).not.toContain('x-api-key');
  expect(code).not.toContain('/api/sdk/flags');
  expect(code).not.toContain(SDK_API_KEY);
});
