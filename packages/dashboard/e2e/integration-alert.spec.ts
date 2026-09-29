import { expect, test } from '@playwright/test';
import { createFlag, deleteFlag, login, uniqueKey } from './helpers';

/**
 * The SRS §5 story, end to end on one screen.
 *
 * An external service calls the alert endpoint; the flag turns itself off; and
 * an admin opening the dashboard sees that it is already off, who did it, and
 * why — without anyone having touched the UI.
 */

const API_URL = process.env.FLAGS_API_URL ?? 'http://localhost:4000';
const INTEGRATION_KEY = process.env.E2E_INTEGRATION_KEY ?? 'dev-only-integration-key-change-me';

const ALERT_REASON = 'error rate 12% over 5 minutes';
const ALERT_SOURCE = 'error-tracker';

test('an external alert disables a flag, and the dashboard explains why', async ({
  page,
  request,
}) => {
  await login(page);
  const key = uniqueKey();
  await createFlag(page, key, 'Checkout redesign');

  // Turn it on and roll it out, as if the feature had just shipped.
  await page.getByRole('switch', { name: 'Enabled' }).click();
  await page.getByLabel('Rollout percentage slider').fill('25');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');

  // The error tracker notices a spike. Nobody is in the dashboard.
  const alert = await request.post(`${API_URL}/api/integrations/alert`, {
    headers: { 'x-integration-key': INTEGRATION_KEY, 'content-type': 'application/json' },
    data: { flagKey: key, reason: ALERT_REASON, source: ALERT_SOURCE },
  });
  expect(alert.ok()).toBe(true);
  expect(await alert.json()).toMatchObject({ disabled: true, auditLogged: true });

  // An on-call engineer opens the flag and finds it already off.
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Enabled' })).not.toBeChecked();
  await expect(page.getByText('Off', { exact: true })).toBeVisible();

  // ...with the whole story in the history: who, what, and why.
  const systemEntry = page.locator('article').filter({ hasText: 'System (integration)' });
  await expect(systemEntry).toHaveCount(1);
  await expect(systemEntry).toContainText(ALERT_SOURCE);
  await expect(systemEntry).toContainText(ALERT_REASON);
  await expect(systemEntry).toContainText('on');
  await expect(systemEntry).toContainText('off');

  // The rollout survived, so re-enabling resumes where it left off.
  await expect(page.getByLabel('Rollout percentage slider')).toHaveValue('25');

  // A human can put it back, and that is recorded as theirs.
  await page.getByRole('switch', { name: 'Enabled' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');
  await expect(page.locator('article').first()).toContainText('admin@example.com');

  await deleteFlag(page, key);
});

test('a retried alert does not add a second history entry', async ({ page, request }) => {
  await login(page);
  const key = uniqueKey();
  await createFlag(page, key, 'Retried alert');
  await page.getByRole('switch', { name: 'Enabled' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');

  const send = () =>
    request.post(`${API_URL}/api/integrations/alert`, {
      headers: { 'x-integration-key': INTEGRATION_KEY, 'content-type': 'application/json' },
      data: { flagKey: key, reason: ALERT_REASON, source: ALERT_SOURCE },
    });

  await send();
  const retry = await send();
  expect(await retry.json()).toMatchObject({ alreadyDisabled: true, auditLogged: false });

  await page.reload();
  await expect(page.locator('article').filter({ hasText: 'System (integration)' })).toHaveCount(1);

  await deleteFlag(page, key);
});
