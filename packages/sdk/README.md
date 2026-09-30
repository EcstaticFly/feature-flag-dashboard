# flagpilot

Server-side feature flags with **local evaluation**: no network call per check.

```ts
import { init, isEnabled } from 'flagpilot';

await init({
  apiUrl: process.env.FLAGS_API_URL,
  apiKey: process.env.FLAGS_API_KEY,
});

app.get('/checkout', (req, res) => {
  if (isEnabled('new-checkout-flow', { userId: req.user.id })) {
    return res.render('checkout-v2');
  }
  return res.render('checkout-v1');
});
```

> **Server-side only.** `apiKey` must never reach a browser. Evaluate on your
> backend and send the *result* to the client.

## How it works

The SDK downloads whole flag **configs** on a timer and evaluates each user
in-process. It does not ask the service per check.

```
your app ──init()──► GET /api/sdk/flags ──► in-memory snapshot
                          ▲                        │
                    every 30s                 isEnabled()  ◄── microseconds,
                                                              no network
```

Consequences worth knowing:

- **`isEnabled` is synchronous** — no `await` at your call sites.
- **Load on the flag service is proportional to SDK instances, not users.** Ten
  users or ten million, it is one small request per refresh interval.
- **An outage cannot break you.** If the service is unreachable the last known
  configs keep serving, for every user, including ones seen for the first time.

## API

### `init(config): Promise<void>`

Call once at startup. The only async call.

It **throws** only for developer errors: missing `apiUrl`/`apiKey`, an invalid
interval, or an API key the service rejects (401/403). A misconfigured deploy
should fail loudly where you will see it.

It **resolves** when the service is merely unreachable — network error, timeout,
5xx, or a malformed body. Your app boots; `isEnabled` serves defaults until a
refresh succeeds.

| Option | Default | Meaning |
|---|---|---|
| `apiUrl` | — (required) | Base URL of the flag service |
| `apiKey` | — (required) | The read-only SDK key |
| `refreshIntervalMs` | `30000` | How often configs are refetched |
| `defaultValue` | `false` | Returned when a flag cannot be resolved |
| `requestTimeoutMs` | `2000` | Per-request timeout for the refresh |
| `fetch` | global `fetch` | Injectable implementation, for tests |

### `isEnabled(flagKey, context?, defaultValue?): boolean`

Synchronous. Reads only memory. **Never throws.**

```ts
isEnabled('new-checkout-flow', {
  userId: user.id,                      // what the percentage bucket hashes
  attributes: { plan: user.plan },      // what targeting rules match on
});
```

`userId` must be a **stable** identifier — a database id, not an email. An email
can change, which would move that user into a different bucket and flip their
experience.

Returns `defaultValue` (falling back to the client's `defaultValue`, then
`false`) when the flag is unknown, when `init` has not run, or if anything at
all goes wrong internally.

Omitting `context` evaluates the flag anonymously: the flag's plain on/off state
is used, ignoring percentage and targeting.

### `close(): void`

Stops the background refresh. The refresh timer is `unref`'d, so it never keeps
your process alive on its own — `close()` is for orderly shutdown and tests.

### `createFlagClient(config): FlagClient`

Returns an isolated instance with the same `init` / `isEnabled` / `close`, for
tests or when one process needs two clients (say, staging and production keys).
The module-level functions are a thin wrapper over one default instance.

## Resilience guarantees

| Situation | What happens |
|---|---|
| Flag service down at `init()` | `init()` resolves, warns once, defaults served |
| Flag service dies later | Last known configs keep serving, **for all users** |
| Refresh returns 500 / bad JSON / times out | Previous snapshot kept, one warning per outage |
| Unknown flag key | `defaultValue`, warned once per key |
| `isEnabled` before `init()` | `defaultValue`, warned once |
| Internal error anywhere | `defaultValue` — never an exception into your request path |

Warnings are deliberately deduplicated: a service down for an hour logs once,
not once per refresh.

## Requirements

Node 20+ (uses global `fetch`). Ships ESM and CommonJS builds.
