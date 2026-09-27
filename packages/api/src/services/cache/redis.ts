import { Redis } from 'ioredis';

/**
 * Creates an ioredis client tuned to fail fast rather than hang.
 *
 * - `enableOfflineQueue: false` — commands issued while disconnected reject
 *   immediately instead of queueing until a reconnect that may never come.
 *   This is what lets /health report "redis down" promptly.
 * - `lazyConnect: true` — the process boots even if Redis is unreachable
 *   (NFR-04); the first command triggers the connection attempt.
 * - `maxRetriesPerRequest: 1` — a command is retried at most once on
 *   connection loss before rejecting.
 */
export function createRedis(redisUrl: string): Redis {
  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 1500,
    // Reconnect with capped backoff so we recover automatically when Redis returns.
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });

  // Without a listener, connection errors are emitted as unhandled 'error'
  // events and would crash the process.
  redis.on('error', (err) => {
    console.error('[redis] error:', err.message);
  });

  return redis;
}

/**
 * Opens the connection if the client is still lazy.
 *
 * This is NOT optional with our options: `lazyConnect` means nothing connects
 * until asked, and `enableOfflineQueue: false` means a command issued while
 * disconnected is rejected rather than queued until the connection is ready.
 * Without this call the very first command of a client's life always fails.
 * After that ioredis reconnects on its own.
 */
export async function ensureConnected(redis: Redis): Promise<void> {
  if (redis.status === 'wait') {
    await redis.connect();
  }
}

/**
 * PING Redis, connecting first if the client hasn't connected yet.
 * Rejects (does not hang) when Redis is unreachable.
 */
export async function pingRedis(redis: Redis): Promise<void> {
  await ensureConnected(redis);
  const reply = await redis.ping();
  if (reply !== 'PONG') {
    throw new Error(`unexpected PING reply: ${reply}`);
  }
}
