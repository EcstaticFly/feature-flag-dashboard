import express, { type Express } from 'express';
import type { Db } from './db/client.js';
import type { AuthConfig } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { createAuthRouter } from './routes/auth.js';
import { createFlagsRouter } from './routes/flags.js';
import { createHealthRouter, type HealthCheck, type HealthRouterOptions } from './routes/health.js';
import { createSdkRouter } from './routes/sdk.js';

export interface AppDeps {
  /** Dependency checks surfaced by GET /health, keyed by dependency name. */
  checks: Record<string, HealthCheck>;
  db: Db;
  auth: AuthConfig;
  health?: HealthRouterOptions;
}

/**
 * Builds the Express app without binding a port, so tests can drive it with
 * supertest and inject fake dependencies.
 */
export function createApp({ checks, db, auth, health }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));

  app.use(createHealthRouter(checks, health));
  app.use('/api/auth', createAuthRouter(db, auth));
  app.use('/api/flags', createFlagsRouter(db, auth));
  app.use('/api/sdk', createSdkRouter(db, auth));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
