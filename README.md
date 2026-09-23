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
docker compose up --build -d      # postgres + redis → migrate (one-shot) → api
curl -i http://localhost:4000/health

cp packages/api/.env.example packages/api/.env   # then edit the secrets
npm run db:seed                                  # creates the single admin account
```

`docker compose up` runs migrations via the one-shot `migrate` service before `api`
starts. Re-running is safe: applied migrations are tracked in
`drizzle.__drizzle_migrations`, so a second run is a no-op.

### Running the API outside Docker

```sh
cp packages/api/.env.example packages/api/.env   # points at the compose-exposed ports on localhost
docker compose up -d postgres redis
npm run db:migrate
npm run dev                                       # tsx watch, http://localhost:4000
```

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
| `npm run test:unit` | Vitest, excluding `*.integration.test.ts` |
| `npm run db:generate` | Diff `src/db/schema.ts` against `drizzle/` and emit a new SQL migration |
| `npm run db:migrate` | Apply pending migrations to `DATABASE_URL` |
| `npm run db:seed` | Create/update the single admin from `ADMIN_EMAIL` + `ADMIN_PASSWORD` |
| `npm run compose:up` / `compose:down` | Wrapper around `docker compose` |

### Schema change workflow

1. Edit `packages/api/src/db/schema.ts`.
2. `npm run db:generate` — commit the generated `drizzle/NNNN_*.sql` and `drizzle/meta/`.
3. `npm run db:migrate` locally, or `docker compose up --build` (the `migrate` service applies it).

## Repository layout

```
feature-flag-dashboard/
├── docker-compose.yml           # postgres:16, redis:7, migrate (one-shot), api
├── package.json                 # npm workspaces root
├── tsconfig.base.json
└── packages/
    ├── core/                    # @feature-flags/core — shared types, ZERO runtime deps
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
    │   │   ├── routes/          # health.ts, auth.ts, flags.ts, sdk.ts
    │   │   ├── services/flags/  # flag-service.ts — the only place flag SQL lives
    │   │   ├── services/cache/  # redis.ts (fail-fast client)
    │   │   ├── validation/      # zod schemas for flag input
    │   │   └── integrations/         (reserved — POST /api/integrations/alert)
    │   └── tests/               # *.test.ts (unit), *.integration.test.ts (Testcontainers)
    ├── sdk/                     # @feature-flags/sdk — isEnabled(flagKey, userContext)
    └── dashboard/               # Next.js App Router admin UI (scaffolded in a later milestone)
```

`core` exists because the SDK evaluates flags **locally** from cached configs rather
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
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | — | Read by `npm run db:seed` only, not by the running API |
