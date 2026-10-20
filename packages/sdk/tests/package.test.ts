import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * Checks on the BUILT package, as a consumer's bundler resolves it.
 *
 * `npm test` builds first (pretest), so these always run there. Under a bare
 * `vitest run` without a build they are skipped, and say so.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = (file: string) => resolve(ROOT, 'dist', file);
const built = existsSync(dist('index.js')) && existsSync(dist('server-stub.js'));

/** Bundles `source` the way a consumer's bundler would, resolving `flagpilot` by name. */
async function bundle(source: string, platform: 'browser' | 'node'): Promise<string> {
  const result = await build({
    stdin: { contents: source, resolveDir: ROOT, loader: 'js' },
    bundle: true,
    platform,
    format: 'esm',
    write: false,
    logLevel: 'silent',
  });
  return result.outputFiles[0]!.text;
}

describe.skipIf(!built)('the published entry points', () => {
  // `init` is what reaches the key-handling fetch code. Importing only
  // `isEnabled` would let tree-shaking drop it, and the browser assertion
  // below would then pass for the wrong reason.
  const usesInit = `import { init, isEnabled } from 'flagpilot';
    await init({ apiUrl: 'https://flags.example', apiKey: 'k' });
    console.log(isEnabled('x'));`;

  it('resolves `flagpilot` to the real SDK for Node — the control for the browser case', async () => {
    const code = await bundle(usesInit, 'node');
    expect(code).toContain('x-api-key');
    expect(code).toContain('/api/sdk/flags');
    expect(code).not.toContain('is the server SDK and cannot run in a browser');
  });

  it('resolves `flagpilot` to the stub in a browser bundle — no key handling, no fetch', async () => {
    const code = await bundle(usesInit, 'browser');
    expect(code).toContain('is the server SDK and cannot run in a browser');
    expect(code).not.toContain('x-api-key');
    expect(code).not.toContain('/api/sdk/flags');
  });

  it('bundles @feature-flags/core inside, so consumers never need it', () => {
    for (const file of ['index.js', 'index.cjs']) {
      expect(readFileSync(dist(file), 'utf8')).not.toContain('@feature-flags/core');
    }
  });

  it('bakes the package version into the x-sdk-version header', () => {
    const { version } = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as { version: string };
    expect(readFileSync(dist('index.js'), 'utf8')).toContain(JSON.stringify(version));
  });
});

describe.skipIf(!built || !existsSync(dist('browser.js')))('flagpilot/browser', () => {
  /** Minified and gzipped, as a consumer's production build would ship it. */
  async function shippedSize(entry: string): Promise<number> {
    const { gzipSync } = await import('node:zlib');
    const result = await build({
      stdin: { contents: `export * from 'flagpilot/${entry}';`, resolveDir: ROOT, loader: 'js' },
      bundle: true,
      minify: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      external: ['react'],
      logLevel: 'silent',
    });
    return gzipSync(result.outputFiles[0]!.contents).length;
  }

  it('contains no trace of the server SDK or its secret key', () => {
    for (const file of ['browser.js', 'browser.cjs']) {
      const code = readFileSync(dist(file), 'utf8');
      expect(code).not.toContain('x-api-key');
      expect(code).not.toContain('/api/sdk/flags');
      expect(code).not.toContain('x-sdk-version');
    }
  });

  it('resolves for a browser bundle and touches no browser global at import', async () => {
    const code = await bundle(`import { createBrowserClient } from 'flagpilot/browser'; console.log(typeof createBrowserClient);`, 'browser');
    expect(code).toContain('/api/client/flags');
  });

  /*
   * Measured at 5.4 KB when written. The budget's job is to catch a regression —
   * something large getting bundled by accident — so it sits just above that.
   * Most of the weight is deliberate: specific, actionable error messages
   * ("add this origin to CLIENT_ALLOWED_ORIGINS") rather than bare status codes.
   * The evaluator itself is tree-shaken out, as the next test checks.
   */
  it('stays within its size budget: 6 KB minified + gzipped', async () => {
    expect(await shippedSize('browser')).toBeLessThanOrEqual(6 * 1024);
  });

  it('does not bundle the flag evaluator — browsers never evaluate rules', async () => {
    const code = await bundle(`export * from 'flagpilot/browser';`, 'browser');
    for (const evaluatorOnly of ['rollout_out', 'kill_switch', 'rule_match']) {
      expect(code).not.toContain(evaluatorOnly);
    }
  });
});

describe.skipIf(!built || !existsSync(dist('react.js')))('flagpilot/react', () => {
  it('starts with "use client", so Next.js treats it as a client module', () => {
    // The directive only counts as the very first statement of the file.
    expect(readFileSync(dist('react.js'), 'utf8').startsWith('"use client";')).toBe(true);
    expect(readFileSync(dist('react.cjs'), 'utf8').startsWith('"use client";')).toBe(true);
  });

  it("imports the host's React rather than bundling a copy (a second copy breaks hooks)", () => {
    const esm = readFileSync(dist('react.js'), 'utf8');
    const cjs = readFileSync(dist('react.cjs'), 'utf8');
    expect(esm).toMatch(/from "react";/);
    expect(cjs).toContain('require("react")');
    for (const code of [esm, cjs]) {
      // Strings that only exist inside React itself.
      expect(code).not.toContain('react.transitional.element');
      expect(code).not.toContain('__CLIENT_INTERNALS');
      expect(code).not.toContain('__SECRET_INTERNALS');
    }
  });

  it('contains no trace of the server SDK or its secret key', () => {
    for (const file of ['react.js', 'react.cjs']) {
      const code = readFileSync(dist(file), 'utf8');
      expect(code).not.toContain('x-api-key');
      expect(code).not.toContain('/api/sdk/flags');
      expect(code).not.toContain('x-sdk-version');
    }
  });

  /*
   * Measured at 6.1 KB when written: the browser client (5.3 KB, above) plus
   * about 0.9 KB of bindings. React itself is the host's and not counted.
   */
  it('stays within its size budget: 7 KB minified + gzipped', async () => {
    const { gzipSync } = await import('node:zlib');
    const result = await build({
      stdin: { contents: `export * from 'flagpilot/react';`, resolveDir: ROOT, loader: 'js' },
      bundle: true,
      minify: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      external: ['react'],
      logLevel: 'silent',
    });
    expect(gzipSync(result.outputFiles[0]!.contents).length).toBeLessThanOrEqual(7 * 1024);
  });
});

describe.skipIf(!built)('the browser stub, when it runs', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers every call with a safe default and logs exactly once', async () => {
    const stub = await import(dist('server-stub.js'));
    expect(stub.isEnabled('x')).toBe(false);
    expect(stub.isEnabled('x', undefined, true)).toBe(true);
    expect(stub.getClientFlags()).toEqual({});
    await expect(stub.signContext({ userId: 'u' })).resolves.toBeNull();
    await expect(stub.init({ apiUrl: 'https://x', apiKey: 'secret' })).resolves.toMatchObject({ ok: false });
    expect(stub.createFlagClient({}).isEnabled('x')).toBe(false);
    expect(stub.getStatus().state).toBe('misconfigured');
    expect(() => stub.close()).not.toThrow();
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('exports every name the real entry does, so switching never breaks an import', async () => {
    const stub = await import(dist('server-stub.js'));
    const real = await import(dist('index.js'));
    expect(Object.keys(stub).sort()).toEqual(Object.keys(real).sort());
  });
});
