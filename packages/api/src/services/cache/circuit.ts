/**
 * A circuit breaker for the database read tier of the flag cache.
 *
 * Why this exists, concretely: M7's blackout load test stopped both Redis and
 * Postgres and drove 500 req/s at the evaluate endpoint. The fail-closed policy
 * held — every response was 200 `{enabled:false, reason:"unavailable"}` — but
 * every request first waited out the pg pool's 1500 ms `connectionTimeoutMillis`
 * before the fallback could fire. That pinned handlers, capped observed
 * throughput at ~243 req/s, and made a P99 of 1.5 s out of an answer that was
 * never going to change.
 *
 * Once Postgres has refused `failureThreshold` times in a row, waiting again is
 * not diligence, it is a guarantee of latency for no information. The breaker
 * opens and subsequent loads reject immediately, so the route reaches its
 * fail-closed answer in microseconds. After `cooldownMs` one single request is
 * let through as a probe (half-open); if it succeeds the breaker closes, if it
 * fails the cooldown starts again.
 *
 * Scope is deliberately narrow: only the cache's *read* path. Admin writes still
 * attempt the database and surface a real error, because an admin needs to be
 * told that a save did not happen, not handed a fast failure.
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitOptions {
  /** Consecutive failures before the circuit opens. */
  failureThreshold?: number;
  /** How long to stay open before allowing one probe through. */
  cooldownMs?: number;
  /** Injectable clock, so tests need no real waiting. */
  now?: () => number;
}

/** Thrown in place of the real database error while the circuit is open. */
export class CircuitOpenError extends Error {
  constructor(label: string) {
    super(`database circuit is open; skipped ${label}`);
    this.name = 'CircuitOpenError';
  }
}

export interface CircuitBreaker {
  /** Runs `op`, or rejects with CircuitOpenError without running it. */
  run<T>(label: string, op: () => Promise<T>): Promise<T>;
  state(): CircuitState;
}

export function createCircuitBreaker({
  failureThreshold = 5,
  cooldownMs = 1000,
  now = Date.now,
}: CircuitOptions = {}): CircuitBreaker {
  let consecutiveFailures = 0;
  let openedAt = 0;
  let open = false;
  /** True while the half-open probe is in flight, so only one request probes. */
  let probing = false;

  function state(): CircuitState {
    if (!open) return 'closed';
    return now() - openedAt >= cooldownMs ? 'half-open' : 'open';
  }

  async function run<T>(label: string, op: () => Promise<T>): Promise<T> {
    const current = state();

    // Half-open lets exactly one caller through. The rest are rejected fast:
    // admitting all of them would re-create the pile-up the breaker prevents.
    if (current === 'open' || (current === 'half-open' && probing)) {
      throw new CircuitOpenError(label);
    }

    const isProbe = current === 'half-open';
    if (isProbe) probing = true;

    try {
      const result = await op();
      if (open) console.log('[circuit] database reachable again; closing');
      open = false;
      consecutiveFailures = 0;
      return result;
    } catch (err) {
      consecutiveFailures += 1;
      if (!open && consecutiveFailures >= failureThreshold) {
        open = true;
        openedAt = now();
        console.error(
          `[circuit] ${consecutiveFailures} consecutive database failures; ` +
            `opening for ${cooldownMs} ms — flag reads will fail fast`,
        );
      } else if (open) {
        // A failed probe restarts the cooldown rather than leaving the circuit
        // half-open, which would let every subsequent request probe in turn.
        openedAt = now();
      }
      throw err;
    } finally {
      if (isProbe) probing = false;
    }
  }

  return { run, state };
}
