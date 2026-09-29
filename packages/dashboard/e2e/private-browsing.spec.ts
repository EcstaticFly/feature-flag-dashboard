import { expect, test } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD } from './helpers';

/**
 * Private browsing.
 *
 * Incognito does NOT block cookies — it gives the window a fresh, isolated
 * cookie jar that is thrown away when the window closes. Session cookies are
 * exactly what it is designed to support; only a browser explicitly configured
 * to block all cookies would be a problem, and that breaks every cookie-based
 * login on the web, not just this one.
 *
 * A Playwright browser context IS an incognito profile: empty storage, isolated
 * from every other context, discarded on close. So these tests are the real
 * thing, not an approximation.
 */

test.describe('private/incognito browsing', () => {
  test('a fresh private window can sign in and use the dashboard', async ({ browser }) => {
    // Brand new context: no cookies, no localStorage, nothing carried over.
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      const storage = await context.storageState();
      expect(storage.cookies, 'a private window starts with no cookies').toHaveLength(0);

      await page.goto('/flags');
      await expect(page).toHaveURL(/\/login/);

      await page.getByLabel('Email').fill(ADMIN_EMAIL);
      await page.getByLabel('Password').fill(ADMIN_PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();

      await expect(page).toHaveURL(/\/flags$/);
      await expect(page.getByRole('heading', { name: 'Feature Flags' })).toBeVisible();

      // The cookie was accepted and is still httpOnly in this context.
      const session = (await context.cookies()).find((c) => c.name === 'ff_session');
      expect(session?.httpOnly).toBe(true);
      expect(await page.evaluate(() => document.cookie)).not.toContain('ff_session');
    } finally {
      await context.close();
    }
  });

  test('two private windows hold independent sessions', async ({ browser }) => {
    const signedIn = await browser.newContext();
    const anonymous = await browser.newContext();

    try {
      const page = await signedIn.newPage();
      await page.goto('/login');
      await page.getByLabel('Email').fill(ADMIN_EMAIL);
      await page.getByLabel('Password').fill(ADMIN_PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page).toHaveURL(/\/flags$/);

      // The second window knows nothing about the first — same as two incognito
      // windows, or an incognito window beside a normal one.
      const other = await anonymous.newPage();
      await other.goto('/flags');
      await expect(other).toHaveURL(/\/login/);
    } finally {
      await signedIn.close();
      await anonymous.close();
    }
  });

  test('losing the cookie mid-session returns to login rather than erroring', async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto('/login');
      await page.getByLabel('Email').fill(ADMIN_EMAIL);
      await page.getByLabel('Password').fill(ADMIN_PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page).toHaveURL(/\/flags$/);

      // Closing an incognito window discards its cookies; this is that, without
      // closing the window.
      await context.clearCookies();
      await page.goto('/flags');

      await expect(page).toHaveURL(/\/login/);
      await expect(page.getByRole('heading', { name: 'Feature Flags' })).toBeVisible();
    } finally {
      await context.close();
    }
  });
});
