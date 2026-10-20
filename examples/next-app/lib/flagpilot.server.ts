import 'server-only';
import { getClientFlags, init, signContext, type InitResult } from 'flagpilot';

/**
 * The server side of flagpilot, for this app.
 *
 * `import 'server-only'` makes the build fail if a client component ever
 * imports this file — the SDK key below must never reach a browser bundle.
 *
 * Next.js can evaluate a module more than once (server components, route
 * handlers, and again on every dev reload), so the init promise lives on
 * globalThis: one SDK client per process, however many times this file loads.
 */

const slot = globalThis as typeof globalThis & { __flagpilotReady?: Promise<InitResult> };

/** Starts the SDK once; resolves when the first fetch settles. Never rejects. */
export function flagsReady(): Promise<InitResult> {
  slot.__flagpilotReady ??= init({
    apiUrl: process.env.FLAGPILOT_API_URL ?? 'http://localhost:4000',
    // An empty key is not a crash: the SDK reports `misconfigured`, logs once,
    // and every flag serves its default.
    apiKey: process.env.FLAGPILOT_SDK_KEY ?? '',
    refreshIntervalMs: Number(process.env.FLAGPILOT_REFRESH_MS) || 30_000,
  });
  return slot.__flagpilotReady;
}

/**
 * Everything <FlagProvider> needs from the server for one user:
 *
 * - `initialFlags` — the browser flags' values, evaluated here, so the very
 *   first paint is already right (no flash of the default).
 * - `signedContext` — who the user is, signed with the SDK key, so the browser
 *   can prove it to the flag service but cannot change it.
 */
export async function flagBootstrap(userId: string | null): Promise<{
  initialFlags: Record<string, boolean>;
  signedContext: string | undefined;
}> {
  await flagsReady();
  const context = userId ? { userId } : {};
  return {
    initialFlags: getClientFlags(context),
    // null only if signing is impossible (bad config); the browser then asks
    // anonymously, which is safe: it can only ever see less.
    signedContext: userId ? ((await signContext(context)) ?? undefined) : undefined,
  };
}
