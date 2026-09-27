import { Router } from 'express';
import { requireSdkOrAdmin, type AuthConfig } from '../middleware/auth.js';
import { AppError } from '../middleware/errors.js';
import { CacheUnavailableError, type FlagCache } from '../services/cache/flag-cache.js';

/**
 * Read-only endpoints the client SDK uses. The SDK fetches whole flag configs
 * (not per-user answers) and evaluates locally, so this is one request per
 * refresh regardless of how many users the host app has.
 */
export function createSdkRouter(cache: FlagCache, config: AuthConfig): Router {
  const router = Router();
  router.use(requireSdkOrAdmin(config));

  router.get('/flags', async (_req, res) => {
    try {
      res.json({ flags: await cache.getAll() });
    } catch (err) {
      if (!(err instanceof CacheUnavailableError)) throw err;
      // Deliberately a 503 rather than an empty list: the SDK keeps its last
      // good snapshot on a non-2xx, whereas `{"flags":[]}` would tell it every
      // flag had been deleted and switch every feature off at once.
      throw new AppError(503, 'flags_unavailable', 'no flag source is currently reachable');
    }
  });

  return router;
}
