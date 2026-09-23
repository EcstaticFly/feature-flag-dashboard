import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDb } from './db/client.js';
import { createRedis, pingRedis } from './services/cache/redis.js';

const config = loadConfig();

const { pool, db } = createDb(config.DATABASE_URL);
const redis = createRedis(config.REDIS_URL);

const app = createApp({
  db,
  auth: {
    jwtSecret: config.JWT_SECRET,
    jwtExpiresInSeconds: config.JWT_EXPIRES_IN_SECONDS,
    sdkApiKey: config.SDK_API_KEY,
  },
  checks: {
    postgres: async () => {
      await pool.query('SELECT 1');
    },
    redis: () => pingRedis(redis),
  },
});

// Listen regardless of dependency state: /health reports what's reachable
// rather than the process refusing to start (NFR-04).
const server = app.listen(config.PORT, () => {
  console.log(`[api] listening on http://localhost:${config.PORT}`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[api] ${signal} received, shutting down`);
  server.close();
  await Promise.allSettled([pool.end(), redis.quit()]);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
