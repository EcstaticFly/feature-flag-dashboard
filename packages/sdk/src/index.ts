import type { ClientContext, UserContext } from '@feature-flags/core';
import {
  createFlagClient,
  FlagClientError,
  type ClientState,
  type ClientStatus,
  type FlagClient,
  type FlagClientConfig,
  type InitResult,
} from './client.js';

/**
 * flagpilot — server-side feature flags with local evaluation.
 *
 * ```ts
 * import { init, isEnabled } from 'flagpilot';
 *
 * await init({ apiUrl: process.env.FLAGS_API_URL, apiKey: process.env.FLAGS_API_KEY });
 *
 * if (isEnabled('new-checkout-flow', { userId: user.id })) { ... }
 * ```
 *
 * Server-side only: `apiKey` must never reach a browser. For browsers use
 * `flagpilot/browser` or `flagpilot/react`, which take a public client key.
 *
 * Nothing here throws or rejects. `init()` resolves to `{ ok, status }`; a host
 * that wants to refuse to start without flags can check `ok` itself.
 */

export { createFlagClient, FlagClientError };
export type { ClientState, ClientStatus, FlagClient, FlagClientConfig, InitResult };
// Re-exported so consumers get the context and config types without installing
// a second package — @feature-flags/core is bundled into this one.
export type { ClientContext, FlagConfig, TargetingRule, UserContext } from '@feature-flags/core';

/**
 * The default client lives on `globalThis`, not in a module variable.
 *
 * Some frameworks load the same server code as more than one module instance —
 * Next.js can evaluate instrumentation, route handlers and server components
 * separately, and re-evaluates modules on every HMR update. With a module
 * variable, `init()` in one instance would be invisible to `isEnabled()` in
 * another, and every HMR update would start a duplicate refresh timer. One
 * shared slot means "init once anywhere, use everywhere". For a plain Node
 * server there is a single module instance, so nothing changes.
 */
const SLOT = Symbol.for('flagpilot.server.default');

interface Slot {
  [SLOT]?: FlagClient;
}

function getDefaultClient(): FlagClient | undefined {
  return (globalThis as Slot)[SLOT];
}

function setDefaultClient(client: FlagClient | undefined): void {
  (globalThis as Slot)[SLOT] = client;
}

let warnedUninitialised = false;

function warnUninitialised(call: string): void {
  if (warnedUninitialised) return;
  warnedUninitialised = true;
  console.warn(`[flagpilot] ${call} called before init(); returning defaults`);
}

/**
 * Initialises the default client. Call once at startup.
 *
 * Never rejects. A flag service that is down, or that rejects the key, still
 * lets the host boot: `isEnabled` serves defaults until a refresh succeeds, and
 * the returned `status` says why.
 */
export async function init(config: FlagClientConfig): Promise<InitResult> {
  getDefaultClient()?.close();
  const client = createFlagClient(config);
  setDefaultClient(client);
  return client.init();
}

/**
 * Whether a flag is on for a user. Synchronous, reads only memory, and never
 * throws: on any problem it returns `defaultValue` (default `false`).
 */
export function isEnabled(flagKey: string, context?: UserContext, defaultValue?: boolean): boolean {
  const client = getDefaultClient();
  if (!client) {
    warnUninitialised('isEnabled()');
    return typeof defaultValue === 'boolean' ? defaultValue : false;
  }
  return client.isEnabled(flagKey, context, defaultValue);
}

/** Browser-exposed flag values for one context — the SSR bootstrap for `flagpilot/react`. */
export function getClientFlags(context?: ClientContext): Record<string, boolean> {
  const client = getDefaultClient();
  if (!client) {
    warnUninitialised('getClientFlags()');
    return {};
  }
  return client.getClientFlags(context);
}

/** A tamper-proof identity token for the browser SDK. Resolves to null on any problem. */
export async function signContext(context: ClientContext): Promise<string | null> {
  const client = getDefaultClient();
  if (!client) {
    warnUninitialised('signContext()');
    return null;
  }
  return client.signContext(context);
}

/** The default client's status, or `idle` before init. */
export function getStatus(): ClientStatus {
  return (
    getDefaultClient()?.status() ?? { state: 'idle', hasValues: false, lastUpdated: null, lastError: null }
  );
}

/** Stops the default client's background refresh. */
export function close(): void {
  getDefaultClient()?.close();
  setDefaultClient(undefined);
  warnedUninitialised = false;
}
