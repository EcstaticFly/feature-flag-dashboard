import { Router } from 'express';

/** A dependency check: resolves when healthy, rejects (or hangs) otherwise. */
export type HealthCheck = () => Promise<void>;

export type CheckResult =
  | { status: 'ok'; latencyMs: number }
  | { status: 'error'; latencyMs: number; error: string };

export interface HealthResponse {
  status: 'ok' | 'degraded';
  checks: Record<string, CheckResult>;
}

export interface HealthRouterOptions {
  /** Per-check ceiling; a check exceeding it is reported as an error, not awaited. */
  timeoutMs?: number;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

async function runCheck(check: HealthCheck, timeoutMs: number): Promise<CheckResult> {
  const started = performance.now();
  try {
    // Wrap in an async IIFE so a synchronous throw inside `check` is captured too.
    await withTimeout((async () => check())(), timeoutMs);
    return { status: 'ok', latencyMs: Math.round(performance.now() - started) };
  } catch (err: unknown) {
    return {
      status: 'error',
      latencyMs: Math.round(performance.now() - started),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Runs every check concurrently and aggregates the result.
 * Exposed separately from the router so it can be reused (e.g. readiness probes).
 */
export async function runHealthChecks(
  checks: Record<string, HealthCheck>,
  timeoutMs: number,
): Promise<HealthResponse> {
  const names = Object.keys(checks);
  const results = await Promise.all(names.map((name) => runCheck(checks[name]!, timeoutMs)));

  const aggregated: Record<string, CheckResult> = {};
  names.forEach((name, i) => {
    aggregated[name] = results[i]!;
  });

  const allOk = results.every((r) => r.status === 'ok');
  return { status: allOk ? 'ok' : 'degraded', checks: aggregated };
}

/**
 * Two endpoints, because "is the process alive" and "can it serve traffic" are
 * different questions and conflating them costs money on free infrastructure.
 *
 * GET /health/live → always 200 while the process runs. Touches nothing.
 * GET /health      → 200 only when every dependency check passes; 503 otherwise.
 *
 * Neither throws and neither hangs: each dependency check is bounded by
 * `timeoutMs`.
 */
export function createHealthRouter(
  checks: Record<string, HealthCheck>,
  { timeoutMs = 2000 }: HealthRouterOptions = {},
): Router {
  const router = Router();

  /*
   * Liveness. Deliberately queries nothing.
   *
   * A platform health check polls constantly and cannot usually be slowed down
   * — Render is every ~30s. Pointing that at /health would run a Postgres query
   * and a Redis PING forever, which on a scale-to-zero database (Neon's free
   * tier) means it never sleeps and burns its monthly compute allowance until
   * the database is suspended, quite possibly mid-demo.
   *
   * So the platform and the keep-alive ping use this, which proves the process
   * is up and answering HTTP, and /health stays the honest readiness view for
   * humans and the runbook.
   */
  router.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'live' });
  });

  router.get('/health', async (_req, res) => {
    const body = await runHealthChecks(checks, timeoutMs);
    res.status(body.status === 'ok' ? 200 : 503).json(body);
  });

  return router;
}
