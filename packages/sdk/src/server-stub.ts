import type { ClientContext, UserContext } from '@feature-flags/core';
import type { ClientStatus, FlagClient, InitResult } from './client.js';

/**
 * What `import … from 'flagpilot'` resolves to in a BROWSER bundle.
 *
 * `flagpilot` is the server SDK: it holds the secret SDK key and downloads
 * every flag's rules. Bundled into a web page, that key would be readable by
 * anyone. The package's `browser` export condition sends browser bundlers
 * (Vite, webpack, Next.js client builds, esbuild) here instead, so the mistake
 * can never transmit a key, while still compiling, so the host app does not
 * break over it.
 *
 * Every export matches the real server entry. Each logs one clear error and
 * returns the safe default. There is deliberately no fetch here, and nothing
 * that reads a key: the only imports are types, which compile away.
 *
 * Server builds — Node, and Next.js's server and server-component bundles —
 * never use the `browser` condition, so they always get the real SDK.
 */

const MESSAGE =
  '[flagpilot] `flagpilot` is the server SDK and cannot run in a browser — it needs your secret ' +
  'SDK key. Use `flagpilot/browser` or `flagpilot/react` with your public client key instead. ' +
  'If your SDK key was placed in browser code, rotate it.';

let warned = false;
function reportMisuse(): void {
  if (warned) return;
  warned = true;
  console.error(MESSAGE);
}

function stubStatus(): ClientStatus {
  return {
    state: 'misconfigured',
    hasValues: false,
    lastUpdated: null,
    lastError: 'the server SDK cannot run in a browser',
  };
}

/** @deprecated Never thrown. Present so imports of it still compile. */
export class FlagClientError extends Error {
  constructor(message: string) {
    super(`flagpilot: ${message}`);
    this.name = 'FlagClientError';
  }
}

export function createFlagClient(_config?: unknown): FlagClient {
  reportMisuse();
  return {
    init: async (): Promise<InitResult> => ({ ok: false, status: stubStatus() }),
    isEnabled: (_flagKey: string, _context?: UserContext, defaultValue?: boolean) =>
      typeof defaultValue === 'boolean' ? defaultValue : false,
    getClientFlags: () => ({}),
    signContext: async () => null,
    status: stubStatus,
    close: () => undefined,
    snapshotSize: () => 0,
  };
}

export async function init(_config?: unknown): Promise<InitResult> {
  reportMisuse();
  return { ok: false, status: stubStatus() };
}

export function isEnabled(_flagKey: string, _context?: UserContext, defaultValue?: boolean): boolean {
  reportMisuse();
  return typeof defaultValue === 'boolean' ? defaultValue : false;
}

export function getClientFlags(_context?: ClientContext): Record<string, boolean> {
  reportMisuse();
  return {};
}

export async function signContext(_context: ClientContext): Promise<string | null> {
  reportMisuse();
  return null;
}

export function getStatus(): ClientStatus {
  return stubStatus();
}

export function close(): void {
  // Nothing was started.
}
