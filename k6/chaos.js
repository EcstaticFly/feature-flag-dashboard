import { Counter } from 'k6/metrics';
import { evaluate, randomUser, recordAndCheck, saveSummary, setupFlag, FLAG_KEY } from './lib.js';

/**
 * The same load, run while Redis is killed underneath it (see run-chaos.mjs).
 *
 * The question is not "did it survive" but "did it keep being RIGHT". The flag
 * config never changes during the run, so a different answer means the outage
 * produced a wrong result, not merely a slow one — which is the difference
 * between degrading gracefully and just degrading.
 */

const RATE = Number(__ENV.LOAD_RATE || 500);
const DURATION = __ENV.LOAD_DURATION || '60s';

/** Any evaluation that disagrees with the pre-outage answer. Must stay at 0. */
const wrongAnswers = new Counter('wrong_answers');

export const options = {
  // p(99) is not in k6's default trend stats, and it is the number the NFR
  // is written in terms of.
  summaryTrendStats: ['min', 'avg', 'med', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    chaos: {
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
    // NFR-04: the evaluation path never throws because infrastructure is down.
    http_req_failed: ['rate<0.001'],
    checks: ['rate==1.00'],
    wrong_answers: ['count==0'],
    // Deliberately looser than the 5 ms of the clean run: with Redis gone,
    // L1 misses fall through to Postgres, so latency is EXPECTED to rise.
    // What must not change is correctness.
    server_ms: ['p(99)<250'],
  },
};

export function setup() {
  return setupFlag();
}

export default function (data) {
  // Two thirds random traffic, one third the pinned user whose answer is known.
  const usePinned = Math.random() < 0.34;
  const userId = usePinned ? data.pinnedUser : randomUser();
  const res = evaluate(userId);

  recordAndCheck(res);

  if (usePinned && res.status === 200) {
    try {
      const body = JSON.parse(res.body);
      if (body.enabled !== data.pinnedEnabled) {
        wrongAnswers.add(1);
        console.error(
          `wrong answer for ${data.pinnedUser} on ${FLAG_KEY}: ` +
            `expected ${data.pinnedEnabled}, got ${body.enabled} (reason: ${body.reason})`,
        );
      }
    } catch {
      wrongAnswers.add(1);
    }
  }
}

export function handleSummary(data) {
  return saveSummary(__ENV.SUMMARY_NAME || 'chaos', data, {
    title: 'chaos (redis killed mid-run)',
    target: `${RATE}/s for ${DURATION}`,
    counters: [['wrong answers', 'wrong_answers']],
  });
}
