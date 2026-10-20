import { defineConfig, devices } from '@playwright/test';

/**
 * The Next.js example, end to end, against the real flag service.
 *
 * The API must already be running (`npm run compose:up` from the repo root).
 * Playwright starts only this app, as a production build — the artifact that
 * ships, and the only way to check what actually lands in the browser bundle.
 */

const API_URL = process.env.FLAGS_API_URL ?? 'http://localhost:4000';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run build && npm run start',
    url: 'http://localhost:3001',
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      FLAGPILOT_API_URL: API_URL,
      // The docker-compose development values; override for any other stack.
      FLAGPILOT_SDK_KEY: process.env.E2E_SDK_API_KEY ?? 'dev-only-sdk-api-key-change-me',
      FLAGPILOT_CLIENT_KEY: process.env.E2E_CLIENT_API_KEY ?? 'dev-only-client-key-public',
      // So a flag created by a test reaches the server SDK within a second.
      FLAGPILOT_REFRESH_MS: '1000',
    },
  },
});
