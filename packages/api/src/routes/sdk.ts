import { Router } from 'express';
import type { Db } from '../db/client.js';
import { requireSdkOrAdmin, type AuthConfig } from '../middleware/auth.js';
import { listSdkFlags } from '../services/flags/flag-service.js';

/**
 * Read-only endpoints the client SDK uses. The SDK fetches whole flag configs
 * (not per-user answers) and evaluates locally, so this is one request per
 * refresh regardless of how many users the host app has.
 */
export function createSdkRouter(db: Db, config: AuthConfig): Router {
  const router = Router();
  router.use(requireSdkOrAdmin(config));

  router.get('/flags', async (_req, res) => {
    res.json({ flags: await listSdkFlags(db) });
  });

  return router;
}
