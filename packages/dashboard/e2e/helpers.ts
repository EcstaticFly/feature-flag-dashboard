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
