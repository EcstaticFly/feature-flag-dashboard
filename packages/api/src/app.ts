import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { createHealthRouter, type HealthCheck, type HealthRouterOptions } from './routes/health.js';

export interface AppDeps {
  /** Dependency checks surfaced by GET /health, keyed by dependency name. */
  checks: Record<string, HealthCheck>;
  health?: HealthRouterOptions;
}

/**
 * Builds the Express app without binding a port, so tests can drive it with
 * supertest and inject fake dependencies.
 */
export function createApp({ checks, health }: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.use(createHealthRouter(checks, health));

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  // Final error handler — keeps unexpected errors as JSON 500s rather than
  // Express's HTML default. Express 5 routes rejected promises here automatically.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[http] unhandled error:', err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}
