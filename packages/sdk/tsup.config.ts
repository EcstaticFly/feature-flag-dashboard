import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'node20',
  // Bundle @feature-flags/core INTO dist. It is never published, so leaving it
  // external would make `npm install @feature-flags/sdk` fail for consumers
  // with "Cannot find module '@feature-flags/core'".
  noExternal: ['@feature-flags/core'],
  // Baked in so the x-sdk-version header is correct without reading
  // package.json at runtime (which a bundled file cannot reliably locate).
  define: { __SDK_VERSION__: JSON.stringify(version) },
});
