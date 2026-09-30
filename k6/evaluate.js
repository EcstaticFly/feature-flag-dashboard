import { evaluate, randomUser, recordAndCheck, saveSummary, setupFlag } from './lib.js';

/**
 * The NFR run: is evaluation fast enough, at the throughput the spec asks for?
 *
 *   NFR-01  P99 < 5 ms, served from cache
 *   NFR-03  >= 500 req/s on a single instance
 *
 * `constant-arrival-rate` is an open model: it keeps issuing 500 requests a
 * second whether or not the server keeps up. A VU-based test would quietly
 * slow down when the server did, and report a flattering latency at a
 * throughput nobody asked for.
 */

const RATE = Number(__ENV.LOAD_RATE || 500);
const DURATION = __ENV.LOAD_DURATION || '60s';

export const options = {
  // p(99) is not in k6's default trend stats, and it is the number the NFR
  // is written in terms of.
  summaryTrendStats: ['min', 'avg', 'med', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    evaluate: {
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
    // NFR-01, measured where the NFR means it.
    server_ms: ['p(99)<5'],
    // NFR-03 — proves the load was delivered, not merely attempted. Without
    // this a run could pass at 40 req/s and prove nothing. The 2% allowance is
    // for the arrival rate being averaged across process start-up, not for
    // letting the server off: k6 issues requests on a wall-clock schedule
    // regardless of how fast responses come back.
    http_reqs: [`rate>${RATE * 0.98}`],
    'http_req_failed{endpoint:evaluate}': ['rate<0.001'],
    // A 404 on every request would otherwise look wonderfully fast.
    checks: ['rate==1.00'],
  },
};

export function setup() {
  return setupFlag();
}

export default function () {
  recordAndCheck(evaluate(randomUser()));
}

export function handleSummary(data) {
  return saveSummary(__ENV.SUMMARY_NAME || 'evaluate', data, {
    title: 'results (NFR-01 / NFR-03 gate)',
    nfr: true,
    target: `${RATE}/s for ${DURATION}`,
  });
}
