import { expect, test } from '@playwright/test';
import { createFlag, deleteFlag, login, uniqueKey } from './helpers';

/**
 * After a save the form must keep showing what was saved.
 *
 * React resets a form once its action resolves. Radix's Switch listens for that
 * reset and drives its controlled value back to `defaultChecked`, which used to
 * leave the kill switch visibly off immediately after saving it on — the
 * displayed state disagreeing with the database until a manual reload.
 */
test.beforeEach(async ({ page }) => {
  await login(page);
});

test('the editor shows the saved values with no reload', async ({ page }) => {
  const key = uniqueKey();
  await createFlag(page, key, 'Form state');

  await page.getByRole('switch', { name: 'Enabled' }).click();
  await page.getByLabel('Rollout percentage slider').fill('58');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');

  // The audit proves the server accepted it; these assert the UI agrees.
  await expect(page.getByRole('switch', { name: 'Enabled' })).toBeChecked();
  await expect(page.getByLabel('Rollout percentage slider')).toHaveValue('58');
  await expect(page.getByText('Live')).toBeVisible();

  // ...and that it really is what was stored.
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Enabled' })).toBeChecked();
  await expect(page.getByLabel('Rollout percentage slider')).toHaveValue('58');

  await deleteFlag(page, key);
});

test('text fields and rules survive a save too', async ({ page }) => {
  const key = uniqueKey();
  await createFlag(page, key, 'Before rename');

  await page.getByLabel('Name').fill('After rename');
  await page.getByLabel('Description').fill('Now described.');
  await page.getByRole('button', { name: 'Allowlist users' }).click();
  await page.getByLabel('Rule 1 value').fill('vip-user');
  await page.getByRole('button', { name: 'Add', exact: true }).click();

  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');

  await expect(page.getByLabel('Name')).toHaveValue('After rename');
  await expect(page.getByLabel('Description')).toHaveValue('Now described.');
  await expect(page.getByTestId('rule-0').getByText('vip-user')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'After rename' })).toBeVisible();

  await deleteFlag(page, key);
});

test('turning a flag off saves as off', async ({ page }) => {
  // The mirror of the original bug: the switch must not silently re-enable.
  const key = uniqueKey();
  await createFlag(page, key, 'Toggle down');

  await page.getByRole('switch', { name: 'Enabled' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('switch', { name: 'Enabled' })).toBeChecked();

  await page.getByRole('switch', { name: 'Enabled' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();

  await expect(page.getByRole('switch', { name: 'Enabled' })).not.toBeChecked();
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Enabled' })).not.toBeChecked();

  await deleteFlag(page, key);
});

test('disabling a flag keeps its rollout percentage', async ({ page }) => {
  /*
   * A disabled form control is not submitted, so greying out the rollout while
   * the kill switch was off silently saved it back to 0 — the percentage was
   * lost the moment you turned a flag off.
   */
  const key = uniqueKey();
  await createFlag(page, key, 'Keeps rollout');

  await page.getByRole('switch', { name: 'Enabled' }).click();
  await page.getByLabel('Rollout percentage slider').fill('58');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');

  await page.getByRole('switch', { name: 'Enabled' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('switch', { name: 'Enabled' })).not.toBeChecked();

  // Still 58 — ready to resume where it left off.
  await expect(page.getByLabel('Rollout percentage slider')).toHaveValue('58');
  await page.reload();
  await expect(page.getByLabel('Rollout percentage slider')).toHaveValue('58');
  await expect(page.getByRole('switch', { name: 'Enabled' })).not.toBeChecked();

  await deleteFlag(page, key);
});

test('a change made on the detail page shows correctly in the list', async ({ page }) => {
  const key = uniqueKey();
  await createFlag(page, key, 'Cross view');

  await page.getByRole('switch', { name: 'Enabled' }).click();
  await page.getByLabel('Rollout percentage slider').fill('40');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');

  await page.getByRole('link', { name: 'All flags' }).click();
  await expect(page.getByRole('switch', { name: `Disable ${key}` })).toBeVisible();
  await expect(page.getByRole('switch', { name: `Disable ${key}` })).toBeChecked();
  await expect(page.getByText('40%')).toBeVisible();

  await deleteFlag(page, key);
});
