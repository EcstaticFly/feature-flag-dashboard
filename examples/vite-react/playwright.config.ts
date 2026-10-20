import { defineConfig, devices } from '@playwright/test';

/**
 * The Vite + React 18 example, end to end, against the real flag service.
 *
 * The API must already be running (`npm run compose:up` from the repo root).
 * Playwright starts the signer and a production build of the app (vite build +
 * vite preview), so the bundle under test is the one that would ship.
 */

const API_URL = process.env.FLAGS_API_URL ?? 'http://localhost:4000';
// The docker-compose development values; override for any other stack.
const SDK_API_KEY = process.env.E2E_SDK_API_KEY ?? 'dev-only-sdk-api-key-change-me';
const CLIENT_API_KEY = process.env.E2E_CLIENT_API_KEY ?? 'dev-only-client-key-public';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node server.mjs',
      url: 'http://localhost:5180/health',
      reuseExistingServer: false,
      timeout: 60_000,
      env: { FLAGPILOT_API_URL: API_URL, FLAGPILOT_SDK_KEY: SDK_API_KEY },
    },
    {
      command: 'npm run build && npm run preview',
      url: 'http://localhost:5173',
      reuseExistingServer: false,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: { VITE_FLAGPILOT_API_URL: API_URL, VITE_FLAGPILOT_CLIENT_KEY: CLIENT_API_KEY },
    },
  ],
});
