import http from 'k6/http';
import { check, fail } from 'k6';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import { adminToken, API_URL, saveSummary, SDK_API_KEY, serverMs } from './lib.js';

/**
 * The browser endpoint under load: POST /api/client/flags, the request every
 * page using flagpilot/browser or flagpilot/react makes.
 *
 * Held to the same bar as server-side evaluation (NFR-01 / NFR-03): p99 handler
 * time under 5 ms at 500 requests a second. Each request is a realistic one —
 * an allowed Origin, the public client key, and for 70% of them a signed
 * identity that the API must verify (HMAC) before evaluating 25 browser flags.
 *
 *   npm run load:client
 */

const RATE = Number(__ENV.LOAD_RATE || 500);
const DURATION = __ENV.LOAD_DURATION || '60s';
const CLIENT_API_KEY = __ENV.CLIENT_API_KEY || 'dev-only-client-key-public';
const ORIGIN = __ENV.CLIENT_ORIGIN || 'http://localhost:5173';
const FLAG_COUNT = 25;
const FLAG_KEYS = Array.from({ length: FLAG_COUNT }, (_, i) => `loadtest-client-${i}`);
const SIGNED_SHARE = 0.7;
const SETUP = { endpoint: 'setup' };

export const options = {
  summaryTrendStats: ['min', 'avg', 'med', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    client: {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 100,
      maxVUs: 400,
      gracefulStop: '5s',
    },
  },
  thresholds: {
    server_ms: ['p(99)<5'],
    http_reqs: [`rate>${RATE * 0.98}`],
    'http_req_failed{endpoint:client}': ['rate<0.001'],
    checks: ['rate==1.00'],
  },
};

/*
 * Signed contexts, exactly as the SDK's signContext() makes them:
 *   key   = HMAC-SHA256(SDK_API_KEY, "flagpilot:signed-context:v1")
 *   token = "v1." + b64url(payload) + "." + b64url(HMAC-SHA256(key, "v1." + b64url(payload)))
 * setup() proves the API accepts these before any load is applied.
 */
const SIGNING_KEY = crypto.hmac('sha256', SDK_API_KEY, 'flagpilot:signed-context:v1', 'binary');

function sign(userId) {
  const payload = encoding.b64encode(JSON.stringify({ userId }), 'rawurl');
  const signature = crypto.hmac('sha256', SIGNING_KEY, `v1.${payload}`, 'base64rawurl');
  return `v1.${payload}.${signature}`;
}

function post(body, tags) {
  return http.post(`${API_URL}/api/client/flags`, JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      'x-flagpilot-client-key': CLIENT_API_KEY,
      Origin: ORIGIN,
    },
    tags,
  });
}

export function setup() {
  const token = adminToken();
  const auth = {
    headers: { 'content-type': 'application/json', Authorization: `Bearer ${token}` },
    tags: SETUP,
  };

  for (const key of FLAG_KEYS) {
    // 404 on a fresh database; tagged as setup, so it is not a result.
    http.del(`${API_URL}/api/flags/${key}`, null, auth);
    const created = http.post(
      `${API_URL}/api/flags`,
      JSON.stringify({
        key,
        name: `Load test browser flag ${key}`,
        enabled: true,
        rolloutPercentage: 50,
        targetingRules: [{ attribute: 'userId', operator: 'in', values: ['user_1', 'user_2', 'user_3'] }],
        clientSide: true,
      }),
      auth,
    );
    if (created.status !== 201) fail(`could not create ${key} (${created.status}): ${created.body}`);
  }

  // Fail fast, and loudly, on anything that would make the run meaningless.
  const anonymous = post({}, SETUP);
  if (anonymous.status === 404) fail('POST /api/client/flags is 404: is CLIENT_API_KEY set on the API?');
  if (anonymous.status !== 200) fail(`anonymous probe failed (${anonymous.status}): ${anonymous.body}`);
  const signed = post({ signedContext: sign('user_1') }, SETUP);
  if (signed.status !== 200) {
    fail(`signed probe failed (${signed.status}): ${signed.body}. Does SDK_API_KEY match the API's?`);
  }
  if (JSON.parse(signed.body).flags[FLAG_KEYS[0]] !== true) {
    fail('user_1 is allowlisted, so the signed probe must see true — the token was not applied');
  }

  // 2,000 signed users, made once and shared with every VU.
  return { tokens: Array.from({ length: 2000 }, (_, i) => sign(`user_${i}`)) };
}

export default function (data) {
  const body =
    Math.random() < SIGNED_SHARE
      ? { signedContext: data.tokens[Math.floor(Math.random() * data.tokens.length)] }
      : {};
  const res = post(body, { endpoint: 'client' });

  const timing = res.headers['Server-Timing'];
  const match = timing && /dur=([\d.]+)/.exec(timing);
  if (match) serverMs.add(parseFloat(match[1]));

  check(res, {
    'status is 200': (r) => r.status === 200,
    'CORS allows the origin': (r) => r.headers['Access-Control-Allow-Origin'] === ORIGIN,
    'every load-test flag is a boolean': (r) => {
      try {
        const flags = JSON.parse(r.body).flags;
        return FLAG_KEYS.every((key) => typeof flags[key] === 'boolean');
      } catch {
        return false;
      }
    },
  });
}

export function teardown() {
  const token = adminToken();
  const auth = { headers: { Authorization: `Bearer ${token}` }, tags: SETUP };
  for (const key of FLAG_KEYS) http.del(`${API_URL}/api/flags/${key}`, null, auth);
}

export function handleSummary(data) {
  return saveSummary(__ENV.SUMMARY_NAME || 'client', data, {
    title: 'browser endpoint (POST /api/client/flags)',
    nfr: true,
    target: `${RATE}/s for ${DURATION}`,
    endpoint: 'client',
  });
}
