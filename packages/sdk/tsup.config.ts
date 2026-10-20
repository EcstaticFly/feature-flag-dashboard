import { readFileSync } from 'node:fs';
import { defineConfig, type Options } from 'tsup';

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

/**
 * One package, several entry points, each built for where it runs:
 *
 *   flagpilot          server SDK            → node20
 *   (browser stub)     what `flagpilot` resolves to in browser bundles
 *
 * Further entries (flagpilot/browser, flagpilot/react) are added alongside.
 */
const shared: Options = {
  format: ['esm', 'cjs'],
  sourcemap: true,
  // Several configs build in parallel; with `clean: true` each would delete
  // the others' output. The `prebuild` script empties dist once instead.
  clean: false,
  // Bundle @feature-flags/core INTO dist. It is never published, so leaving it
  // external would make `npm install flagpilot` fail for consumers with
  // "Cannot find module '@feature-flags/core'".
  noExternal: ['@feature-flags/core'],
  // Baked in so the x-sdk-version header is correct without reading
  // package.json at runtime (which a bundled file cannot reliably locate).
  define: { __SDK_VERSION__: JSON.stringify(version) },
};

export default defineConfig([
  {
    ...shared,
    entry: { index: 'src/index.ts' },
    target: 'node20',
    platform: 'node',
    dts: true,
  },
  {
    ...shared,
    entry: { browser: 'src/browser/index.ts' },
    // Older browsers too: esbuild lowers newer syntax for the host's bundler.
    target: 'es2019',
    platform: 'browser',
    dts: true,
  },
  {
    ...shared,
    entry: { react: 'src/react/index.ts' },
    target: 'es2019',
    platform: 'browser',
    dts: true,
    // React is the host's: bundling a second copy breaks hooks ("Invalid hook call").
    external: ['react'],
    // Must be the file's first statement, for Next.js to treat it as a client
    // module. esbuild drops directives found in source when bundling, so it is
    // injected here and checked in tests/package.test.ts.
    banner: { js: '"use client";' },
  },
  {
    ...shared,
    entry: { 'server-stub': 'src/server-stub.ts' },
    target: 'es2019',
    platform: 'browser',
    // Types come from the real entry: the `types` export condition is matched
    // before `browser`, so TypeScript never looks for the stub's declarations.
    dts: false,
  },
]);
