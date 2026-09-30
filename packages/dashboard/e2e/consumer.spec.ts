import { createFlagClient, type FlagClient } from '@feature-flags/sdk';
import { expect, test } from '@playwright/test';
import { createFlag, deleteFlag, login, uniqueKey } from './helpers';

/**
 * SRS §6.2's last untested row: "flip a flag in the UI, verify a separate
 * consumer script sees it."
 *
 * Everything else in this suite tests the dashboard against the API, and the
 * SDK's own tests run against a stub server. Neither proves the claim the whole
 * project rests on — that an admin moving a slider changes what a *running
 * application* does. This spec is the only place the full chain executes:
 *
 *   browser → dashboard Server Action → Express API → Postgres
 *                                     ↓ cache invalidation
 *   real SDK client ── GET /api/sdk/flags ──┘ → local evaluation
 *
 * The SDK client here is a genuine consumer: the published entry point, its own
 * HTTP calls, its own timer, evaluating in-process via @feature-flags/core. It
 * shares nothing with the dashboard but the API.
 */

const API_URL = process.env.FLAGS_API_URL ?? 'http://localhost:4000';
const SDK_API_KEY = process.env.E2E_SDK_API_KEY ?? 'dev-only-sdk-api-key-change-me';

/** Short, so the assertion does not sit through a production-length interval. */
const REFRESH_MS = 500;

/** A user id the answer must not depend on — see the rollout note below. */
const USER = { userId: 'consumer-spec-user' };

/**
 * Polls the client's answer, which is the honest way to assert on a background
 * refresh: the SDK promises propagation *within* an interval, not instantly.
 */
async function eventually(client: FlagClient, key: string, expected: boolean): Promise<void> {
  await expect
    .poll(() => client.isEnabled(key, USER), {
      timeout: 10_000,
      intervals: [100, 100, 200, 200, 500],
      message: `the SDK never saw ${key} become ${expected}`,
    })
    .toBe(expected);
}

test('a flag flipped in the UI reaches a running SDK consumer', async ({ page }) => {
  await login(page);
  const key = uniqueKey('consumer');
  await createFlag(page, key, 'Consumer visible flag');

  // A flag is created disabled, so this is the pre-change state.
  let client: FlagClient | undefined;
  try {
    client = createFlagClient({
      apiUrl: API_URL,
      apiKey: SDK_API_KEY,
      refreshIntervalMs: REFRESH_MS,
    });
    await client.init();

    // The consumer agrees the feature is off before anything is touched. Without
    // this the test could pass on a client that simply returns true for
    // everything.
    expect(client.isEnabled(key, USER)).toBe(false);

    /*
     * Now the part being tested: an admin turns it on in the browser.
     *
     * Rollout goes to 100 so the expected answer is unambiguous for any user id.
     * At any partial percentage the correct answer depends on the bucket, and a
     * spec that computed buckets would be re-testing M2's hash rather than
     * testing propagation.
     */
    await page.getByRole('switch', { name: 'Enabled' }).click();
    await page.getByLabel('Rollout percentage slider').fill('100');
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toContainText('Saved');

    await eventually(client, key, true);

    // And it rolls back the same way — the instant-rollback claim, from the
    // consumer's side rather than the dashboard's.
    await page.getByRole('switch', { name: 'Enabled' }).click();
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toContainText('Saved');

    await eventually(client, key, false);

    // The kill switch won, not the rollout: a consumer must see `false` even
    // though the flag is still configured for 100% of users.
    await expect(page.getByLabel('Rollout percentage slider')).toHaveValue('100');
  } finally {
    client?.close();
    await deleteFlag(page, key);
  }
});

test('a flag deleted in the UI stops being served to a consumer', async ({ page }) => {
  await login(page);
  const key = uniqueKey('consumer-del');
  await createFlag(page, key, 'Short lived flag');

  await page.getByRole('switch', { name: 'Enabled' }).click();
  await page.getByLabel('Rollout percentage slider').fill('100');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status')).toContainText('Saved');

  let client: FlagClient | undefined;
  try {
    client = createFlagClient({
      apiUrl: API_URL,
      apiKey: SDK_API_KEY,
      refreshIntervalMs: REFRESH_MS,
    });
    await client.init();
    await eventually(client, key, true);

    await deleteFlag(page, key);

    // A deleted flag leaves the SDK's snapshot, and an unknown key falls back to
    // the default — `false` — rather than keeping the last known answer forever.
    await eventually(client, key, false);
  } finally {
    client?.close();
  }
});
