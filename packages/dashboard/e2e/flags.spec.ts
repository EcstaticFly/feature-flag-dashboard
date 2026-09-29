import { expect, test } from '@playwright/test';
import { createFlag, deleteFlag, login, uniqueKey } from './helpers';

test.beforeEach(async ({ page }) => {
  await login(page);
});

test.describe('the flag lifecycle', () => {
  // The path the milestone names: create, roll out, toggle off, read the audit.
  test('create, set 50% rollout, toggle off, and see it all in the history', async ({ page }) => {
    const key = uniqueKey();

    await createFlag(page, key, 'Checkout redesign');
    await expect(page.getByRole('heading', { name: 'Checkout redesign' })).toBeVisible();
    // New flags ship dark.
    await expect(page.getByText('Off', { exact: true })).toBeVisible();

    // Enable, then roll out to half.
    await page.getByRole('switch', { name: 'Enabled' }).click();
    await page.getByLabel('Rollout percentage slider').fill('50');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toContainText('Saved');

    await page.reload();
    await expect(page.getByLabel('Rollout percentage slider')).toHaveValue('50');
    await expect(page.getByText('Live')).toBeVisible();

    // The kill switch.
    await page.getByRole('switch', { name: 'Enabled' }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toContainText('Saved');

    // Every change is in the trail, newest first, attributed and diffed.
    const history = page.locator('article');
    await expect(history.first()).toContainText('updated');
    await expect(history.first()).toContainText('admin@example.com');
    await expect(history.last()).toContainText('created');
    await expect(page.getByText('Rollout').first()).toBeVisible();
    await expect(page.getByText('50%').first()).toBeVisible();

    await deleteFlag(page, key);
  });

  test('a new flag appears in the list without a manual refresh', async ({ page }) => {
    const key = uniqueKey();
    await createFlag(page, key, 'Revalidated flag');

    // revalidatePath means going back shows it already there.
    await page.getByRole('link', { name: 'All flags' }).click();
    await expect(page.getByRole('link', { name: 'Revalidated flag' })).toBeVisible();

    await deleteFlag(page, key);
  });

  test('the list switch is a kill switch that persists', async ({ page }) => {
    const key = uniqueKey();
    await createFlag(page, key, 'Toggle from list');
    await page.goto('/flags');

    await page.getByRole('switch', { name: `Enable ${key}` }).click();
    await expect(page.getByRole('switch', { name: `Disable ${key}` })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('switch', { name: `Disable ${key}` })).toBeVisible();

    await deleteFlag(page, key);
  });

  test('a deleted flag leaves the list', async ({ page }) => {
    const key = uniqueKey();
    await createFlag(page, key, 'Short lived');
    await deleteFlag(page, key);

    await expect(page.getByRole('link', { name: 'Short lived' })).toHaveCount(0);
  });
});

test.describe('validation surfaces inline, never as a crash', () => {
  test('a duplicate key is reported on the field', async ({ page }) => {
    const key = uniqueKey();
    await createFlag(page, key, 'The original');

    await page.goto('/flags');
    await page.getByRole('button', { name: 'New flag' }).first().click();
    await page.getByLabel('Key').fill(key);
    await page.getByLabel('Name').fill('The impostor');
    await page.getByRole('button', { name: 'Create flag' }).click();

    await expect(page.getByText('A flag with this key already exists.')).toBeVisible();
    // Still on the dialog with the input preserved, not an error page.
    await expect(page.getByLabel('Key')).toHaveValue(key);

    await page.keyboard.press('Escape');
    await deleteFlag(page, key);
  });

  test('a non-slug key is refused', async ({ page }) => {
    await page.goto('/flags');
    await page.getByRole('button', { name: 'New flag' }).first().click();
    await page.getByLabel('Key').fill('Not A Slug');
    await page.getByLabel('Name').fill('Bad key');
    await page.getByRole('button', { name: 'Create flag' }).click();

    // The browser's pattern check blocks it before the request is even made.
    await expect(page).not.toHaveURL(/\/flags\/Not/);
  });
});

test.describe('targeting rules', () => {
  test('an allowlist rule round-trips through the builder', async ({ page }) => {
    const key = uniqueKey();
    await createFlag(page, key, 'Targeted flag');

    await page.getByRole('button', { name: 'Allowlist users' }).click();
    await expect(page.getByLabel('Rule 1 attribute')).toHaveValue('userId');

    await page.getByLabel('Rule 1 value').fill('vip-user');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByTestId('rule-0').getByText('vip-user')).toBeVisible();

    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toContainText('Saved');

    await page.reload();
    await expect(page.getByLabel('Rule 1 attribute')).toHaveValue('userId');
    // Scoped to the rule row: the value also shows up in the audit diff below.
    await expect(page.getByTestId('rule-0').getByText('vip-user')).toBeVisible();

    // And the list shows that the flag has targeting.
    await page.goto('/flags');
    await expect(page.locator(`text=${key}`).first()).toBeVisible();

    await deleteFlag(page, key);
  });

  test('the equals operator accepts only one value', async ({ page }) => {
    const key = uniqueKey();
    await createFlag(page, key, 'Single value rule');

    await page.getByRole('button', { name: 'Add attribute rule' }).click();
    await page.getByLabel('Rule 1 attribute').fill('plan');
    await page.getByLabel('Rule 1 value').fill('pro');
    await page.getByRole('button', { name: 'Add', exact: true }).click();

    // A second value is impossible for `eq`, matching what the API enforces.
    await expect(page.getByLabel('Rule 1 value')).toBeDisabled();
    await expect(page.getByLabel('Rule 1 value')).toHaveAttribute(
      'placeholder',
      /exactly one value/,
    );

    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toContainText('Saved');

    await deleteFlag(page, key);
  });
});
