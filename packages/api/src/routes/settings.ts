import { Router } from 'express';
import type { AllowedOrigins } from '../client/origins.js';
import { requireAdmin, type AuthConfig } from '../middleware/auth.js';

/**
 * `GET /api/settings/sdk` — what the dashboard's SDK setup page shows.
 *
 * Read-only, admin-only, and deliberately narrow. The browser client key IS
 * returned: it is public by design and ships in every page that uses it. The
 * SDK key, the integration key and the JWT secret are never returned, not even
 * to an admin — the setup page only needs to know a server SDK key exists.
 */

export interface SdkSettings {
  browserApiEnabled: boolean;
  clientApiKey: string | null;
  allowedOrigins: AllowedOrigins;
  requireSignedContext: boolean;
}

export function createSettingsRouter(settings: SdkSettings, auth: AuthConfig): Router {
  const router = Router();
  router.use(requireAdmin(auth));

  router.get('/sdk', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      serverSdk: { configured: true },
      browserSdk: {
        enabled: settings.browserApiEnabled,
        clientKey: settings.browserApiEnabled ? settings.clientApiKey : null,
        allowedOrigins: settings.browserApiEnabled ? settings.allowedOrigins : [],
        requireSignedContext: settings.requireSignedContext,
      },
    });
  });

  return router;
}
