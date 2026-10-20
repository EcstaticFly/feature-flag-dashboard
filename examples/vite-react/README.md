# Vite + React 18 example

A single-page app — no server rendering — using `flagpilot/react`, the shape of a typical Vite
React app. Two processes:

| File | Runs | What it does |
|---|---|---|
| [`src/App.jsx`](src/App.jsx) | in the browser | `<FlagProvider>` with the **public** client key, and `useFlag` |
| [`server.mjs`](server.mjs) | on the server | Stands in for your backend: returns the signed-in user plus `signContext({ userId })`. The **SDK key** lives only here |

In your own app, the token comes from wherever your API already returns the logged-in user (a `/me`
or `/session` response): add `flagToken: await signContext({ userId: user.id })` there and pass it to
`<FlagProvider signedContext>`.

## Run it

The flag service must be running (`npm run compose:up` from the repo root), and the flag must have
**Available to browser SDKs** switched on in the dashboard.

```sh
cp .env.example .env.local   # values match the local docker-compose stack
npm run signer               # terminal 1 — http://localhost:5180
npm run dev                  # terminal 2 — http://localhost:5173  (or ?flag=<key>)
```

`VITE_`-prefixed variables are put into the browser bundle by Vite, which is why only the public
client key has that prefix; the SDK key does not, and is read only by `server.mjs`.

## Tests

```sh
npm run test:examples        # from the repo root: this example and next-app
```

Playwright builds the app (`vite build` + `vite preview`) and checks: React 18 is the only React in
the bundle; signed identities reach the flag service (heidi `false`, alice `true`, a visitor `true`);
a returning visitor gets the cached value even with the flag service unreachable; a first-time
visitor in the same situation gets defaults and a working page; everything works with storage
blocked entirely; and the bundle contains no SDK key or server SDK code.
