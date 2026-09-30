# feature-flag-dashboard

Ship code dark, roll out by percentage/cohort, roll back instantly. A feature-flag
service (Express + PostgreSQL + Redis), a TypeScript client SDK, and an admin dashboard
(Next.js), managed as an npm-workspaces monorepo.

**Full requirements spec:** [../docs/SRS.md](../docs/SRS.md) — it sits in the parent folder,
alongside this one, so the link resolves in a local checkout rather than on GitHub alone.
[Requirements coverage](#requirements-coverage) maps every requirement in it to the test that
proves it.

## Architecture

```
  ┌─ writes ───────────────────────────┐   ┌─ reads ─────────────────────────┐
  │                                    │   │                                 │
  │  Admin dashboard (Next.js)         │   │  Host app                       │
  │  Server Components + Server        │   │  + flagpilot           │
  │  Actions. The JWT lives in an      │   │  isEnabled() is synchronous,    │
  │  httpOnly cookie; the browser      │   │  in-process, and never throws   │
  │  never holds it.                   │   │                                 │
  │              │ admin JWT           │   │              ▲                  │
  │                                    │   │              │ GET /api/sdk/    │
  │  Error tracker (System B —         │   │              │ flags            │
  │  not built yet)                    │   │              │ x-api-key        │
  │              │ x-integration-key   │   │              │                  │
  │              │ (disable only)      │   │              │ every            │
  └──────────────┼────────────────────-┘   └──────────────┼──────────────────┘
                 │                                        │ refreshIntervalMs
                 ▼                                        │
       ┌──────────────────────────────────────────────────┴─────────┐
       │              Flag Service API — Express 5                   │
       │                                                             │
       │   read    L1 in-process Map ─▶ L2 Redis ─▶ L3 PostgreSQL    │
       │                                            ▲ circuit        │
       │                                              breaker        │
       │   write   ONE transaction: flag row + audit row             │
       │           → commit → clear L1 + L2 → PUBLISH the key        │
       └────────┬──────────────────┬───────────────────┬─────────────┘
                ▼                  ▼                   ▼
        ┌──────────────┐  ┌──────────────────┐  ┌────────────────────┐
        │  PostgreSQL  │  │ Redis flag cache │  │ Redis Pub/Sub      │
        │  flags,      │  │ shared by every  │  │ flags:invalidate — │
        │  audit_log,  │  │ instance, 30 s   │  │ every other API    │
        │  users       │  │ TTL              │  │ instance drops its │
        │  — the truth │  └──────────────────┘  │ L1 within 2 s      │
        └──────────────┘                        └────────────────────┘
```

**The SDK never touches Redis.** It downloads whole flag configs from `/api/sdk/flags` on a
timer and evaluates them in-process with `@feature-flags/core`, so a check costs no network
at all and a consumer needs no cache credentials. `GET /api/flags/:key/evaluate` exists as a
server-side path for non-JavaScript clients and the k6 load test; it imports the same
evaluator, which is why the two can never disagree about a user.

## Prerequisites

- Node.js ≥ 20 and npm ≥ 10
- Docker (with Compose v2) — used both for the local stack and for integration tests

## Quick start

From a clean clone, the back end needs exactly this:

```sh
npm install
npm run compose:up                       # postgres + redis → migrate → seed → api
curl -i http://localhost:4000/health
```

You can log in immediately as `admin@example.com` / `change-me-please` — override with
`ADMIN_EMAIL` and `ADMIN_PASSWORD` before `compose:up`.

`npm run compose:up` is `docker compose up --build -d`. Two one-shot services run to
completion before `api` starts:

- **`migrate`** applies pending migrations. Re-running is safe; applied migrations are tracked
  in `drizzle.__drizzle_migrations`.
- **`seed`** creates the single admin. It *upserts*, so every `up` re-syncs the password to
  `ADMIN_PASSWORD` — which makes a forgotten password recoverable without SQL, but also means a
  password changed elsewhere does not survive the next `up`.

The dashboard is **not** in compose — it is a separate Next.js app, two commands:

```sh
cp packages/dashboard/.env.example packages/dashboard/.env.local
npm run dev:dashboard                    # http://localhost:3000
```

It is kept out deliberately: it is deployed to Vercel rather than self-hosted, and a container
on port 3000 would collide with the server Playwright starts for the E2E suite.

`packages/api/.env` is only needed to run the API **outside** Docker, or to run `npm run db:seed`
from the host — compose supplies its own environment. See [Environment variables](#environment-variables).

### After changing code

**Compose does not rebuild on its own.** A plain `docker compose up -d` reuses the existing
image, so the container keeps serving the previous build and your change appears to have had
no effect. After editing anything in `packages/api` or `packages/core`:

```sh
npm run compose:up          # rebuilds, then restarts
```

To confirm which build is actually running, grep the compiled output inside the container:

```sh
docker compose exec -T api grep -c "some string from your change" dist/<path>.js
```

A `0` means the image is stale. If a rebuild does not clear it, force the container onto the
new image:

```sh
docker compose up -d --force-recreate api
```

This is worth doing before any load or chaos run. During M7, `npm run compose:up` rebuilt the
image but left the container on the previous one, and the blackout test then reported the
*unfixed* numbers against what looked like a fixed build — a chaos test cannot tell you it is
measuring the wrong artifact.

(For iterating quickly, prefer `npm run dev` below: `tsx watch` picks up source changes
immediately. Use the container to verify the real artifact.)

### Running the API outside Docker

```sh
cp packages/api/.env.example packages/api/.env   # points at the compose-exposed ports on localhost
docker compose up -d postgres redis               # dependencies only — no api image to rebuild
npm run db:migrate
npm run db:seed
npm run dev                                       # tsx watch, http://localhost:4000
```

This is the loop to use while writing code: `tsx watch` reloads on every save, so there is
no rebuild step. `docker compose up -d postgres redis` is safe without `--build` because
those are stock images, not built from this repo.

The `.env` file must live in `packages/api/` (not the repo root): dotenv reads from the
working directory, and npm runs workspace scripts from inside the package. Both
`npm run dev` and `npm run db:migrate` load it; alternatively set the variables in
your shell, e.g. `DATABASE_URL=postgres://... npm run db:migrate`.

Postgres is published on **host port 5433** (not 5432) so it can coexist with a
locally installed Postgres. Inside the compose network the api still uses
`postgres:5432`. Connect DB tools to `localhost:5433`, user/password/db `flags`.

## Health endpoints

There are two, because "is the process alive" and "can it serve traffic" are different questions
and conflating them is expensive on free infrastructure.

`GET /health/live` — **always 200**, `{"status":"live"}`, queries nothing. This is what a platform
health check and a keep-alive ping should poll. Render polls every ~30 s and that cannot be turned
off; pointing it at `/health` would run a Postgres query and a Redis `PING` forever, which keeps a
scale-to-zero database (Neon's free tier) permanently awake until its monthly compute allowance is
gone — quite possibly mid-demo.

`GET /health` checks every dependency concurrently, each bounded by `HEALTH_CHECK_TIMEOUT_MS`
(2 s by default):

- **200** `{ "status": "ok", ... }` — Postgres and Redis both reachable
- **503** `{ "status": "degraded", ... }` — at least one dependency unreachable or timed out

```json
{
  "status": "degraded",
  "checks": {
    "postgres": { "status": "ok", "latencyMs": 2 },
    "redis":    { "status": "error", "latencyMs": 1, "error": "Stream isn't writeable ..." }
  }
}
```

The API process starts and stays up even when a dependency is down (NFR-04); the
health payload is how you find out which one. `/health/live` keeps answering 200 throughout —
that is the property a platform health check needs, so a cold database reads as "slow dependency"
rather than "dead service".

## API

Two credentials, deliberately separate so a client app can never change a flag:

| Credential | Header | Grants |
|---|---|---|
| Admin JWT (from `POST /api/auth/login`) | `Authorization: Bearer <token>` | Everything, including all writes |
| `SDK_API_KEY` | `x-api-key: <key>` | Read-only SDK endpoints, nothing else |
| `INTEGRATION_API_KEY` | `x-integration-key: <key>` | Disabling a flag via the alert endpoint, nothing else |

| Method | Endpoint | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/auth/login` | — | `{ email, password }` → `{ token, expiresAt, user }` |
| `POST` | `/api/flags` | admin | Create a flag → `201` |
| `GET` | `/api/flags` | admin | List live flags |
| `GET` | `/api/flags/:key` | admin | One flag |
| `PATCH` | `/api/flags/:key` | admin | Partial update (the `key` itself is immutable) |
| `DELETE` | `/api/flags/:key` | admin | Soft delete → `204` |
| `GET` | `/api/sdk/flags` | SDK key *or* admin | Flag configs for the SDK to evaluate locally |
| `GET` | `/api/flags/:key/evaluate` | SDK key *or* admin | Server-side evaluation for non-JS clients |
| `GET` | `/api/flags/:key/audit` | admin | Change history, newest first, with the actor resolved to an email |
| `POST` | `/api/integrations/alert` | `x-integration-key` | Disables a flag in response to an external alert |

Errors always use one envelope: `{ "error": { "code", "message", "details"? } }` —
`400 validation_error` / `invalid_json`, `401 unauthorized`, `404 flag_not_found`,
`409 flag_key_exists`.

```sh
TOKEN=$(curl -s -X POST localhost:4000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@example.com","password":"..."}' | jq -r .token)

curl -X POST localhost:4000/api/flags -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"key":"new-checkout-flow","name":"New checkout","rolloutPercentage":25,"enabled":true}'

curl localhost:4000/api/sdk/flags -H "x-api-key: $SDK_API_KEY"
```

### Evaluating a flag server-side

```sh
curl "localhost:4000/api/flags/new-checkout-flow/evaluate?userId=user_1&attr.plan=pro"   -H "x-api-key: $SDK_API_KEY"
# {"key":"new-checkout-flow","userId":"user_1","enabled":true,"reason":"rollout_in","bucket":12}
```

`userId` is optional (absent means anonymous) and any `attr.<name>` parameter becomes a
targeting attribute. `reason` is one of `kill_switch`, `anonymous`, `rule_match`,
`rollout_in`, `rollout_out`, or `unavailable`.

This endpoint exists for non-JavaScript clients and for the k6 load test. The JS SDK does
**not** use it — it fetches whole configs from `/api/sdk/flags` and runs the same
`@feature-flags/core` evaluator in-process, so its checks cost no network at all. Both paths
import the same module, which is why they can never disagree about a user.

Every evaluation emits one structured line for a future analytics consumer:

```json
{"event":"flag_evaluation","ts":"…","flagKey":"…","userId":"…","enabled":true,"reason":"rollout_in","bucket":12}
```

## Admin dashboard

A Next.js App Router app in `packages/dashboard`: log in, see every flag, change a rollout,
flip a kill switch, and read who changed what.

```sh
cp packages/dashboard/.env.example packages/dashboard/.env.local
npm run dev:dashboard            # http://localhost:3000
```

**The JWT never reaches the browser.** The login form posts to the dashboard's own Route
Handler, which calls the Express API server-side and stores the token in an **httpOnly**
cookie. Server Components read that cookie and forward it as an `Authorization` header — so
the browser never holds the token, and no CORS is involved. Every API call sets
`cache: 'no-store'`, because flag state must never look stale to an admin.

`proxy.ts` (Next 16's replacement for `middleware.ts`) redirects anyone without a session
before a protected page renders, so there is no flash of protected content. An *expired*
session is a separate case: the token passes the cookie check and the API returns 401, which
`lib/api.ts` turns into a redirect through `/api/logout`, clearing the cookie and explaining
why on the login page.

Mutations are Server Actions that call the API and then `revalidatePath`, so a change appears
in the list without a manual refresh. They **return** failures rather than throwing: a
duplicate key becomes an inline message on the key field with the typed input preserved, and
an unreachable API becomes an error panel rather than a blank page.

### End-to-end tests

Playwright is the dashboard's only test suite — the flows span a Route Handler, a Server
Component fetch and a Server Action, so testing those pieces in isolation would prove little.

```sh
npm run compose:up               # the API must be running
npx playwright install chromium  # one time, ~100 MB
npm run test:e2e
```

It stays out of `npm test` deliberately, so the default suite needs no dashboard and no
browser. Playwright builds and serves a production bundle rather than using `next dev`: the
dev server compiles routes on demand, which can stall a first navigation past an assertion
timeout. Set `E2E_DEV_SERVER=1` to run against the dev server while iterating on the UI.

**Private browsing works.** Incognito does not block cookies — it gives the window a fresh,
isolated cookie jar that is discarded on close, which is exactly what a session cookie needs.
A Playwright browser context *is* an incognito profile, so every one of these specs already
runs in one, and `e2e/private-browsing.spec.ts` asserts it explicitly. Only a browser
configured to block all cookies outright would fail, and that breaks every cookie-based login
on the web.

## Client SDK

`packages/sdk` is the package a host application installs. It does **not** call the API per
check: it downloads whole flag configs from `/api/sdk/flags` on a timer and evaluates each
user in-process with `@feature-flags/core` — the same module the API runs.

```ts
import { init, isEnabled } from 'flagpilot';

await init({ apiUrl: process.env.FLAGS_API_URL, apiKey: process.env.FLAGS_API_KEY });

if (isEnabled('new-checkout-flow', { userId: user.id })) { /* ... */ }
```

- `isEnabled` is **synchronous** and touches only memory — roughly a microsecond per call.
- Load on the API is proportional to **SDK instances**, not users.
- `isEnabled` **never throws**; a dead flag service means the last known configs keep
  serving, then documented defaults.
- Server-side only: the SDK key must never reach a browser.

See [packages/sdk/README.md](packages/sdk/README.md) for the full API, and
[examples/victim-app](examples/victim-app) for a runnable demo:

```sh
FLAGS_API_URL=http://localhost:4000 FLAGS_API_KEY=dev-only-sdk-api-key-change-me   FLAG_KEY=demo-flag REFRESH_MS=5000 node examples/victim-app/index.js
```

Change the flag's rollout through the API and the printed count follows within
`REFRESH_MS`, with no restart.

## Testing

Four suites. All four must pass for the project to be considered complete.

| Suite | Command | Needs | What it covers |
|---|---|---|---|
| Vitest **unit** | `npm run test:unit` | nothing | Bucketing and rule evaluation, JWT, scrypt, config parsing, the [credential guard](#credentials-and-why-the-placeholders-are-safe), the circuit breaker, SDK behaviour against a stub server |
| Vitest **integration** | `npm test` | Docker | The same, plus every route against a real Postgres and Redis via Testcontainers — cache tiers, invalidation, audit, durability, degradation |
| **Playwright** E2E | `npm run test:e2e` | API running, `npx playwright install chromium` | The dashboard's flows end to end, and one real SDK consumer observing a UI change |
| **k6** load + chaos | `npm run load:test`, `load:chaos`, `load:blackout` | stack running | NFR-FD-01 latency, NFR-FD-03 throughput, NFR-FD-04 degradation under load |

A healthy run:

```
npm run test:unit    →  api 111, core 66, sdk 69   (246 tests, 15 files)
npm test             →  api 218, core 66, sdk 69   (353 tests, 24 files)
npm run test:e2e     →  26 passed
npm run load:test    →  exit 0, every threshold green
```

`npm test` is the default gate and needs Docker, because the integration specs start real
containers — a mocked Postgres would not catch the ambiguous-column and transaction bugs these
have actually caught. Playwright stays out of `npm test` deliberately, so the default suite needs
neither a dashboard nor a browser; see [End-to-end tests](#end-to-end-tests). The k6 gates and
their measured results are in [Performance](#performance).

`npm run test:e2e` builds `core` and `sdk` first, because the consumer spec imports the SDK's
compiled output — a stale `dist` would otherwise fail in a confusing way.

## Requirements coverage

Every requirement in [../docs/SRS.md](../docs/SRS.md) §3 and §5, what implements it, and the test
that proves it. This is the table that makes "complete" checkable instead of asserted.

**On the two numbering schemes:** the SRS uses `FR-FD-nn` / `NFR-FD-nn`; the milestone notes in
`../docs/` use the shorter `FR-nn` / `NFR-nn` from the build plan. They are the same requirements
— `FR-FD-07` ≡ `FR-07` — with one exception: **`NFR-FD-05` appears only in the SRS**, so no
milestone claimed it until M8 traced the spec and gave it a test.

| SRS | Requirement | Implemented in | Proved by |
|---|---|---|---|
| FR-FD-01 | Admin creates a flag with a unique key | `services/flags/flag-service.ts` `createFlag`, partial unique index on live keys | `flags.integration.test.ts` (duplicate → 409), `durability.integration.test.ts` ("commits exactly one flag and one audit row under two concurrent creates") |
| FR-FD-02 | A flag can be toggled fully on or off | `enabled` column; `kill_switch` branch in `core/evaluate.ts` | `core/evaluate.test.ts` ("a disabled flag is false even at 100% with a matching allowlist"), `evaluate.integration.test.ts` ("honours the kill switch"), `e2e/flags.spec.ts` ("the list switch is a kill switch that persists") |
| FR-FD-03 | Percentage rollout, 0–100 | `core/evaluate.ts`; `flags_rollout_percentage_range` check constraint | `core/evaluate.test.ts` ("0% is false for everybody", "100% is true for everybody", "exclusive at the boundary"), `validation.test.ts` |
| FR-FD-04 | Targeting rules on user attributes, including an allowlist | `core/evaluate.ts` — rule matching, with case- and whitespace-insensitive attribute comparison | `core/evaluate.test.ts` ("a matching rule wins over a 0% rollout"), `core/normalize.test.ts`, `evaluate.integration.test.ts` ("applies an allowlist rule regardless of bucket", "reads attr.* parameters"), `e2e/flags.spec.ts` ("an allowlist rule round-trips through the builder") |
| FR-FD-05 | Deterministic bucketing, `hash(userId + flagKey) % 100` | `core/hash.ts` — FNV-1a plus a MurmurHash3 finalizer; frozen | `core/bucket.test.ts` ("is deterministic across 1,000 calls"), `core/golden.test.ts`, `sdk` ("uses the same hash, so a bucket is the same in both places") |
| FR-FD-06 | Audit entry per change: actor, timestamp, old and new value | `writeAudit`, inside each mutation's transaction | `audit.integration.test.ts` ("carries the before and after values of each change"), `durability.integration.test.ts` ("commits the audit row in the same transaction as the flag itself") |
| FR-FD-07 | SDK exposes `isEnabled(flagKey, userContext): boolean` | `packages/sdk/src/client.ts` | `sdk` ("is synchronous — it returns a boolean, not a promise", "returns the default before init() instead of throwing") |
| FR-FD-08 | Resolved from cache, with no network round trip per check | SDK in-memory snapshot; API's L1 → L2 → L3 tiers | `sdk` ("makes zero HTTP requests across 10,000 checks"), `cache.integration.test.ts` ("serves the next read from the in-process tier, without touching Postgres") |
| FR-FD-09 | Changes reach every SDK instance inside the NFR-FD-02 window | SDK refresh timer; Redis Pub/Sub `flags:invalidate` | `sdk` ("picks up a change made on the server (FR-09)"), **`e2e/consumer.spec.ts`** — the full chain, UI → API → a real SDK client |
| FR-FD-10 | Authentication required before a flag can be seen or changed | `middleware/auth.ts` `requireAdmin`; dashboard `proxy.ts` | `auth-middleware.test.ts`, `flags.integration.test.ts`, `e2e/auth.spec.ts` ("redirects an unauthenticated visitor to login, with no flash of the flag list") |
| FR-FD-11 | `POST /api/integrations/alert` disables a flag on an external signal | `integrations/alert.ts` | `integrations.integration.test.ts`, `e2e/integration-alert.spec.ts` |
| FR-FD-12 | Integration-created audit entries are tagged system-initiated | `SYSTEM_INTEGRATION_ACTOR` in `db/schema.ts` | `integrations.integration.test.ts`, `audit.integration.test.ts` ("labels a system-initiated change rather than showing a raw sentinel") |
| NFR-FD-01 | Evaluation latency from cache — **P99 < 5 ms** | Three-tier cache; `Server-Timing` on the route | `k6/evaluate.js` threshold `server_ms: p(99)<5`. **Observed 0.26–0.41 ms** — see [Performance](#performance) |
| NFR-FD-02 | Change propagation — **≤ 2 s** | `flags:invalidate` Pub/Sub, with a TTL as the safety net | `cache.integration.test.ts` ("drops a second instance’s in-process copy within 2s of a mutation", "refreshes a stale local copy even when the invalidation never arrives") |
| NFR-FD-03 | Throughput, single instance — **≥ 500 req/s** | — | `k6/evaluate.js` threshold on `http_reqs`. **Observed 499.6 req/s over 30,005 requests** |
| NFR-FD-04 | Configurable fail-open / fail-closed; never an unhandled crash | `FLAG_FALLBACK_POLICY`, `CacheUnavailableError`, the circuit breaker | `cache-fallback.test.ts`, `cache-chaos.integration.test.ts` ("is still alive and still answering /health"), `k6/chaos.js` (0 wrong answers), `k6/blackout.js` (0 policy violations at 500 req/s) |
| NFR-FD-05 | Durability — persisted to Postgres before a change is considered committed | One transaction per mutation (flag + audit); cache invalidation strictly **after** commit | **`durability.integration.test.ts`** — reads back through a separate pool that bypasses every cache tier, and compares `xmin` to prove one transaction wrote both rows |
| FR-INT-03 | System A disables the referenced flag on a qualifying alert | `integrations/alert.ts` → `updateFlag` | `integrations.integration.test.ts`, `e2e/integration-alert.spec.ts` |
| FR-INT-05 | Every auto-disable appears in the audit log, system-tagged | Same path; audit written in the same transaction | `integrations.integration.test.ts` ("writes exactly one audit entry when the same alert arrives twice") |

**`FR-INT-01`, `FR-INT-02` and `FR-INT-04` are System B's responsibility** — tagging an issue with
a flag key, deciding a threshold was crossed, and retrying with backoff. This side implements the
endpoint they call and is deliberately unaware of them; nothing calls it yet.

## Design decisions

- **Fail-closed** when no flag source is reachable (see below) — an outage must never switch
  unfinished features on.
- **The evaluator lives in `packages/core`**, imported by both the API and the SDK, so the
  two can never disagree about a user. The bucketing hash is frozen; changing it would
  reshuffle every user.
- **The SDK evaluates locally.** *Known simplification:* because of this, the API's
  per-evaluation log line only sees `/api/flags/:key/evaluate` traffic, not SDK evaluations.
  A future analytics service would have the SDK batch evaluation counts back to the API.
- **Soft delete** keeps audit rows valid; a partial unique index lets a deleted key be reused.
- **v1 omissions:** login rate limiting, refresh tokens, negative caching, single-flight on a
  simultaneous cache expiry (thundering herd), and a browser SDK build.

### Deviations from the SRS

Where this repo departs from [../docs/SRS.md](../docs/SRS.md), and why:

| Deviation | Why |
|---|---|
| The evaluator lives in **`packages/core`**, not `packages/api/src/services/targeting/` (§3.7) | The API and the SDK must evaluate identically, and the SDK evaluates locally. A separate package with **zero runtime dependencies** is the only way it can bundle the evaluator without dragging Express into a consumer's app |
| The **SDK does not read Redis directly**, as the §3.3 diagram shows it doing | It fetches whole configs from `/api/sdk/flags` and evaluates in-process, so a check costs no network at all and a consumer needs no cache credentials. The trade-off is a refresh-interval delay instead of instant propagation, which NFR-FD-02's 2 s window accommodates |
| Playwright lives in `packages/dashboard/**e2e**/`, not `tests/` (§3.7) | Keeps it outside the Vitest glob, so `npm test` needs no browser |
| **`CLAUDE.md` is gitignored** though §3.7 lists it at the root | It is agent instructions, not product documentation; everything a human needs is in this file |
| Extra top-level directories not in §3.7: `packages/core/`, `k6/`, `examples/victim-app/` | Consequences of the two decisions above, plus the load suite and a runnable SDK demo |
| The **dashboard is not in `docker-compose`** | It is deployed separately (Vercel), and a container on port 3000 would collide with Playwright's own server. Compose covers the back end, which is what needs orchestrating |
| **No multi-tenancy, projects or user management** | Out of scope by design: one seeded admin, one flag namespace. There is no signup flow |
| **RabbitMQ is not used**, though it appears in the wider stack | Nothing here is queue-shaped: a flag write is a single transaction that must be immediately readable. It belongs in System B, where fingerprinting and alerting genuinely are |
| Render's health check polls **`/health/live`**, not `/health` as M9's wording says | `/health` queries Postgres on every call, and Render polls every ~30 s with no way to slow it down. That would keep Neon's scale-to-zero database permanently awake and exhaust its free compute allowance. `/health` is unchanged and is still the readiness view |
| Migrations run at **container start**, not as a pre-deploy step | Render's `preDeployCommand` requires a paid instance type. The start command chains the same `migrate` entrypoint M9 asks for, and both scripts wait for the database so a cold Neon pauses the boot instead of failing the deploy |
| A **circuit breaker** on the Postgres read tier, which the SRS does not mention | Added in M7 after load testing showed a total outage was correct but 6× slower than it needed to be. See [Performance](#performance) |

## Caching and degradation

Three tiers, fastest first:

| Tier | Scope | Invalidated by |
|---|---|---|
| In-process map | One API instance | A pub/sub message, or `FLAG_CACHE_TTL_SECONDS` |
| Redis | Shared by all instances | The mutating instance deleting the key, or the same TTL |
| PostgreSQL | Source of truth | — |

A mutation writes Postgres, clears both cache tiers, and publishes the changed key on
`flags:invalidate`. Every other instance drops its in-process copy on that message, which is
how a change reaches all instances within ~2 s (NFR-02). The TTL is the safety net for a
message that never arrives: an instance can be stale for at most that long, never
indefinitely.

**Fail-closed is the documented policy** (`FLAG_FALLBACK_POLICY`). When *no* tier can answer
— Redis and Postgres both unreachable, for a flag this instance has never cached — evaluation
returns **`false`** with `reason: "unavailable"`, and HTTP **200**, never an exception. False
means users keep the behaviour the app had before the flag existed; `fail-open` would expose
every in-progress feature at 100% during an outage. `/api/sdk/flags` instead returns **503**
rather than an empty list, because `{"flags":[]}` would tell the SDK that every flag had been
deleted.

What survives a Redis outage: evaluation (served from Postgres), the SDK flag list, and
mutations. `/health` reports 503 naming Redis, and the API process stays up.

**A circuit breaker guards the Postgres read tier.** After 5 consecutive database failures,
flag reads stop attempting Postgres and fail fast for 1 s, then let exactly one request through
as a probe. Without it, a *total* outage was still correct — 200, `enabled: false`,
`reason: "unavailable"` — but every request first waited out the pool's 1.5 s connect timeout,
which capped a single instance at 238 req/s while it was down. With it, the same outage answers
in ~1 ms at the full 500 req/s. Writes are not affected: an admin save still attempts the
database and still reports a real error, because a failed save must be visible. See
[docs/milestone-7-load-and-chaos.md](../docs/milestone-7-load-and-chaos.md).

*Known simplification:* when the cached snapshot expires simultaneously on several instances
they all reload from Postgres (a thundering herd). Acceptable at this scale; single-flight is
the fix.

### Integration endpoint

An external service — the error tracker this project is designed to pair with — can switch a
flag off when it detects a problem:

```sh
curl -X POST localhost:4000/api/integrations/alert -H "x-integration-key: $INTEGRATION_API_KEY"   -H 'content-type: application/json'   -d '{"flagKey":"checkout-v2","reason":"error rate 12% over 5 minutes","source":"error-tracker"}'
# -> {"flagKey":"checkout-v2","disabled":true,"alreadyDisabled":false,"auditLogged":true}
```

The audit entry is attributed to `system:integration` and carries the reason, so the dashboard
shows not just that a flag went off but **why**. The rollout percentage is left untouched, so
re-enabling resumes where it left off.

**It is idempotent.** A caller retrying on its own timeouts gets `alreadyDisabled: true,
auditLogged: false` and no second history entry — always `200`, because a machine that retries
on non-2xx would otherwise retry forever against a flag already in the state it asked for.

**Its key is its own.** Not the admin JWT, not the SDK key. Every row this endpoint writes is
attributed to the system, so accepting a human's token would make that attribution a lie — and
this key can do nothing except switch a flag off.

Unknown or deleted flag → `404`. Missing `reason` or `source` → `400`.

### Audit log

Every create, update and delete writes an `audit_log` row — actor, action, and the
full before/after flag — **in the same transaction as the change**, so a change is
never committed without its audit entry. A PATCH that changes nothing writes no row.
Deletes are soft (`deleted_at`), so audit rows keep pointing at a real flag; the key
itself becomes reusable, because the unique index only covers live flags.

## Performance

Measured with k6, 500 req/s for 60 s, single API instance, Docker Desktop on a laptop. k6 runs
**inside the compose network** so the numbers exclude Docker's host port proxy, which on Windows
loopback adds 1-3 ms and would dominate a 5 ms budget.

The gate is on server-side handler time, which the route reports as `Server-Timing: app;dur=<ms>`;
the round-trip figure is given beside it rather than gated, because it includes the network.

| | Observed | Target |
|---|---|---|
| Throughput | **498.8 req/s** sustained, 30,005 requests | 500 req/s (NFR-03) |
| **Evaluation p99, server-side** | **0.40 ms** | < 5 ms (NFR-01) |
| Evaluation p95, server-side | 0.26 ms | |
| Round trip p95 / p99 | 1.51 ms / 3.14 ms | |
| Errors | 0.000% | |

**12x under the latency budget**, because an L1 hit is a `Map` lookup plus two `Math.imul`
chains. `FLAG_EVAL_LOG_SAMPLE_RATE` was measured rather than assumed: logging *every* evaluation
costs about **0.12 ms at p99** (0.40 ms vs 0.28 ms at 1% sampling), so the default stays at 1 —
a full evaluation log is worth 2.4% of the budget.

**Redis killed mid-run** (down for 25 s of a 60 s run at 500 req/s): 0 failed requests, p99
0.32 ms, and a correctness counter comparing a pinned user's answer against its pre-outage value
stayed at **0 wrong answers** across 30,005 requests. The in-process tier absorbed the outage
almost entirely.

**Redis and Postgres both killed**, requesting keys no tier had ever cached, so every request took
the fallback: still 500.1 req/s, still 0 failed, p99 **1.07 ms**, and every response was
`200 {"enabled":false,"reason":"unavailable"}` — 10,001 responses, zero policy violations. This is
the run that produced the circuit breaker described above; before it, the same test answered
correctly but at 238 req/s with a p99 of 1503 ms.

Reproduce any of it:

```sh
npm run compose:up
npm run load:test        # the NFR gate
npm run load:chaos       # the same load, Redis killed mid-run
npm run load:blackout    # the same load, nothing reachable at all
```

Each run exits non-zero if a threshold is crossed, so these are pass/fail gates rather than
reports. Full method, all numbers and the pass/fail criteria per step:
[docs/milestone-7-load-and-chaos.md](../docs/milestone-7-load-and-chaos.md).

## Deployment

Four free services. The API is defined as code in [`render.yaml`](render.yaml), so the deployment is
reviewable rather than a set of remembered dashboard clicks.

| Piece | Where | Notes |
|---|---|---|
| API | **Render** (Docker, free) | `render.yaml` blueprint; health check on `/health/live` |
| Postgres | **Neon** (free) | Scales to zero after ~5 min idle. Connection string needs `?sslmode=require` |
| Redis | **Upstash** (free) | `rediss://` — TLS, enabled by the scheme |
| Dashboard | **Vercel** | Root directory `packages/dashboard`, one env var: `FLAGS_API_URL` |
| SDK | **npm** — [`flagpilot`](https://www.npmjs.com/package/flagpilot) | `npm install flagpilot` |

Step-by-step instructions are in
[docs/milestone-9-deployment.md](../docs/milestone-9-deployment.md). Four things that are easy to
get wrong, and are worth knowing before you start:

**Migrations run at container start, not as a pre-deploy step.** Render's `preDeployCommand` needs a
paid instance type, so `render.yaml` chains them into the start command instead:
`node dist/db/migrate.js && node dist/db/seed.js && node dist/index.js`. Both are idempotent —
Drizzle tracks applied migrations, and `seedAdmin` upserts — and both **wait for the database first**
(`src/db/wait.ts`, up to 60 s), so a Neon instance that is asleep when a deploy lands causes a pause
rather than a failed deploy.

**Raise the connect timeouts.** The defaults (1500 ms) are right for local Docker, where connecting
is instant. A Neon cold start takes seconds and Upstash adds a cross-region TLS handshake, so at the
local defaults an ordinary cold start reads as an outage — and five of those in a row open the
[circuit breaker](#caching-and-degradation), which then fails closed on healthy infrastructure.
`render.yaml` sets `10000` / `5000` / `8000`.

**Never set `ALLOW_DEV_CREDENTIALS` in a deployment.** Leaving it unset is what makes a forgotten
secret fail the deploy loudly instead of quietly publishing an unauthenticated service. See
[Credentials](#credentials-and-why-the-placeholders-are-safe).

**Free services sleep.** Render spins a free web service down after ~15 minutes idle, and the next
request pays a cold start of up to ~50 s. Point a cron (cron-job.org or similar) at
`https://<your-api>/health/live` every 10 minutes: it keeps Render warm and, because that endpoint
touches nothing, it lets Neon sleep. Or simply warm the API by hand two minutes before a demo.

## Demo runbook

A rehearsed sequence that shows the whole system in about five minutes. **The numbers below are
real**, not illustrative: the bucketing hash is frozen, so these eight accounts land in exactly
these buckets for the flag `new-checkout-flow`, and
[`golden.test.ts`](packages/core/tests/golden.test.ts) fails if that ever stops being true.

```
carol=2  dave=32  alice=34  grace=39  frank=40  bob=41  erin=57  heidi=85
```

Set up: create a flag `new-checkout-flow`, and run the consumer somewhere visible —
ideally on a second machine, which is what makes the propagation real rather than a claim:

```sh
mkdir flagpilot-demo && cd flagpilot-demo && npm init -y && npm install flagpilot express
# copy examples/victim-app/index.js here, then:
FLAGS_API_URL=https://<your-api>.onrender.com FLAGS_API_KEY=<your SDK_API_KEY>   FLAG_KEY=new-checkout-flow REFRESH_MS=5000 node index.js
```

| # | Do this in the dashboard | What the audience sees |
|---|---|---|
| 0 | Warm the API first — hit `/health/live` and wait for 200 | A free service that is asleep makes step 1 look broken |
| 1 | Rollout **0 %**, enabled on | Nobody is in. The feature is shipped but dark |
| 2 | Rollout **10 %** | **carol** turns on, alone. One account, deterministically |
| 3 | Reload the page, twice | carol is *still* in. Same user, same bucket, every time — no random assignment |
| 4 | Rollout **50 %** | Six of the eight: carol, dave, alice, grace, frank, bob |
| 5 | Back to **10 %**, then allowlist **heidi** (`userId in [heidi]`) | carol **and heidi**. heidi's bucket is 85 — the furthest out of anyone — so this can only be the rule, not luck |
| 6 | Toggle **Enabled** off | Nobody, instantly, while the rollout still reads 10 %. This is the rollback |
| 7 | Open the flag's history | Every step above, with who did it and the before/after values |

Then the parts a dashboard cannot show:

```sh
# 8. An external service disables the flag — and does it twice, to show idempotency
curl -X POST https://<your-api>/api/integrations/alert   -H "x-integration-key: $INTEGRATION_API_KEY" -H 'content-type: application/json'   -d '{"flagKey":"new-checkout-flow","reason":"error rate 12% over 5 minutes","source":"error-tracker"}'
# -> {"disabled":true,"alreadyDisabled":false,"auditLogged":true}
# run it again:
# -> {"disabled":true,"alreadyDisabled":true,"auditLogged":false}   200, and no second history entry
```

The history now shows **System (integration)** turning the flag off, with the reason — the
error-tracking story this project is designed to pair with, and the point at which "we shipped a bug"
becomes "the system caught it and rolled itself back".

```sh
# 9. Break the cache and show it degrades rather than falls over
curl https://<your-api>/health        # 503, naming redis; /health/live is still 200
curl -H "x-api-key: $SDK_API_KEY" "https://<your-api>/api/flags/new-checkout-flow/evaluate?userId=carol"
# still answers, served from Postgres. The victim app keeps working throughout
```

Locally the same step is `docker compose stop redis`, then `docker compose start redis` to recover.
With *both* tiers down, evaluation returns `200 {"enabled":false,"reason":"unavailable"}` — the
documented fail-closed policy, measured at 500 req/s in [Performance](#performance).

## Scripts (repo root)

| Script | What it does |
|---|---|
| `npm run dev` | Start the API with `tsx watch` |
| `npm run build` | Compile every package to `dist/` |
| `npm run typecheck` | `tsc --noEmit` across packages |
| `npm test` | Vitest in every package — **includes Testcontainers integration tests (needs Docker)** |
| `npm run test:e2e` | Playwright against the dashboard; builds `core` + `sdk` first (needs the API running) |
| `npm run dev:dashboard` | Start the dashboard on :3000 |
| `npm run test:unit` | Vitest, excluding `*.integration.test.ts` |
| `npm run db:generate` | Diff `src/db/schema.ts` against `drizzle/` and emit a new SQL migration |
| `npm run db:migrate` | Apply pending migrations to `DATABASE_URL` |
| `npm run db:seed` | Create/update the single admin from `ADMIN_EMAIL` + `ADMIN_PASSWORD` |
| `npm run compose:up` / `compose:down` | Wrapper around `docker compose` |
| `npm run load:test` | k6 load test against the evaluate endpoint — the NFR-01/NFR-03 gate |
| `npm run load:chaos` | The same load with Redis stopped mid-run |
| `npm run load:blackout` | The same load with Redis *and* Postgres stopped — exercises the fallback policy |

### Schema change workflow

1. Edit `packages/api/src/db/schema.ts`.
2. `npm run db:generate` — commit the generated `drizzle/NNNN_*.sql` and `drizzle/meta/`.
3. `npm run db:migrate` locally, or `npm run compose:up` (the `migrate` service applies it).

## Repository layout

```
feature-flag-dashboard/
├── docker-compose.yml           # postgres:16, redis:7, migrate + seed (one-shot), api, k6 (profile: load)
├── render.yaml                  # Render blueprint for the API — no secret values
├── LICENSE                      # MIT; copied into packages/sdk so the npm tarball carries it
├── package.json                 # npm workspaces root
├── tsconfig.base.json
├── k6/                          # load + chaos tests (evaluate, chaos, blackout, orchestrator)
├── examples/victim-app/         # runnable SDK demo (also the M9 runbook script)
└── packages/
    ├── core/                    # @feature-flags/core — bucketing + evaluation + types, ZERO runtime deps
    ├── api/                     # Flag Service API (Express 5, Drizzle, ioredis)
    │   ├── Dockerfile           # build context = repo root
    │   ├── drizzle/             # generated SQL migrations + meta (committed)
    │   ├── src/
    │   │   ├── index.ts         # entrypoint: config → deps → listen
    │   │   ├── app.ts           # createApp(deps) — testable without a port
    │   │   ├── config.ts        # zod-validated env
    │   │   ├── auth/            # jwt.ts (hand-rolled HS256), password.ts (scrypt)
    │   │   ├── db/              # schema.ts, client.ts, migrate.ts, seed.ts, wait.ts (cold-start retry)
    │   │   ├── middleware/      # auth.ts (two credentials), errors.ts (one envelope)
    │   │   ├── routes/          # health.ts, auth.ts, flags.ts, sdk.ts, evaluate.ts
    │   │   ├── services/flags/  # flag-service.ts — the only place flag SQL lives
    │   │   ├── services/cache/  # redis.ts, flag-cache.ts (two tiers), circuit.ts (breaker on the DB tier)
    │   │   ├── validation/      # zod schemas for flag input
    │   │   ├── integrations/      # alert.ts — POST /api/integrations/alert
    │   └── tests/               # *.test.ts (unit), *.integration.test.ts (Testcontainers)
    ├── sdk/                     # flagpilot — published to npm; bundles core, local evaluation
    └── dashboard/               # Next.js App Router admin UI
        ├── app/                 # login, flags list + detail, route handlers, server actions
        ├── components/          # rule builder, audit timeline, UI primitives
        ├── lib/                 # server-only API client (holds the cookie)
        ├── proxy.ts             # auth gate (Next 16's middleware)
        └── e2e/                 # Playwright
```

`core` holds `computeBucket`, `evaluateFlag`/`evaluateFlagDetailed` and the rule types.
It exists because the SDK evaluates flags **locally** from cached configs rather
than asking the API per user — so the evaluator and rule types must be importable by
both the API and the SDK, and must carry no dependencies into a consumer's app.

## Environment variables

| Variable | Default (`packages/api/.env.example`) | Notes |
|---|---|---|
| `PORT` | `4000` | |
| `DATABASE_URL` | `postgres://flags:flags@localhost:5433/flags` | Must be a `postgres://` URL; 5433 is the compose host port |
| `REDIS_URL` | `redis://localhost:6379` | `redis://` or `rediss://` |
| `JWT_SECRET` | — (required) | Signs admin tokens; at least 32 characters |
| `JWT_EXPIRES_IN_SECONDS` | `3600` | Admin session lifetime |
| `SDK_API_KEY` | — (required) | Read-only key the SDK sends as `x-api-key`; at least 16 characters |
| `INTEGRATION_API_KEY` | — (required) | Key the alert endpoint accepts as `x-integration-key`; at least 16 characters |
| `FLAG_CACHE_TTL_SECONDS` | `30` | TTL on both cache tiers; the safety net for a missed invalidation |
| `FLAG_FALLBACK_POLICY` | `fail-closed` | `fail-closed` \| `fail-open` — what an unresolvable flag evaluates to |
| `DB_CONNECT_TIMEOUT_MS` | `1500` | Postgres connect timeout. Raise to ~`10000` for a database that scales to zero — see [Deployment](#deployment) |
| `REDIS_CONNECT_TIMEOUT_MS` | `1500` | Redis connect timeout. Raise to ~`5000` for a managed instance reached over TLS in another region |
| `HEALTH_CHECK_TIMEOUT_MS` | `2000` | Per-dependency ceiling for `/health`. Keep it above the two values above |
| `ALLOW_DEV_CREDENTIALS` | `false` | Permits the public placeholder credentials below. Set only by `docker-compose.yml`; a real deployment must never set it |
| `FLAG_EVAL_LOG_SAMPLE_RATE` | `1` | Fraction of evaluations that emit the structured log line (0-1); costs ~0.12 ms at p99 at the default |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | Read by `npm run db:seed` only, not by the running API |

### Credentials, and why the placeholders are safe

Four credential values are committed to this repository — in `packages/api/.env.example`,
`docker-compose.yml`, the k6 scripts and this README:

```
JWT_SECRET           dev-only-jwt-secret-change-me-at-least-32-chars
SDK_API_KEY          dev-only-sdk-api-key-change-me
INTEGRATION_API_KEY  dev-only-integration-key-change-me
ADMIN_PASSWORD       change-me-please
```

**They are not secrets and never were.** They exist so that a clean clone runs with no
configuration at all, which is what makes `docker compose up` a two-command start. But anyone who
can read this repo can sign an admin token with that JWT secret, so a deployment using it has no
authentication whatsoever.

So the API and the seed script **refuse to start on any of them** unless
`ALLOW_DEV_CREDENTIALS=true` is set:

```
Refusing to start: JWT_SECRET, SDK_API_KEY, INTEGRATION_API_KEY are still set to this
repository's development placeholder, which is public.
Generate real values with:
  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
Set ALLOW_DEV_CREDENTIALS=true only for a throwaway local stack.
```

`docker-compose.yml` sets it, because that stack is throwaway by design. **Nothing else should.**
A deployment that forgets to supply a real secret therefore fails loudly at boot instead of
starting up unauthenticated — the failure mode you want, rather than the silent one.

Opting in requires the exact string `true`: `ALLOW_DEV_CREDENTIALS=false` or `0` still refuses, so
the guard cannot be disabled by accident. It is covered by
[`cache-fallback.test.ts`](packages/api/tests/cache-fallback.test.ts), whose tests are mostly
about proving the guard *fails* correctly.

### Running the Docker stack on real secrets

**You never edit `docker-compose.yml` to set a secret.** Every value in it is written as
`${VAR:-public-default}`, and Compose reads `VAR` from a **`.env` file in the same directory as
`docker-compose.yml`** — automatically, with no flag — or from your shell, falling back to the
public default only when neither supplies it.

```sh
cp .env.example .env         # in feature-flag-dashboard/, next to docker-compose.yml
# fill in JWT_SECRET, SDK_API_KEY, INTEGRATION_API_KEY, ADMIN_PASSWORD
# and set ALLOW_DEV_CREDENTIALS=false
npm run compose:up
```

`.env` is gitignored, so the secrets stay out of git while `docker-compose.yml` — which is
committed — carries no real value at all.

**There are two different `.env` files, and mixing them up is the easy mistake:**

| File | Read by | Used when |
|---|---|---|
| **`./.env`** (next to `docker-compose.yml`) | Docker Compose, for `${...}` substitution | The containers — `npm run compose:up` |
| `packages/api/.env` | `dotenv`, inside the API process | The API running **on the host** — `npm run dev`, `npm run db:seed` |

Compose never reads `packages/api/.env`. Putting your real secrets only there leaves the containers
on the public defaults, silently. If you run the API both ways, maintain both files.

Two details that make a partly-filled `.env` safe rather than surprising:

- An **empty** value (`JWT_SECRET=`) counts as unset and falls back to the default, because the
  substitutions use `${VAR:-default}` and not `${VAR-default}`. So a half-completed `.env` still
  boots.
- Which is exactly why **`ALLOW_DEV_CREDENTIALS=false` is worth setting** once your values are
  real: it turns "I filled in two of the three secrets" from a silent fallback into a refusal that
  names the one you missed.

To confirm what the containers will actually receive:

```sh
docker compose config | grep -E "JWT_SECRET|SDK_API_KEY|INTEGRATION_API_KEY"
```

That prints the **resolved** values, so don't paste its output anywhere — which is also the quickest
way to prove your `.env` is being picked up.

**No real secret is tracked in this repository, and none ever has been.** Every env file is
gitignored via `.env*` with `!.env.example`, which covers the variants a deployment tends to
create (`.env.production`, `.env.test`, `.env.production.local`); Playwright's `test-results/`
(traces can contain a live session token) and `k6/results/*.json` are ignored too; and nothing
logs a credential at startup or on any request path.
