/**
 * A stand-in for "someone's app that installed the SDK".
 *
 * It does what a real backend does — ask `isEnabled` per user, per request —
 * plus a 1,000-user sweep every 2s so the effect of a dashboard change is
 * visible as a number without anyone clicking anything.
 *
 * Change the flag in the dashboard and watch the count follow within
 * REFRESH_MS: no restart, no deploy, no code change here.
 *
 *   FLAGS_API_URL=https://your-api.onrender.com \
 *   FLAGS_API_KEY=<your SDK_API_KEY> \
 *   FLAG_KEY=new-checkout-flow REFRESH_MS=5000 node index.js
 *
 * Endpoints, so the same thing can be shown in a browser:
 *   GET /            the current count as JSON
 *   GET /check?userId=alice   one user's answer, the way a real request would
 */
import express from 'express';
import { close, init, isEnabled } from 'flagpilot';

const apiUrl = process.env.FLAGS_API_URL ?? 'http://localhost:4000';
const apiKey = process.env.FLAGS_API_KEY ?? 'dev-only-sdk-api-key-change-me';
const flagKey = process.env.FLAG_KEY ?? 'demo-flag';
const refreshIntervalMs = Number(process.env.REFRESH_MS ?? 5000);
const userCount = Number(process.env.USERS ?? 1000);
const port = Number(process.env.PORT ?? 3100);

const users = Array.from({ length: userCount }, (_, i) => `user_${i}`);

console.log(`[victim-app] flag '${flagKey}' via ${apiUrl}, refreshing every ${refreshIntervalMs}ms`);

// init() never throws — not even for a bad key — so a host app is never taken
// down by its flag service. It resolves to { ok, status } instead, and each app
// decides what to do. A flag service that is merely unreachable ('degraded')
// is fine: isEnabled serves defaults until a refresh succeeds. This demo
// refuses to start on a misconfiguration, because booting with every flag
// silently stuck at its default would make the demo meaningless.
const { status } = await init({ apiUrl, apiKey, refreshIntervalMs });
if (status.state === 'misconfigured' || status.state === 'unauthorized') {
  console.error(`[victim-app] cannot start: ${status.lastError}`);
  console.error('[victim-app] check FLAGS_API_URL and FLAGS_API_KEY, then try again.');
  process.exit(1);
}

/** Every call is in-process: no network, no await, microseconds each. */
function sweep() {
  const started = performance.now();
  const enabled = users.filter((userId) => isEnabled(flagKey, { userId })).length;
  return {
    flagKey,
    enabled,
    total: userCount,
    percent: Number(((enabled / userCount) * 100).toFixed(1)),
    checkedInMs: Number((performance.now() - started).toFixed(1)),
  };
}

const app = express();

app.get('/', (_req, res) => res.json(sweep()));

app.get('/check', (req, res) => {
  const userId = typeof req.query.userId === 'string' ? req.query.userId : undefined;
  if (!userId) return res.status(400).json({ error: 'pass ?userId=' });
  // What a real request handler does: one synchronous call, no await.
  res.json({ flagKey, userId, enabled: isEnabled(flagKey, { userId }) });
});

const server = app.listen(port, () => {
  console.log(`[victim-app] http://localhost:${port}  (GET / and GET /check?userId=alice)`);
});

function tick() {
  const { enabled, total, percent, checkedInMs } = sweep();
  console.log(
    `[victim-app] enabled for ${enabled} / ${total} users (${percent}%) — ${total} checks in ${checkedInMs}ms`,
  );
}

tick();
const ticker = setInterval(tick, 2000);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearInterval(ticker);
    close();
    server.close();
    console.log('\n[victim-app] stopped');
    process.exit(0);
  });
}
