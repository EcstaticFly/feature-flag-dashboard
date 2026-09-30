import http from 'k6/http';
import { check, fail } from 'k6';
import { Trend } from 'k6/metrics';

/**
 * Shared helpers for the load and chaos runs.
 *
 * Both scripts hit GET /api/flags/:key/evaluate — the server-side evaluation
 * path. The JavaScript SDK does not use it (it evaluates locally), so this is
 * the endpoint whose latency NFR-01 is actually about.
 */

export const API_URL = __ENV.API_URL || 'http://api:4000';
export const SDK_API_KEY = __ENV.SDK_API_KEY || 'dev-only-sdk-api-key-change-me';
export const ADMIN_EMAIL = __ENV.ADMIN_EMAIL || 'admin@example.com';
export const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || 'change-me-please';
export const FLAG_KEY = __ENV.FLAG_KEY || 'loadtest-flag';

/**
 * Handler time reported by the API as `Server-Timing: app;dur=<ms>`.
 *
 * The threshold sits on this rather than on http_req_duration because NFR-01
 * is about evaluation served from cache, not about the network path between
 * the load generator and the container.
 */
export const serverMs = new Trend('server_ms', true);

/** 10,000 ids so buckets vary and the hash is genuinely exercised. */
const USERS = Array.from({ length: 10000 }, (_, i) => `user_${i}`);

export function randomUser() {
  return USERS[Math.floor(Math.random() * USERS.length)];
}

function adminToken() {
  const res = http.post(
    `${API_URL}/api/auth/login`,
    JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    { headers: { 'content-type': 'application/json' } },
  );
  if (res.status !== 200) {
    fail(
      `login failed (${res.status}). Is the admin seeded? Run: npm run db:seed\n${res.body}`,
    );
  }
  return JSON.parse(res.body).token;
}

/**
 * Recreates the flag under test so every run starts from the same shape, then
 * warms the cache. Returns the answer for a fixed user, which the chaos run
 * pins so it can tell "slower" apart from "wrong".
 */
export function setupFlag() {
  const token = adminToken();
  const auth = { headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` } };

  http.del(`${API_URL}/api/flags/${FLAG_KEY}`, null, auth);

  const created = http.post(
    `${API_URL}/api/flags`,
    JSON.stringify({
      key: FLAG_KEY,
      name: 'Load test flag',
      enabled: true,
      rolloutPercentage: 50,
      // A targeting rule so the evaluator does real work rather than only hashing.
      targetingRules: [{ attribute: 'plan', operator: 'eq', values: ['pro'] }],
    }),
    auth,
  );
  if (created.status !== 201) fail(`could not create ${FLAG_KEY} (${created.status}): ${created.body}`);

  // Warm both cache tiers before measuring, so the first requests of the run
  // are not paying for a cold load.
  const probe = evaluate('user_1');
  if (probe.status !== 200) fail(`warm-up evaluate failed (${probe.status}): ${probe.body}`);

  return { pinnedUser: 'user_1', pinnedEnabled: JSON.parse(probe.body).enabled };
}

/** Evaluates the flag under test for a user. */
export function evaluate(userId) {
  return evaluateKey(FLAG_KEY, userId);
}

/** Evaluates an arbitrary key — the blackout run needs one nothing has cached. */
export function evaluateKey(flagKey, userId) {
  return http.get(`${API_URL}/api/flags/${flagKey}/evaluate?userId=${userId}`, {
    headers: { 'x-api-key': SDK_API_KEY },
    tags: { endpoint: 'evaluate' },
  });
}

/** Records the server-side timing and the usual correctness checks. */
export function recordAndCheck(res) {
  const timing = res.headers['Server-Timing'];
  if (timing) {
    const match = /dur=([\d.]+)/.exec(timing);
    if (match) serverMs.add(parseFloat(match[1]));
  }

  return check(res, {
    'status is 200': (r) => r.status === 200,
    'enabled is a boolean': (r) => {
      try {
        return typeof JSON.parse(r.body).enabled === 'boolean';
      } catch {
        return false;
      }
    },
  });
}

/**
 * Writes the raw summary for the write-up and prints a compact one.
 *
 * `counters` exists because a chaos run's whole point is a custom counter — and
 * a counter that only lands in the JSON is a counter nobody reads. Anything a
 * run asserts on has to be visible in the output a human looks at.
 */
export function saveSummary(
  name,
  data,
  { counters = [], title = 'results', nfr = false, target = '' } = {},
) {
  return {
    [`/scripts/results/${name}.json`]: JSON.stringify(data, null, 2),
    stdout: textSummary(data, counters, title, nfr, target),
  };
}

/** A compact summary; k6's own is verbose and hard to paste into a write-up. */
function textSummary(data, counters, title, nfr, target) {
  const m = data.metrics;
  const get = (metric, field) => (m[metric] && m[metric].values[field] != null ? m[metric].values[field] : NaN);
  const ms = (v) => (Number.isNaN(v) ? '   n/a' : `${v.toFixed(2)} ms`);

  const rule = (label) => `  ── ${label} `.padEnd(58, '─');

  return [
    '',
    rule(title),
    // The configured load, printed next to the achieved load. LOAD_RATE comes
    // from the shell, and a stale one (PowerShell keeps $env: for the session)
    // silently rescales the thresholds too — so a run at a fifth of the target
    // would pass and prove nothing. Naming the target makes that unmissable.
    ...(target ? [`  target              ${target}`] : []),
    `  requests            ${get('http_reqs', 'count')} (${get('http_reqs', 'rate').toFixed(1)}/s)`,
    `  failed              ${(get('http_req_failed', 'rate') * 100).toFixed(3)} %`,
    `  checks              ${(get('checks', 'rate') * 100).toFixed(2)} %`,
    // A missing counter prints 0, not n/a: k6 omits a counter never incremented,
    // and for these counters "never incremented" is exactly the passing result.
    ...counters.map(
      ([label, metric]) => `  ${label.padEnd(20)}${get(metric, 'count') || 0}`,
    ),
    '',
    `  server_ms      p95  ${ms(get('server_ms', 'p(95)'))}`,
    // Only the clean run is measured against NFR-01. The chaos runs allow a
    // looser budget on purpose, so labelling their p99 with the NFR would
    // invite reading a deliberately relaxed number as a missed requirement.
    `  server_ms      p99  ${ms(get('server_ms', 'p(99)'))}${nfr ? '   <- NFR-01' : ''}`,
    `  server_ms      max  ${ms(get('server_ms', 'max'))}`,
    '',
    `  round trip     p95  ${ms(get('http_req_duration', 'p(95)'))}`,
    `  round trip     p99  ${ms(get('http_req_duration', 'p(99)'))}`,
    '  ───────────────────────────────────────────────────────',
    '',
  ].join('\n');
}
