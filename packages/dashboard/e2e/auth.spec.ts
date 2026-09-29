import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, login } from './helpers';

test.describe('authentication', () => {
  test('redirects an unauthenticated visitor to login, with no flash of the flag list', async ({
    page,
  }) => {
    await page.goto('/flags');

    await expect(page).toHaveURL(/\/login/);
    // Middleware redirects before anything renders, so the heading never appears.
    await expect(page.getByRole('heading', { name: 'Feature Flags', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New flag' })).toHaveCount(0);
  });

  test('remembers where you were going', async ({ page }) => {
    await page.goto('/flags/some-flag');
    await expect(page).toHaveURL(/next=%2Fflags%2Fsome-flag/);
  });

  test('shows an inline error for a wrong password, rather than crashing', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(ADMIN_EMAIL);
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByText('invalid email or password')).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('signs in and out', async ({ page }) => {
    await login(page);
    await expect(page.getByRole('heading', { name: 'Feature Flags' })).toBeVisible();

    await page.getByRole('link', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login/);

    // The session is really gone, not just navigated away from.
    await page.goto('/flags');
    await expect(page).toHaveURL(/\/login/);
  });
});

test.describe('the JWT never reaches the browser', () => {
  test('is not readable from client JavaScript and not present in the HTML', async ({ page }) => {
    await login(page);

    // httpOnly means document.cookie cannot see it — this is the whole point of
    // the Route Handler proxy.
    const visibleCookies = await page.evaluate(() => document.cookie);
    expect(visibleCookies).not.toContain('ff_session');

    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === 'ff_session');
    expect(session, 'the session cookie should exist').toBeDefined();
    expect(session?.httpOnly, 'the session cookie must be httpOnly').toBe(true);

    // And the token is not serialised into the page for a client component.
    const html = await page.content();
    expect(html).not.toContain(session!.value);
    expect(html).not.toMatch(/eyJhbGciOiJIUzI1NiIs/);
  });

  test('does not leak the API URL to the client bundle', async ({ page }) => {
    await login(page);
    const html = await page.content();
    // FLAGS_API_URL has no NEXT_PUBLIC_ prefix, so it is server-only.
    expect(html).not.toContain('localhost:4000');
  });
});
