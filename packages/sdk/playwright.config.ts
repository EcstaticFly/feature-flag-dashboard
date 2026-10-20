import { defineConfig, devices } from '@playwright/test';

/**
 * flagpilot/browser in real browsers — Chromium, Firefox and WebKit (Safari's
 * engine) — against the real API from docker-compose, with real CORS.
 *
 * Needs: `npm run compose:up`, a built SDK (`npm run build`), and once,
 * `npx playwright install chromium firefox webkit`.
 *
 * Every Playwright context is an isolated, ephemeral profile: the automatable
 * equivalent of a private window. The specs also cover a profile whose
 * storage persists across reloads, and one where storage is blocked outright.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  // The specs share flags in one database.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 45_000,
  use: {
    baseURL: 'http://localhost:5174',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'node e2e/fixture-server.mjs',
    url: 'http://localhost:5174/health',
    // Always a fresh fixture process: a reused one could be serving an old build.
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
