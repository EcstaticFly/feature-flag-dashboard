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
    ├── api/                     # Flag Service API (Express 5, Drizzle, ioredis)
    │   ├── Dockerfile           # build context = repo root
    │   ├── drizzle/             # generated SQL migrations + meta (committed)
    │   ├── src/
    │   │   ├── index.ts         # entrypoint: config → deps → listen
    │   │   ├── app.ts           # createApp(deps) — testable without a port
    │   │   ├── config.ts        # zod-validated env
    │   │   ├── db/              # schema.ts, client.ts, migrate.ts
    │   │   ├── routes/          # health.ts
    │   │   ├── services/cache/  # redis.ts (fail-fast client)
    │   │   ├── services/targeting/   (reserved)
    │   │   ├── middleware/           (reserved — auth)
    │   │   └── integrations/         (reserved — POST /api/integrations/alert)
    │   └── tests/               # *.test.ts (unit), *.integration.test.ts (Testcontainers)
    ├── sdk/                     # @feature-flags/sdk — isEnabled(flagKey, userContext)
    └── dashboard/               # Next.js App Router admin UI (scaffolded in a later milestone)
```

## Environment variables

| Variable | Default (`packages/api/.env.example`) | Notes |
|---|---|---|
| `PORT` | `4000` | |
| `DATABASE_URL` | `postgres://flags:flags@localhost:5433/flags` | Must be a `postgres://` URL; 5433 is the compose host port |
| `REDIS_URL` | `redis://localhost:6379` | `redis://` or `rediss://` |
