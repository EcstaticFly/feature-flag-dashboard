import express, { type Express } from 'express';
import type { Db } from './db/client.js';
import type { AuthConfig } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { createAuthRouter } from './routes/auth.js';
import { createEvaluateRouter } from './routes/evaluate.js';
import { createFlagsRouter } from './routes/flags.js';
import { createIntegrationsRouter } from './integrations/alert.js';
import { createClientRouter, type ClientApiConfig } from './routes/client.js';
import { createHealthRouter, type HealthCheck, type HealthRouterOptions } from './routes/health.js';
import { createSdkRouter } from './routes/sdk.js';
import { createSettingsRouter } from './routes/settings.js';
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
  /** Fraction of evaluations that emit the structured log line. Default 1. */
  evalLogSampleRate?: number;
  health?: HealthRouterOptions;
  /**
   * The browser API. Absent → `/api/client` is not mounted at all, so a
   * deployment without CLIENT_API_KEY behaves exactly as before.
   */
  clientApi?: Omit<ClientApiConfig, 'logSampleRate'>;
  /** Whether a signed context is required — reported by the settings endpoint even when disabled. */
  requireSignedContext?: boolean;
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
  evalLogSampleRate = 1,
  health,
  clientApi,
  requireSignedContext = true,
}: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  // Mounted BEFORE the global JSON parser, so it reads bodies with its own,
  // much smaller limit. A body parsed once is not parsed again further down.
  if (clientApi) {
    app.use('/api/client', createClientRouter(cache, { ...clientApi, logSampleRate: evalLogSampleRate }));
  }

  app.use(express.json({ limit: '100kb' }));

  app.use(createHealthRouter(checks, health));
  app.use('/api/auth', createAuthRouter(db, auth));
  // Mounted before the CRUD router, which requires an admin token for its whole
  // surface. This one handles only GET /:key/evaluate (SDK key or admin);
  // every other path under /api/flags falls through to the router below.
  app.use('/api/flags', createEvaluateRouter(cache, auth, { fallback, evalLogSampleRate }));
  app.use('/api/flags', createFlagsRouter(flags, auth));
  app.use('/api/sdk', createSdkRouter(cache, auth));
  app.use('/api/integrations', createIntegrationsRouter(flags, auth));
  app.use(
    '/api/settings',
    createSettingsRouter(
      {
        browserApiEnabled: clientApi !== undefined,
        clientApiKey: clientApi?.clientApiKey ?? null,
        allowedOrigins: clientApi?.allowedOrigins ?? [],
        requireSignedContext,
      },
      auth,
    ),
  );

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
