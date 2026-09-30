import { createApp } from './app.js';
import { fallbackValue, loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { createFlagCache } from './services/cache/flag-cache.js';
import { createRedis, pingRedis } from './services/cache/redis.js';
import { createFlagService } from './services/flags/flag-service.js';

const config = loadConfig();

const { pool, db } = createDb(config.DATABASE_URL, {
  connectTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
});
// Two connections: ioredis puts a subscribed client into subscriber mode, where
// ordinary commands are refused, so publishing and reading need their own.
const redisOptions = { connectTimeoutMs: config.REDIS_CONNECT_TIMEOUT_MS };
const redis = createRedis(config.REDIS_URL, redisOptions);
const subscriber = createRedis(config.REDIS_URL, redisOptions);

const cache = createFlagCache({
  redis,
  subscriber,
  db,
  ttlSeconds: config.FLAG_CACHE_TTL_SECONDS,
});
const flags = createFlagService(db, cache);

const app = createApp({
  db,
  flags,
  cache,
  fallback: fallbackValue(config.FLAG_FALLBACK_POLICY),
  evalLogSampleRate: config.FLAG_EVAL_LOG_SAMPLE_RATE,
  auth: {
    jwtSecret: config.JWT_SECRET,
    jwtExpiresInSeconds: config.JWT_EXPIRES_IN_SECONDS,
    sdkApiKey: config.SDK_API_KEY,
    integrationApiKey: config.INTEGRATION_API_KEY,
  },
  checks: {
    postgres: async () => {
      await pool.query('SELECT 1');
    },
    redis: () => pingRedis(redis),
  },
  health: { timeoutMs: config.HEALTH_CHECK_TIMEOUT_MS },
});

// Subscribing is best-effort: if Redis is down at boot the cache still works
// (Postgres + TTL), and ioredis resubscribes when the connection returns.
void cache.start();

// Listen regardless of dependency state: /health reports what's reachable
// rather than the process refusing to start (NFR-04).
const server = app.listen(config.PORT, () => {
  console.log(
    `[api] listening on http://localhost:${config.PORT} ` +
      `(cache ttl ${config.FLAG_CACHE_TTL_SECONDS}s, ${config.FLAG_FALLBACK_POLICY})`,
  );
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[api] ${signal} received, shutting down`);
  server.close();
  await cache.close();
  await Promise.allSettled([pool.end(), redis.quit(), subscriber.quit()]);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
