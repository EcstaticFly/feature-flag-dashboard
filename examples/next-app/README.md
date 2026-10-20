# Next.js example (App Router)

One flag, checked two ways on one page: in a **server component** with the server SDK
(`isEnabled`), and in a **client component** with `useFlag` from `flagpilot/react`. Sign in as the
demo users alice and heidi to watch the browser value follow a signed identity.

The pattern to copy into your own app:

| File | What it does |
|---|---|
| [`lib/flagpilot.server.ts`](lib/flagpilot.server.ts) | Starts the server SDK once per process; `flagBootstrap(userId)` returns `initialFlags` and a `signedContext` |
| [`app/layout.tsx`](app/layout.tsx) | A server component rendering `<FlagProvider>` with those two values |
| [`app/flag-readout.tsx`](app/flag-readout.tsx) | A client component using `useFlag` |
| [`app/page.tsx`](app/page.tsx) | A server component using `isEnabled` directly |

## Run it

The flag service must be running (`npm run compose:up` from the repo root), and the flag must have
**Available to browser SDKs** switched on in the dashboard — otherwise the browser value stays at its
default, `false`.

```sh
cp .env.example .env.local     # values match the local docker-compose stack
npm run dev                    # http://localhost:3001  (or ?flag=<key> for another flag)
```

`http://localhost:3001` is in the compose stack's `CLIENT_ALLOWED_ORIGINS`. For a deployed flag
service, add your site's origin there.

## Tests

```sh
npm run test:examples          # from the repo root: this example and vite-react
```

Playwright builds and serves the production bundle, then checks: the server-rendered HTML already has
the browser value; hydration produces no errors; heidi's signed token reaches the flag service (she
sees `false` where a visitor sees `true`); a change in the dashboard reaches the open page; the page
keeps working when the browser cannot reach the flag service; and the browser bundle contains no
server SDK code and no SDK key.
