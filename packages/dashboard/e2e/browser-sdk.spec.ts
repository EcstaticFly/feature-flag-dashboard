import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createFlag, deleteFlag, login, uniqueKey } from './helpers';

/**
 * Browser SDK management (Milestone 10): the per-flag "Available to browser
 * SDKs" switch, its list badge and audit entry, its real effect on the browser
 * API, and the SDK setup page — which must never show a secret.
 *
 * Defaults match docker-compose.yml; override with E2E_* variables if your
 * .env changes them.
 */

const API_URL = process.env.FLAGS_API_URL ?? 'http://localhost:4000';
const CLIENT_API_KEY = process.env.E2E_CLIENT_API_KEY ?? 'dev-only-client-key-public';
const SECRETS = {
  SDK_API_KEY: process.env.E2E_SDK_API_KEY ?? 'dev-only-sdk-api-key-change-me',
  INTEGRATION_API_KEY: process.env.E2E_INTEGRATION_KEY ?? 'dev-only-integration-key-change-me',
  JWT_SECRET: process.env.E2E_JWT_SECRET ?? 'dev-only-jwt-secret-change-me-at-least-32-chars',
};

const browserSwitch = (page: Page) => page.getByRole('switch', { name: 'Available to browser SDKs' });

/** The badge sits beside the key, in that flag's own row. */
const listBadge = (page: Page, key: string) =>
  page.locator(`code[title="${key}"]`).locator('..').getByTitle('Available to browser SDKs');

/** What an anonymous visitor's browser would receive, through the real browser API. */
async function browserFlags(request: APIRequestContext): Promise<Record<string, boolean>> {
  const response = await request.post(`${API_URL}/api/client/flags`, {
    headers: { 'x-flagpilot-client-key': CLIENT_API_KEY, 'content-type': 'application/json' },
    data: {},
  });
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { flags: Record<string, boolean> }).flags;
}

test.beforeEach(async ({ page }) => {
  await login(page);
});

test('exposing a flag survives a save, shows in the list and the history, and reaches browsers', async ({
  page,
  request,
}) => {
  const key = uniqueKey();
  await createFlag(page, key, 'Browser exposed');

  // New flags start server-only, and browsers cannot see them at all.
  await expect(browserSwitch(page)).not.toBeChecked();
  expect(await browserFlags(request)).not.toHaveProperty(key);

  await browserSwitch(page).click();
  await page.getByRole('switch', { name: 'Enabled' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');

  // The form keeps showing what was saved (the Radix form-reset trap), and it was stored.
  await expect(browserSwitch(page)).toBeChecked();
  await page.reload();
  await expect(browserSwitch(page)).toBeChecked();

  // The history says who exposed it.
  const latest = page.locator('article').first();
  await expect(latest).toContainText('Browser SDKs');
  await expect(latest).toContainText('server only');
  await expect(latest).toContainText('exposed');

  // Browsers now get the on/off value — and nothing else about the flag.
  await expect.poll(async () => (await browserFlags(request))[key], { timeout: 10_000 }).toBe(true);

  await page.getByRole('link', { name: 'All flags' }).click();
  await expect(listBadge(page, key)).toBeVisible();

  // The list's kill switch writes only `enabled`; exposure is untouched.
  await page.getByRole('switch', { name: `Disable ${key}` }).click();
  await expect(page.getByRole('switch', { name: `Enable ${key}` })).not.toBeChecked();
  await expect.poll(async () => (await browserFlags(request))[key], { timeout: 10_000 }).toBe(false);
  await expect(listBadge(page, key)).toBeVisible();

  await deleteFlag(page, key);
});

test('hiding a flag again removes it from browsers entirely', async ({ page, request }) => {
  const key = uniqueKey();
  await createFlag(page, key, 'Browser hidden');

  await browserSwitch(page).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(browserSwitch(page)).toBeChecked();
  await expect.poll(async () => key in (await browserFlags(request)), { timeout: 10_000 }).toBe(true);

  await browserSwitch(page).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(browserSwitch(page)).not.toBeChecked();
  await page.reload();
  await expect(browserSwitch(page)).not.toBeChecked();

  // Absent, not false: a server-only flag's existence is not revealed.
  await expect.poll(async () => key in (await browserFlags(request)), { timeout: 10_000 }).toBe(false);
  await expect(page.locator('article').first()).toContainText('exposed');

  await page.getByRole('link', { name: 'All flags' }).click();
  await expect(page.locator(`code[title="${key}"]`)).toBeVisible();
  await expect(listBadge(page, key)).toHaveCount(0);

  await deleteFlag(page, key);
});

test('the SDK setup page shows the public client key and never a secret', async ({ page }) => {
  await page.goto('/flags');
  await page.getByRole('link', { name: 'SDK setup' }).click();
  await expect(page).toHaveURL(/\/settings\/sdk$/);
  await expect(page.getByRole('heading', { name: 'SDK setup' })).toBeVisible();

  await expect(page.getByText('Configured')).toBeVisible();
  await expect(page.getByTestId('client-key')).toHaveText(CLIENT_API_KEY);
  await expect(page.getByTestId('allowed-origins')).toBeVisible();
  await expect(page.getByText('Required', { exact: true })).toBeVisible();
  await expect(page.getByText('Next.js (App Router)')).toBeVisible();

  // Not in the rendered page, and not anywhere in what the server sent — the
  // raw response includes Next's inline RSC payload, not just visible text.
  const rendered = await page.content();
  const raw = await (await page.request.get('/settings/sdk')).text();
  expect(raw).toContain(CLIENT_API_KEY); // the control: this really is the page
  for (const [name, secret] of Object.entries(SECRETS)) {
    expect(rendered.includes(secret), `${name} rendered on the SDK setup page`).toBe(false);
    expect(raw.includes(secret), `${name} sent in the SDK setup page's response`).toBe(false);
  }
  // The snippets point at an environment variable instead.
  expect(rendered).toContain('process.env.FLAGPILOT_SDK_KEY');
});

test('the SDK setup page is behind the login', async ({ browser }) => {
  // A fresh context: no session cookie.
  const context = await browser.newContext();
  const anonymous = await context.newPage();
  await anonymous.goto('/settings/sdk');
  await expect(anonymous).toHaveURL(/\/login\?next=%2Fsettings%2Fsdk$/);
  await context.close();
});
