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
 * GET /health → 200 only when every dependency check passes; 503 otherwise.
 * Never throws and never hangs: each check is bounded by `timeoutMs`.
 */
export function createHealthRouter(
  checks: Record<string, HealthCheck>,
  { timeoutMs = 2000 }: HealthRouterOptions = {},
): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const body = await runHealthChecks(checks, timeoutMs);
    res.status(body.status === 'ok' ? 200 : 503).json(body);
  });

  return router;
}
