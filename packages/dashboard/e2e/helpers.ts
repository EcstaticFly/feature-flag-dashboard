import { expect, type Page } from '@playwright/test';

export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'change-me-please';

/** Unique per run, so reruns never collide with flags a previous run left behind. */
export function uniqueKey(prefix = 'e2e'): string {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

export async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Fail with something actionable. An empty users table makes every spec fail
  // on an inscrutable URL assertion; this says what to actually do about it.
  const rejected = page.getByText('invalid email or password');
  await expect
    .poll(async () => ((await rejected.count()) > 0 ? 'rejected' : page.url()), { timeout: 10_000 })
    .not.toBe('rejected');
  if (await rejected.count()) {
    throw new Error(
      `the API rejected ${ADMIN_EMAIL}. Has the admin been seeded? Run: npm run db:seed`,
    );
  }
  await expect(page).toHaveURL(/\/flags$/);
}

/** Creates a flag through the UI and lands on its detail page. */
export async function createFlag(page: Page, key: string, name = 'E2E flag'): Promise<void> {
  await page.goto('/flags');
  await page.getByRole('button', { name: 'New flag' }).first().click();
  await page.getByLabel('Key').fill(key);
  await page.getByLabel('Name').fill(name);
  await page.getByRole('button', { name: 'Create flag' }).click();
  await expect(page).toHaveURL(new RegExp(`/flags/${key}$`));
}

/** Removes a flag so a run leaves the database as it found it. */
export async function deleteFlag(page: Page, key: string): Promise<void> {
  await page.goto(`/flags/${key}`);
  if (!page.url().includes(key)) return;
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('button', { name: 'Delete flag' }).click();
  await expect(page).toHaveURL(/\/flags$/);
}
