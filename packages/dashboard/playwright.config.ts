import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end coverage for the dashboard.
 *
 * These specs span a Route Handler, Server Component fetches and Server
 * Actions, so they are the dashboard's only test suite — unit-testing a Server
 * Component in isolation would prove very little.
 *
 * The Express API must already be running (`npm run compose:up`); Playwright
 * starts only the dashboard.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // the specs share one admin account and one database
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    /*
     * A production build, not `next dev`.
     *
     * The dev server compiles routes on demand, so the first navigation to a
     * route can stall for seconds and trip an assertion timeout — an
     * intermittent failure that has nothing to do with the code under test.
     * `next start` serves everything pre-built, and it is the artifact that
     * actually ships.
     *
     * Set E2E_DEV_SERVER=1 to run against `npm run dev` instead while
     * iterating on the UI.
     */
    command: process.env.E2E_DEV_SERVER ? 'npm run dev' : 'npm run build && npm run start',
    url: 'http://localhost:3000/login',
    /*
     * Only ever reuse the dev server, which hot-reloads. Reusing a running
     * production build would silently test stale code — the same trap as
     * `docker compose up -d` without `--build`.
     */
    reuseExistingServer: Boolean(process.env.E2E_DEV_SERVER),
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
