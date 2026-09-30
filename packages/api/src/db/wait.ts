import { createDb } from './client.js';

/**
 * Blocks until Postgres answers, or the budget runs out.
 *
 * The API itself deliberately boots whether or not the database is reachable
 * (NFR-04) — but the migrate and seed scripts cannot: they have nothing useful to
 * do without a connection, and on Render's free tier they run as part of the
 * container's start command, so a failure there is a failed deploy.
 *
 * Which matters because managed free tiers are slow to first byte, not fast.
 * Neon scales to zero after a few minutes idle and takes seconds to wake, so the
 * very first connection of a deploy is the one most likely to time out. Retrying
 * turns that from a crash loop into a pause.
 *
 * Retries only the *connection*. Migrations themselves are not retried: a
 * migration that failed halfway is a situation for a human, not for another
 * attempt.
 */
export interface WaitOptions {
  /** Total time to keep trying before giving up. */
  timeoutMs?: number;
  /** Per-attempt connect timeout. */
  connectTimeoutMs?: number;
  /** Gap between attempts. */
  intervalMs?: number;
  /** Prefix for log lines, so it is obvious which script is waiting. */
  label?: string;
}

export async function waitForDatabase(
  databaseUrl: string,
  { timeoutMs = 60_000, connectTimeoutMs = 10_000, intervalMs = 2_000, label = 'db' }: WaitOptions = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastError: unknown;

  for (;;) {
    attempt += 1;
    const { pool } = createDb(databaseUrl, { connectTimeoutMs });
    try {
      await pool.query('SELECT 1');
      if (attempt > 1) {
        console.log(`[${label}] database reachable after ${attempt} attempts`);
      }
      return;
    } catch (err) {
      lastError = err;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const message = err instanceof Error ? err.message : String(err);
      console.log(
        `[${label}] database not ready (attempt ${attempt}: ${message}); ` +
          `retrying for up to ${Math.ceil(remaining / 1000)}s`,
      );
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
    } finally {
      // Each attempt gets a fresh pool, so it must be disposed either way;
      // leaking one per attempt would exhaust a free tier's connection limit.
      await pool.end().catch(() => undefined);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`database unreachable after ${timeoutMs}ms (${attempt} attempts): ${message}`);
}

/** Per-attempt connect timeout for the standalone scripts, from the environment. */
export function scriptConnectTimeoutMs(): number {
  const raw = Number(process.env.DB_CONNECT_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 10_000;
}
