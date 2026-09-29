# feature-flag-dashboard

Ship code dark, roll out by percentage/cohort, roll back instantly. A feature-flag
service (Express + PostgreSQL + Redis), a TypeScript client SDK, and an admin dashboard
(Next.js), managed as an npm-workspaces monorepo.

## Prerequisites

- Node.js ≥ 20 and npm ≥ 10
- Docker (with Compose v2) — used both for the local stack and for integration tests

## Quick start

```sh
npm install
npm run compose:up                # builds images, then postgres + redis → migrate → api
curl -i http://localhost:4000/health

cp packages/api/.env.example packages/api/.env   # then edit the secrets
npm run db:seed                                  # creates the single admin account
```

`npm run compose:up` is `docker compose up --build -d`. Migrations run via the one-shot
`migrate` service before `api` starts; re-running is safe, because applied migrations are
tracked in `drizzle.__drizzle_migrations`.

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

A `0` means the image is stale — rebuild. (For iterating quickly, prefer `npm run dev`
below: `tsx watch` picks up source changes immediately. Use the container to verify the
real artifact.)

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

## Health endpoint

`GET /health` checks every dependency concurrently, each bounded by a 2 s timeout:

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
health payload is how you find out which one.

## API

Two credentials, deliberately separate so a client app can never change a flag:

| Credential | Header | Grants |
|---|---|---|
| Admin JWT (from `POST /api/auth/login`) | `Authorization: Bearer <token>` | Everything, including all writes |
| `SDK_API_KEY` | `x-api-key: <key>` | Read-only SDK endpoints, nothing else |

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
import { init, isEnabled } from '@feature-flags/sdk';

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

*Known simplification:* when the cached snapshot expires simultaneously on several instances
they all reload from Postgres (a thundering herd). Acceptable at this scale; single-flight is
the fix.

### Audit log

Every create, update and delete writes an `audit_log` row — actor, action, and the
full before/after flag — **in the same transaction as the change**, so a change is
never committed without its audit entry. A PATCH that changes nothing writes no row.
Deletes are soft (`deleted_at`), so audit rows keep pointing at a real flag; the key
itself becomes reusable, because the unique index only covers live flags.

## Scripts (repo root)

| Script | What it does |
|---|---|
| `npm run dev` | Start the API with `tsx watch` |
| `npm run build` | Compile every package to `dist/` |
| `npm run typecheck` | `tsc --noEmit` across packages |
| `npm test` | Vitest in every package — **includes Testcontainers integration tests (needs Docker)** |
| `npm run test:e2e` | Playwright against the dashboard (needs the API running) |
| `npm run dev:dashboard` | Start the dashboard on :3000 |
| `npm run test:unit` | Vitest, excluding `*.integration.test.ts` |
| `npm run db:generate` | Diff `src/db/schema.ts` against `drizzle/` and emit a new SQL migration |
| `npm run db:migrate` | Apply pending migrations to `DATABASE_URL` |
| `npm run db:seed` | Create/update the single admin from `ADMIN_EMAIL` + `ADMIN_PASSWORD` |
| `npm run compose:up` / `compose:down` | Wrapper around `docker compose` |

### Schema change workflow

1. Edit `packages/api/src/db/schema.ts`.
2. `npm run db:generate` — commit the generated `drizzle/NNNN_*.sql` and `drizzle/meta/`.
3. `npm run db:migrate` locally, or `npm run compose:up` (the `migrate` service applies it).

## Repository layout

```
feature-flag-dashboard/
├── docker-compose.yml           # postgres:16, redis:7, migrate (one-shot), api
├── package.json                 # npm workspaces root
├── tsconfig.base.json
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
    │   │   ├── db/              # schema.ts, client.ts, migrate.ts, seed.ts
    │   │   ├── middleware/      # auth.ts (two credentials), errors.ts (one envelope)
    │   │   ├── routes/          # health.ts, auth.ts, flags.ts, sdk.ts, evaluate.ts
    │   │   ├── services/flags/  # flag-service.ts — the only place flag SQL lives
    │   │   ├── services/cache/  # redis.ts (fail-fast client), flag-cache.ts (two tiers)
    │   │   ├── validation/      # zod schemas for flag input
    │   │   └── integrations/         (reserved — POST /api/integrations/alert)
    │   └── tests/               # *.test.ts (unit), *.integration.test.ts (Testcontainers)
    ├── sdk/                     # @feature-flags/sdk — publishable; bundles core, local evaluation
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
| `FLAG_CACHE_TTL_SECONDS` | `30` | TTL on both cache tiers; the safety net for a missed invalidation |
| `FLAG_FALLBACK_POLICY` | `fail-closed` | `fail-closed` \| `fail-open` — what an unresolvable flag evaluates to |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | Read by `npm run db:seed` only, not by the running API |
