# flagpilot

Feature flags for your **server**, your **browser** code and **React** — one package.

```sh
npm install flagpilot
```

| Import | Runs on | Key it uses |
|---|---|---|
| `flagpilot` | Servers: Node 20+, Express, Next.js server components and route handlers | The **SDK key** — secret |
| `flagpilot/browser` | Browsers, with any framework or none | The **client key** — public |
| `flagpilot/react` | React 18 and 19: Vite, Create React App, Next.js client components | The **client key** — public |

**Nothing in this package throws.** A wrong key, a bad URL, a flag service that is down, a blocked
request — every one of them means your app keeps running on the last known values or the defaults,
with at most one console message. A flag check can never be what takes your app down.

---

## Server: `flagpilot`

Local evaluation: the SDK downloads flag configs on a timer and evaluates each user in-process, so a
check costs no network at all.

```ts
import { init, isEnabled } from 'flagpilot';

await init({
  apiUrl: process.env.FLAGS_API_URL,
  apiKey: process.env.FLAGS_API_KEY, // the SDK key: a secret, never in browser code
});

app.get('/checkout', (req, res) => {
  if (isEnabled('new-checkout-flow', { userId: req.user.id })) {
    return res.render('checkout-v2');
  }
  return res.render('checkout-v1');
});
```

```
your app ──init()──► GET /api/sdk/flags ──► in-memory snapshot
                          ▲                        │
                    every 30s                 isEnabled()  ◄── microseconds,
                                                              no network
```

- **`isEnabled` is synchronous** — no `await` at your call sites.
- **Load on the flag service is proportional to SDK instances, not users.**
- **An outage cannot break you.** The last known configs keep serving, for every user.

### `init(config): Promise<InitResult>`

Call once at startup. **Never rejects** — it resolves to `{ ok, status }`:

```ts
const { ok, status } = await init({ apiUrl, apiKey });
if (!ok) console.warn(`flags not loaded yet: ${status.state}`); // your choice what to do
```

| `status.state` | Meaning | What the SDK does |
|---|---|---|
| `idle` | `init()` has not been called yet | Serves defaults |
| `ready` | Flags loaded | Refreshes every `refreshIntervalMs` |
| `degraded` | The flag service is unreachable, or answered with an error | Serves last known values or defaults; keeps retrying |
| `unauthorized` | The key was rejected (401/403) | Logs a loud error; serves defaults; retries every 5 minutes, so a fixed key recovers without a restart |
| `misconfigured` | Missing `apiUrl`/`apiKey`, or an invalid option | Logs once; serves defaults; makes no requests |
| `closed` | `close()` was called | Serves the last values |

| Option | Default | Meaning |
|---|---|---|
| `apiUrl` | — (required) | Base URL of the flag service |
| `apiKey` | — (required) | The SDK key |
| `refreshIntervalMs` | `30000` | How often configs are refetched |
| `defaultValue` | `false` | Returned when a flag cannot be resolved |
| `requestTimeoutMs` | `2000` | Per-request timeout |
| `fetch` | global `fetch` | Injectable implementation, for tests |

### `isEnabled(flagKey, context?, defaultValue?): boolean`

Synchronous. Reads only memory. Never throws.

```ts
isEnabled('new-checkout-flow', {
  userId: user.id,                      // what the percentage bucket hashes
  attributes: { plan: user.plan },      // what targeting rules match on
});
```

`userId` must be a **stable** identifier — a database id, not an email. An email can change, which
would move that user into a different bucket and flip their experience. Without a `context`, the
flag's plain on/off state is used.

### For browser SDKs: `getClientFlags(context?)` and `signContext(context)`

```ts
import { getClientFlags, signContext } from 'flagpilot';

getClientFlags({ userId: user.id });
// → { 'new-navbar-title': true }  — only flags marked "Available to browser SDKs";
//   pass to <FlagProvider initialFlags> so the first paint is already right

await signContext({ userId: user.id });
// → 'v1.eyJ1c2VySWQiOiJ1XzEifQ.…'  — the user's identity, signed with your SDK key;
//   pass to the browser SDK as signedContext. null (never a throw) if the context is invalid.
```

The browser can present a signed context to the flag service but cannot alter it, so a visitor can
never claim to be another user.

### Also

- `getStatus()` — the current `{ state, hasValues, lastUpdated, lastError }`.
- `close()` — stops the refresh timer (which never keeps the process alive on its own anyway).
- `createFlagClient(config)` — an isolated instance with `init`, `isEnabled`, `getClientFlags`,
  `signContext`, `status` and `close`, for tests or two environments in one process.
- **Next.js:** the default client is kept on `globalThis`, so server components, route handlers and
  dev reloads share one client instead of starting several.
- **Imported in browser code by mistake?** Bundlers resolve `flagpilot` to a stub (via the `browser`
  export condition) that contains no network code and no key handling, logs one error, and returns
  defaults. Use `flagpilot/browser` or `flagpilot/react` there — and if your SDK key ever reached a
  browser, rotate it.

---

## Browser: `flagpilot/browser`

```ts
import { createBrowserClient } from 'flagpilot/browser';

const flags = createBrowserClient({
  apiUrl: 'https://flags.example.com',  // or a same-origin proxy path, e.g. '/flagpilot'
  clientKey: 'your-public-client-key',
  signedContext: tokenFromYourServer,    // from signContext(); omit for anonymous visitors
});

flags.isEnabled('new-navbar-title');    // synchronous; the default until values arrive
flags.subscribe(() => render());        // called whenever values or status change
```

The browser receives only `{ flagKey: boolean }`, evaluated by the flag service for this user, and
only for flags an admin marked *Available to browser SDKs*. Rules, percentages and allowlists never
reach it.

| Option | Default | Meaning |
|---|---|---|
| `apiUrl` | — (required) | `https://…`, `http://localhost…`, or a path on your own site |
| `clientKey` | — (required) | The flag service's public `CLIENT_API_KEY` |
| `signedContext` | — | Who the user is, as a token from your server's `signContext()` |
| `context` | — | A plain `{ userId, attributes }` — only if the flag service accepts unsigned identities |
| `initialFlags` | — | Values to start with, such as `getClientFlags()` from a server render |
| `defaultValue` | `false` | For flags with no value |
| `refreshIntervalMs` | `60000` | Clamped to 15 s – 1 h. `0`: fetch until the first success, then stop |
| `requestTimeoutMs` | `5000` | Clamped to 1 – 30 s |
| `persist` | `false` | Keep the last values in `localStorage` for instant reloads (see below) |
| `autoStart` | `true` | Start fetching on creation |
| `logLevel` | `'warn'` | `'warn'`, `'error'` or `'silent'` |

| Method | |
|---|---|
| `isEnabled(key, default?)` | The value, or the default. Synchronous |
| `getAll()` | Every value, as a frozen object that only changes identity when a value changes |
| `subscribe(listener)` | Returns an unsubscribe function. A throwing listener cannot affect the others |
| `identify({ signedContext })` / `identify({ context })` | Sign-in, sign-out, switch user. The previous user's values are dropped at once |
| `refresh()` | Fetch now |
| `ready(timeoutMs?)` | Resolves when the first fetch settles, or after the timeout (3 s) |
| `getStatus()` | `{ state, hasValues, lastUpdated, lastError }`; `state` is `idle`, `loading`, `ready`, `error`, `misconfigured` or `closed` |
| `start()` / `stop()` / `close()` | Resume / pause polling; stop for good |

All of them return or resolve — none throws or rejects.

**How it behaves:** one request at a time, with a timeout and backoff on failure; no polling while the
tab is hidden; a refresh when it becomes visible again, comes back online or is restored from the
back/forward cache, if the values are due. No `unload` listeners (they would disable the back/forward
cache). Creating a client outside a browser — during server rendering — does nothing at all.

**Private windows and blocked storage:** no cookies are sent and nothing is required from storage, so
it works the same in a normal window, a private one, or with storage disabled. With `persist: true`
the last values are saved per user (tagged with a hash of the identity, so never shown to anyone
else) and ignored after 7 days; if storage is unavailable, persistence is silently skipped.

**Content Security Policy:** add the flag service to `connect-src`, or use a same-origin proxy path.

---

## React: `flagpilot/react`

```tsx
import { FlagProvider, useFlag } from 'flagpilot/react';

export function Root() {
  return (
    <FlagProvider
      apiUrl="https://flags.example.com"
      clientKey="your-public-client-key"
      signedContext={session?.flagToken}     // from your server's signContext()
    >
      <App />
    </FlagProvider>
  );
}

function Navbar() {
  const newTitle = useFlag('new-navbar-title');   // false until known; re-renders when it changes
  return <h1>{newTitle ? 'New title' : 'Old title'}</h1>;
}
```

| | |
|---|---|
| `<FlagProvider apiUrl clientKey signedContext? context? initialFlags? options?>` | Put it once, near the root. `options`: `refreshIntervalMs`, `requestTimeoutMs`, `persist`, `defaultValue`, `logLevel` |
| `useFlag(key, default?)` | The flag's value. A component re-renders only when *its* flag changes |
| `useFlags()` | Every value |
| `useFlagStatus()` | `{ state, hasValues, lastUpdated, lastError }` — for a spinner or a diagnostic |
| `useFlagClient()` | The underlying browser client, for `refresh()` or `ready()`; `null` outside a provider |

- **Changing user** — pass a new `signedContext` (or `context`). The previous user's values are
  dropped immediately and the new user's are fetched. A new-but-equal `context` object on every
  render does not refetch.
- **Never throws.** A hook outside a provider returns the default and warns once; a provider with a
  bad config still renders its children.
- **Strict Mode safe** — mount, unmount, mount makes one request, not two.
- **Server rendering safe** — the module ships with `"use client"`, renders `initialFlags` (or
  defaults) on the server, and hydrates without a mismatch before applying newer values.
  `initialFlags` is read at mount only.

### Next.js App Router

```tsx
// app/layout.tsx — a server component
import { getClientFlags, init, signContext } from 'flagpilot';
import { FlagProvider } from 'flagpilot/react';

// examples/next-app keeps this promise on globalThis, so dev reloads reuse one client.
const ready = init({ apiUrl: process.env.FLAGPILOT_API_URL!, apiKey: process.env.FLAGPILOT_SDK_KEY! });

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  await ready;
  const user = await getCurrentUser();                // your auth
  const context = user ? { userId: user.id } : {};
  return (
    <html lang="en">
      <body>
        <FlagProvider
          apiUrl={process.env.FLAGPILOT_API_URL!}
          clientKey={process.env.FLAGPILOT_CLIENT_KEY!}
          initialFlags={getClientFlags(context)}      // right on the first paint
          signedContext={user ? (await signContext(context)) ?? undefined : undefined}
        >
          {children}
        </FlagProvider>
      </body>
    </html>
  );
}
```

Client components use `useFlag`; server components call `isEnabled` directly. Keep the SDK key in a
server-only module (`import 'server-only'`) and never prefix it `NEXT_PUBLIC_`.

---

## Requirements

- Server: Node 20+ (it uses the global `fetch` and Web Crypto).
- Browser: any browser from the last several years (the build targets ES2019).
- React: 18 or 19, as an optional peer dependency — server-only users never need it.
- ESM and CommonJS builds, with TypeScript types for every entry point. No runtime dependencies.
