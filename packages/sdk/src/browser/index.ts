/**
 * flagpilot/browser — feature flags for code running in a web page.
 *
 * ```ts
 * import { createBrowserClient } from 'flagpilot/browser';
 *
 * const flags = createBrowserClient({
 *   apiUrl: 'https://flags.example.com',
 *   clientKey: 'your public CLIENT_API_KEY',
 *   signedContext: tokenFromYourServer, // optional: who the user is
 * });
 *
 * if (flags.isEnabled('new-checkout-flow')) { ... }
 * ```
 *
 * The browser never receives a rule, a percentage or an allowlist — only the
 * on/off answer for this user, for flags an admin made available to browsers.
 * The key is public by design. To say who the user is, pass a `signedContext`
 * produced by the server SDK's `signContext()`.
 *
 * Nothing here throws or rejects, and nothing runs at import: it is safe in
 * server rendering, and a failure of the flag service can only ever mean
 * last-known values, then defaults.
 */

export {
  CLIENT_FLAGS_PATH,
  createBrowserClient,
  type BrowserClientConfig,
  type BrowserClientState,
  type BrowserClientStatus,
  type BrowserContext,
  type BrowserFlagClient,
  type BrowserIdentity,
} from './client.js';
