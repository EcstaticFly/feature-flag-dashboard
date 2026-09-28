import { createFlagClient, FlagClientError, type FlagClient, type FlagClientConfig } from './client.js';

/**
 * @feature-flags/sdk — server-side feature flags with local evaluation.
 *
 * ```ts
 * import { init, isEnabled } from '@feature-flags/sdk';
 *
 * await init({ apiUrl: process.env.FLAGS_API_URL, apiKey: process.env.FLAGS_API_KEY });
 *
 * if (isEnabled('new-checkout-flow', { userId: user.id })) { ... }
 * ```
 *
 * Server-side only: `apiKey` must never reach a browser.
 */

export { createFlagClient, FlagClientError };
export type { FlagClient, FlagClientConfig };
// Re-exported so consumers get the context and config types without installing
// a second package — @feature-flags/core is bundled into this one.
export type { FlagConfig, TargetingRule, UserContext } from '@feature-flags/core';

import type { UserContext } from '@feature-flags/core';

let defaultClient: FlagClient | undefined;
let warnedUninitialised = false;

/**
 * Initialises the default client. Call once at startup, before serving traffic.
 *
 * Throws only for developer errors — missing config, or an API key the service
 * rejects. A flag service that is merely unreachable resolves normally: the
 * host app boots and `isEnabled` serves defaults until a refresh succeeds.
 */
export async function init(config: FlagClientConfig): Promise<void> {
  defaultClient?.close();
  const client = createFlagClient(config);
  await client.init();
  // Assigned only after a successful init, so a throw leaves no half-built
  // client behind for isEnabled to find.
  defaultClient = client;
}

/**
 * Whether a flag is on for a user. Synchronous, reads only memory, and never
 * throws: on any problem it returns `defaultValue` (default `false`).
 */
export function isEnabled(
  flagKey: string,
  context?: UserContext,
  defaultValue?: boolean,
): boolean {
  if (!defaultClient) {
    if (!warnedUninitialised) {
      warnedUninitialised = true;
      console.warn('[feature-flags] isEnabled() called before init(); returning defaults');
    }
    return defaultValue ?? false;
  }
  return defaultClient.isEnabled(flagKey, context, defaultValue);
}

/** Stops the default client's background refresh. */
export function close(): void {
  defaultClient?.close();
  defaultClient = undefined;
  warnedUninitialised = false;
}
