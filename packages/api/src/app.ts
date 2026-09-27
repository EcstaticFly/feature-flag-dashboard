import express, { type Express } from 'express';
import type { Db } from './db/client.js';
import type { AuthConfig } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { createAuthRouter } from './routes/auth.js';
import { createEvaluateRouter } from './routes/evaluate.js';
import { createFlagsRouter } from './routes/flags.js';
import { createHealthRouter, type HealthCheck, type HealthRouterOptions } from './routes/health.js';
import { createSdkRouter } from './routes/sdk.js';
import type { FlagCache } from './services/cache/flag-cache.js';
import type { FlagService } from './services/flags/flag-service.js';

export interface AppDeps {
  /** Dependency checks surfaced by GET /health, keyed by dependency name. */
  checks: Record<string, HealthCheck>;
  /** Used only by the login route; flag access goes through `flags`. */
  db: Db;
  auth: AuthConfig;
  flags: FlagService;
  cache: FlagCache;
  /** What evaluation returns when no flag source is reachable (NFR-04). */
  fallback: boolean;
  health?: HealthRouterOptions;
}

/**
 * Builds the Express app without binding a port, so tests can drive it with
 * supertest and inject fake dependencies.
 */
export function createApp({
  checks,
  db,
  auth,
  flags,
  cache,
  fallback,
  health,
}: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.use(createHealthRouter(checks, health));
  app.use('/api/auth', createAuthRouter(db, auth));
  // Mounted before the CRUD router, which requires an admin token for its whole
  // surface. This one handles only GET /:key/evaluate (SDK key or admin);
  // every other path under /api/flags falls through to the router below.
  app.use('/api/flags', createEvaluateRouter(cache, auth, fallback));
  app.use('/api/flags', createFlagsRouter(flags, auth));
  app.use('/api/sdk', createSdkRouter(cache, auth));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
