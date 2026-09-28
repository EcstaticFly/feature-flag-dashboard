/**
 * A stand-in for "someone's app that installed the SDK".
 *
 * It does what a real backend does — ask `isEnabled` per user, per request —
 * just 1,000 times every couple of seconds so the effect of a dashboard change
 * is visible as a number.
 *
 * Run it, then change the flag through the API and watch this count follow
 * within REFRESH_MS, with no restart and no code change here.
 *
 *   FLAGS_API_URL=http://localhost:4000 \
 *   FLAGS_API_KEY=dev-only-sdk-api-key-change-me \
 *   FLAG_KEY=demo-flag REFRESH_MS=5000 node examples/victim-app/index.js
 */
import { close, init, isEnabled } from '@feature-flags/sdk';

const apiUrl = process.env.FLAGS_API_URL ?? 'http://localhost:4000';
const apiKey = process.env.FLAGS_API_KEY ?? 'dev-only-sdk-api-key-change-me';
const flagKey = process.env.FLAG_KEY ?? 'demo-flag';
const refreshIntervalMs = Number(process.env.REFRESH_MS ?? 5000);
const userCount = Number(process.env.USERS ?? 1000);

const users = Array.from({ length: userCount }, (_, i) => `user_${i}`);

console.log(`[victim-app] flag '${flagKey}' via ${apiUrl}, refreshing every ${refreshIntervalMs}ms`);

// If the flag service is down this still resolves; isEnabled then serves
// defaults until a refresh succeeds. Only a misconfiguration throws here — a
// rejected API key, or a missing apiUrl/apiKey. This is how a real host app
// should handle that: report it in one line and refuse to start, rather than
// booting with every flag silently stuck at its default.
try {
  await init({ apiUrl, apiKey, refreshIntervalMs });
} catch (err) {
  console.error(`[victim-app] cannot start: ${err.message}`);
  console.error('[victim-app] check FLAGS_API_URL and FLAGS_API_KEY, then try again.');
  process.exit(1);
}

function tick() {
  const started = performance.now();
  // A real app calls this once per request. Every call is in-process: no
  // network, no await, microseconds each.
  const enabled = users.filter((userId) => isEnabled(flagKey, { userId })).length;
  const elapsed = (performance.now() - started).toFixed(1);

  const pct = ((enabled / userCount) * 100).toFixed(1);
  console.log(
    `[victim-app] enabled for ${enabled} / ${userCount} users (${pct}%) — ${userCount} checks in ${elapsed}ms`,
  );
}

tick();
const ticker = setInterval(tick, 2000);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    clearInterval(ticker);
    close();
    console.log('\n[victim-app] stopped');
    process.exit(0);
  });
}
