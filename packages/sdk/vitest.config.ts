import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // .tsx for the React tests. Vitest compiles JSX with the automatic
    // runtime, so they need no `import React`.
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
