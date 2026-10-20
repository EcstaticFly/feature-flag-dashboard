// Runs the React tests (tests/react/*.test.tsx) against React 18.
//
// This workspace develops on React 19. Aliasing React 18 in here would not be
// a real test: react-dom and Testing Library would still find React 19. So
// this packs the package exactly as npm would publish it, installs the tarball
// with React 18 into a throwaway project outside the repository, and runs the
// same test files there. That also proves the tarball installs and resolves
// on its own.
//
//   npm run test:react18     (from packages/sdk; builds first)
//
// Needs network access for the install. Set KEEP_REACT18_DIR=1 to keep the
// project for inspection; it is always kept when a test fails.

import { execSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SDK = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REACT_18 = '18.3.1';

const sdkPackage = JSON.parse(readFileSync(join(SDK, 'package.json'), 'utf8'));
// The same test tooling as this workspace, so only React differs.
const toolRange = (name) => {
  const range = sdkPackage.devDependencies?.[name];
  if (!range) throw new Error(`${name} is not a devDependency of the SDK`);
  return `${name}@${range}`;
};

function run(command, cwd) {
  console.log(`\n$ ${command}`);
  execSync(command, { cwd, stdio: 'inherit' });
}

const work = mkdtempSync(join(tmpdir(), 'flagpilot-react18-'));
let passed = false;
try {
  const report = JSON.parse(
    execSync(`npm pack --json --pack-destination "${work}"`, { cwd: SDK, encoding: 'utf8' }),
  );
  // npm ≤ 11 prints an array; npm 12 an object keyed by package name.
  const packed = Array.isArray(report) ? report[0] : report[sdkPackage.name];
  if (!packed?.filename) throw new Error(`unexpected npm pack output: ${JSON.stringify(report).slice(0, 200)}`);
  console.log(`packed ${packed.filename} (${packed.entryCount} files) into ${work}`);

  writeFileSync(
    join(work, 'package.json'),
    JSON.stringify({ name: 'flagpilot-react18-check', private: true, type: 'module' }, null, 2),
  );
  run(
    [
      'npm install --no-audit --no-fund --save-dev',
      `./${packed.filename}`,
      `react@${REACT_18}`,
      `react-dom@${REACT_18}`,
      toolRange('@testing-library/react'),
      '@testing-library/dom@^10',
      toolRange('happy-dom'),
      toolRange('vitest'),
    ].join(' '),
    work,
  );

  // Fail loudly rather than silently testing the wrong React.
  for (const name of ['react', 'react-dom']) {
    const { version } = JSON.parse(readFileSync(join(work, 'node_modules', name, 'package.json'), 'utf8'));
    if (version !== REACT_18) throw new Error(`expected ${name}@${REACT_18}, installed ${version}`);
    console.log(`${name}@${version}`);
  }

  cpSync(join(SDK, 'tests', 'react'), join(work, 'tests', 'react'), { recursive: true });
  writeFileSync(
    join(work, 'vitest.config.mjs'),
    "export default { test: { include: ['tests/**/*.test.tsx'] } };\n",
  );
  run('npx vitest run', work);
  passed = true;
  console.log(`\nReact ${REACT_18}: all React tests passed against the packed tarball.`);
} finally {
  if (passed && !process.env.KEEP_REACT18_DIR) {
    rmSync(work, { recursive: true, force: true });
  } else {
    console.log(`\nproject kept at ${work}`);
  }
}
