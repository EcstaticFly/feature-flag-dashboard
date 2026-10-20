// Pre-publish smoke test: the packed tarball, installed the way users will
// install it, in throwaway projects outside this repository — so nothing can
// be resolved through the workspace by accident.
//
//   npm run test:tarball     (from packages/sdk; builds first; needs network)
//
// 1. Node, no React: ESM and CommonJS imports of `flagpilot`, `flagpilot/browser`
//    in a server render, and the never-throw contract against a dead URL.
// 2. A Vite + React 18 app (examples/vite-react's source): builds, with one
//    React, the browser client, and no server SDK code.
// 3. A Next.js App Router app (examples/next-app's source): builds; the client
//    bundle has the browser client only, the server bundle the real SDK.
//
// Set KEEP_SMOKE_DIR=1 to keep the projects; they are always kept on failure.

import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SDK = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(SDK, '..', '..');
const sdkPackage = JSON.parse(readFileSync(join(SDK, 'package.json'), 'utf8'));
const nextRange = JSON.parse(readFileSync(join(REPO, 'examples', 'next-app', 'package.json'), 'utf8')).dependencies.next;

const work = mkdtempSync(join(tmpdir(), 'flagpilot-smoke-'));
let passed = false;

function run(command, cwd) {
  console.log(`\n$ ${command}`);
  execSync(command, { cwd, stdio: 'inherit' });
}

function output(command, cwd) {
  return execSync(command, { cwd, encoding: 'utf8' });
}

function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok  ${message}`);
}

function project(name, files = {}) {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `smoke-${name}`, private: true, type: 'module' }, null, 2));
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  return dir;
}

function readTree(dir, extension) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(extension)) out.push(readFileSync(path, 'utf8'));
    }
  };
  walk(dir);
  return out.join('\n');
}

try {
  const report = JSON.parse(output(`npm pack --json --pack-destination "${work}"`, SDK));
  const packed = Array.isArray(report) ? report[0] : report[sdkPackage.name];
  const tarball = join(work, packed.filename);
  console.log(`packed ${packed.filename}: ${packed.entryCount} files, ${packed.size} bytes`);
  const files = packed.files.map((f) => f.path);
  check(files.includes('CHANGELOG.md') && files.includes('README.md') && files.includes('LICENSE'), 'tarball carries README, CHANGELOG and LICENSE');
  check(!files.some((f) => /^(src|tests|e2e|scripts)\//.test(f)), 'tarball carries no sources, tests or scripts');

  // ---- 1. Node, no React ----------------------------------------------------
  const node = project('node', {
    'esm.mjs': `
import { init, isEnabled, getClientFlags, signContext, getStatus, close } from 'flagpilot';
import { createBrowserClient } from 'flagpilot/browser';
const result = await init({ apiUrl: 'http://127.0.0.1:9', apiKey: 'smoke-key-1234567890', requestTimeoutMs: 500 });
const token = await signContext({ userId: 'u1' });
const browser = createBrowserClient({ apiUrl: 'https://flags.example.com', clientKey: 'public-key-123', initialFlags: { x: true } });
console.log(JSON.stringify({ ok: result.ok, state: getStatus().state, checked: isEnabled('x'), client: getClientFlags({ userId: 'u1' }), token: token.split('.')[0], ssr: browser.isEnabled('x'), ssrState: browser.getStatus().state }));
close();
`,
    'cjs.cjs': `
const { isEnabled, createFlagClient } = require('flagpilot');
const { createBrowserClient } = require('flagpilot/browser');
const bad = createFlagClient({});
console.log(JSON.stringify({ checked: isEnabled('x', undefined, true), bad: bad.status().state, browser: typeof createBrowserClient }));
`,
  });
  run(`npm install --no-audit --no-fund "${tarball}"`, node);
  check(!readdirSync(join(node, 'node_modules')).includes('react'), 'installing without React pulls in no React (optional peer)');
  const esm = JSON.parse(output('node esm.mjs', node).trim().split('\n').pop());
  check(esm.ok === false && esm.state === 'degraded', `init() against a dead URL resolves, state "${esm.state}" — no throw`);
  check(esm.checked === false && JSON.stringify(esm.client) === '{}', 'isEnabled / getClientFlags serve defaults');
  check(esm.token === 'v1', 'signContext works from the tarball (Web Crypto)');
  check(esm.ssr === true && esm.ssrState === 'idle', 'flagpilot/browser in Node: serves initialFlags, does nothing else');
  const cjs = JSON.parse(output('node cjs.cjs', node).trim().split('\n').pop());
  check(cjs.checked === true && cjs.bad === 'misconfigured' && cjs.browser === 'function', 'CommonJS: both entries load; bad config is a status, not a throw');

  // ---- 2. Vite + React 18 ---------------------------------------------------
  const vite = project('vite-react');
  for (const entry of ['index.html', 'vite.config.js', 'src']) {
    cpSync(join(REPO, 'examples', 'vite-react', entry), join(vite, entry), { recursive: true });
  }
  run(`npm install --no-audit --no-fund "${tarball}" react@18.3.1 react-dom@18.3.1 vite@^5.4.21 @vitejs/plugin-react@^4.7.0`, vite);
  run('npx vite build --logLevel warn', vite);
  const viteCode = readTree(join(vite, 'dist', 'assets'), '.js');
  check(viteCode.includes('/api/client/flags'), 'Vite: the browser client is in the bundle');
  check(viteCode.includes('"18.3.1"') && !viteCode.includes('react.transitional.element'), 'Vite: exactly one React, version 18');
  check(!viteCode.includes('x-api-key') && !viteCode.includes('/api/sdk/flags'), 'Vite: no server SDK code');

  // ---- 3. Next.js App Router ------------------------------------------------
  const next = project('next-app');
  for (const entry of ['app', 'lib', 'next.config.ts', 'tsconfig.json']) {
    cpSync(join(REPO, 'examples', 'next-app', entry), join(next, entry), { recursive: true });
  }
  run(
    `npm install --no-audit --no-fund "${tarball}" next@${nextRange} react@^19 react-dom@^19 typescript@^5 @types/react@^19 @types/react-dom@^19 @types/node@^22`,
    next,
  );
  run('npx next build', next);
  const clientCode = readTree(join(next, '.next', 'static'), '.js');
  const serverCode = readTree(join(next, '.next', 'server'), '.js');
  check(clientCode.includes('/api/client/flags'), 'Next: the browser client is in the client bundle ("use client" honoured)');
  check(!clientCode.includes('x-api-key') && !clientCode.includes('/api/sdk/flags'), 'Next: no server SDK code in the client bundle');
  check(serverCode.includes('/api/sdk/flags') && !serverCode.includes('is the server SDK and cannot run in a browser'), 'Next: the server bundle has the real SDK, not the stub');

  passed = true;
  console.log(`\nflagpilot@${sdkPackage.version}: the packed tarball works in Node (ESM + CJS), Vite + React 18, and Next.js.`);
} finally {
  if (passed && !process.env.KEEP_SMOKE_DIR) rmSync(work, { recursive: true, force: true });
  else console.log(`\nprojects kept at ${work}`);
}
