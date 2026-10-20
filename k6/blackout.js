import { check } from 'k6';
import exec from 'k6/execution';
import { Counter } from 'k6/metrics';
import { evaluateKey, saveSummary, serverMs, FLAG_KEY } from './lib.js';

/**
 * Total outage: Redis AND Postgres both down, under load.
 *
 * The Redis-only run proves graceful degradation — Postgres still answers, so
 * the fail-closed policy never actually fires. This one takes away every tier
 * so the policy itself is exercised at 500 req/s rather than in a quiet unit
 * test, which is what the milestone asks for.
 *
 * It requests keys the cache has never seen, because a cached flag would keep
 * being served correctly from L1 and would never reach the fallback path.
 *
 * The orchestrator runs this ONLY while both services are stopped, so every
 * request here is expected to take the fallback.
 */

const RATE = Number(__ENV.LOAD_RATE || 500);
const DURATION = __ENV.LOAD_DURATION || '20s';

/*
 * The first moments of an outage are spent learning about it: the breaker opens
 * only after 5 consecutive database failures, and every request that arrives
 * before those 5 have failed waits for them. How long that takes is not this
 * code's to decide — with the postgres container stopped, its hostname stops
 * resolving and Docker forwards the lookup to the host's own DNS, measured at
 * 45-77 ms per lookup on one machine and far less on another. One run saw the
 * breaker open 230 ms in; at 500 req/s that is ~115 slow requests, 1.15% of a
 * 20 s run, enough to move p99 to 228 ms with every answer still correct.
 *
 * So the gate is split. Requests in the first DETECT_WINDOW_MS are tagged
 * `detect` and only bounded (no request may hang); everything after is
 * `steady`, held to the strict p99 — which is where losing the breaker shows:
 * without it, every request pays a lookup and a connect attempt.
 */
const DETECT_WINDOW_MS = Number(__ENV.DETECT_WINDOW_MS || 3000);

/** Anything that was not the documented fail-closed answer. */
const policyViolations = new Counter('policy_violations');

export const options = {
  summaryTrendStats: ['min', 'avg', 'med', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    blackout: {
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
    // NFR-04: never an exception, never a 5xx, however broken the back end is.
    'http_req_failed{endpoint:evaluate}': ['rate<0.001'],
    checks: ['rate==1.00'],
    policy_violations: ['count==0'],
    // The thresholds the circuit breaker exists to satisfy. Before it, this run
    // answered correctly but took 1503 ms per request and could only absorb
    // 238 req/s of the 500 asked for: a total outage degraded throughput as well
    // as latency. 25 ms is loose next to the observed ~1 ms, because the
    // breaker's once-per-second recovery probe does pay a lookup and a connect
    // attempt — but it is tight enough that losing the breaker fails here.
    'server_ms{phase:steady}': ['p(99)<25'],
    // While the outage is being detected (see DETECT_WINDOW_MS): bounded, not
    // fast. A request can wait for a pool slot and a connect attempt, both
    // capped by DB_CONNECT_TIMEOUT_MS (1500 ms in compose); 3000 ms means no
    // request ever hangs past that.
    'server_ms{phase:detect}': ['max<3000'],
    http_reqs: [`rate>${RATE * 0.98}`],
  },
};

export default function () {
  // A key this instance has never cached, so no tier can answer it.
  // Digits only: the slug pattern forbids underscores, and an invalid key is
  // rejected with a 400 before any cache tier is consulted — which would make
  // this test measure validation instead of the fallback policy.
  const res = evaluateKey(`${FLAG_KEY}-absent-${Math.floor(Math.random() * 100000)}`, 'user-1');

  const timing = res.headers['Server-Timing'];
  if (timing) {
    const match = /dur=([\d.]+)/.exec(timing);
    const phase = exec.instance.currentTestRunDuration < DETECT_WINDOW_MS ? 'detect' : 'steady';
    if (match) serverMs.add(parseFloat(match[1]), { phase });
  }

  const ok = check(res, {
    'status is 200, not 5xx': (r) => r.status === 200,
    'fail-closed: enabled is false': (r) => {
      try {
        return JSON.parse(r.body).enabled === false;
      } catch {
        return false;
      }
    },
    'reason is unavailable': (r) => {
      try {
        return JSON.parse(r.body).reason === 'unavailable';
      } catch {
        return false;
      }
    },
  });

  if (!ok) policyViolations.add(1);
}

export function handleSummary(data) {
  return saveSummary(__ENV.SUMMARY_NAME || 'blackout', data, {
    title: 'blackout (redis + postgres down)',
    target: `${RATE}/s for ${DURATION}`,
    counters: [['policy violations', 'policy_violations']],
    phases: [
      ['steady state', 'server_ms{phase:steady}', 'p(99)', '<- gate: < 25 ms'],
      ['detection', 'server_ms{phase:detect}', 'max', `(first ${DETECT_WINDOW_MS / 1000} s) <- gate: < 3000 ms`],
    ],
  });
}
