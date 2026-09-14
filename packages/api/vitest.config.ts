import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration tests start real Postgres/Redis containers via Testcontainers,
    // which can take a while on first pull.
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: 'forks',
  },
});
