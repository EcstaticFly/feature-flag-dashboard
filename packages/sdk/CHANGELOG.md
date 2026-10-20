# Changelog

## 0.2.0

Feature flags in the browser and in React, from the same package.

### Added

- **`flagpilot/browser`** — `createBrowserClient()`, a framework-free browser client. It uses the
  flag service's public client key and receives only on/off values, for flags marked *Available to
  browser SDKs*; rules and allowlists never reach the browser. Works the same in normal and private
  windows and with storage blocked; optional `persist` cache.
- **`flagpilot/react`** — `<FlagProvider>`, `useFlag`, `useFlags`, `useFlagStatus`,
  `useFlagClient`. React 18 and 19, Strict Mode and server-rendering safe, ships with
  `"use client"` for Next.js. React is an optional peer dependency.
- **Server:** `getClientFlags(context)` — browser flags' values for a server-rendered first paint;
  `signContext(context)` — a signed identity token for the browser SDKs; `getStatus()`; and
  `status()` on clients made with `createFlagClient`.
- A `browser` export condition: imported into a browser bundle, `flagpilot` resolves to a stub with
  no network code and no key handling, which logs one error and returns defaults.
- The default server client lives on `globalThis`, so Next.js server components, route handlers and
  dev reloads share one client.

### Changed — please read

- **`init()` never throws or rejects.** It resolves to `{ ok, status }`. Before, a rejected key
  (401/403) or a bad config made it throw; now the SDK logs the problem, serves defaults, and — for
  a rejected key — retries every 5 minutes, so a fixed key recovers without a restart. If your
  startup code relied on `init()` throwing, check `ok` or `status.state` instead:

  ```ts
  const { ok, status } = await init(config);
  if (status.state === 'unauthorized' || status.state === 'misconfigured') { /* … */ }
  ```

- **`createFlagClient()` never throws** on a bad config; it returns a client whose `status().state`
  is `misconfigured` and which serves defaults without making requests.
- `FlagClientError` is still exported, so existing `instanceof` checks compile, but nothing throws it.

### Compatibility

- Flag services running the 0.1.0-era API keep working with this version's server SDK, and 0.1.0
  keeps working against the new API.
- The browser and React entry points need a flag service with the browser endpoint enabled
  (`CLIENT_API_KEY`, `CLIENT_ALLOWED_ORIGINS`).

## 0.1.0

First release: the server SDK — `init`, `isEnabled`, `close`, `createFlagClient` — with local
evaluation from cached configs.
