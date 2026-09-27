import { evaluateFlagDetailed, type UserContext } from '@feature-flags/core';
import { Router, type Request } from 'express';
import { requireSdkOrAdmin, type AuthConfig } from '../middleware/auth.js';
import { AppError } from '../middleware/errors.js';
import { CacheUnavailableError, type FlagCache } from '../services/cache/flag-cache.js';
import { flagKeySchema } from '../validation/flags.js';

/**
 * Server-side evaluation for non-JS clients and for the M7 load test.
 *
 * The JavaScript SDK does NOT use this: it fetches whole configs from
 * /api/sdk/flags and runs the very same `evaluateFlagDetailed` locally, so its
 * checks cost no network at all. Both paths import @feature-flags/core, which
 * is why they can never disagree about a user.
 */

const ATTRIBUTE_PREFIX = 'attr.';

/**
 * Builds the user context from the query string:
 *   ?userId=u_1&attr.plan=pro&attr.email=a@b.com
 * A repeated parameter arrives as an array; the first value wins.
 */
export function parseUserContext(query: Request['query']): UserContext | undefined {
  const first = (v: unknown): string | undefined =>
    typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : undefined;

  const userId = first(query.userId);
  const attributes: Record<string, string> = {};
  for (const [name, raw] of Object.entries(query)) {
    if (!name.startsWith(ATTRIBUTE_PREFIX)) continue;
    const value = first(raw);
    if (value !== undefined) attributes[name.slice(ATTRIBUTE_PREFIX.length)] = value;
  }

  // No userId at all is legitimate — core treats it as anonymous.
  if (userId === undefined && Object.keys(attributes).length === 0) return undefined;
  return {
    userId: userId ?? '',
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
  };
}

/**
 * One structured line per evaluation. Nothing consumes it yet; a future
 * Analytics service will (see the Future-Scope note in CLAUDE.md), and emitting
 * it now means the hot path never has to be touched again for it.
 *
 * At NFR-03 throughput this is a lot of stdout — sampling, or batching through
 * a queue, is the obvious next step when analytics actually lands.
 */
function logEvaluation(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: 'flag_evaluation', ts: new Date().toISOString(), ...entry }));
}

export function createEvaluateRouter(
  cache: FlagCache,
  config: AuthConfig,
  fallback: boolean,
): Router {
  const router = Router();

  router.get('/:key/evaluate', requireSdkOrAdmin(config), async (req, res) => {
    const parsedKey = flagKeySchema.safeParse(req.params.key);
    if (!parsedKey.success) {
      throw AppError.badRequest('invalid_flag_key', 'flag key is not a valid slug');
    }
    const key = parsedKey.data;
    const context = parseUserContext(req.query);

    let config;
    try {
      config = await cache.getFlag(key);
    } catch (err) {
      if (!(err instanceof CacheUnavailableError)) throw err;
      // NFR-04: the evaluation path never throws because infrastructure is down.
      // It returns the documented fallback (fail-closed by default), so callers
      // get the behaviour their app had before the flag existed.
      console.error(`[evaluate] no source reachable for '${key}', using fallback`, err.message);
      logEvaluation({ flagKey: key, userId: context?.userId, enabled: fallback, reason: 'unavailable' });
      res.json({ key, userId: context?.userId, enabled: fallback, reason: 'unavailable' });
      return;
    }

    if (!config) throw AppError.notFound('flag_not_found', `no flag with key '${key}'`);

    const result = evaluateFlagDetailed(config, context);
    logEvaluation({
      flagKey: key,
      userId: context?.userId,
      enabled: result.enabled,
      reason: result.reason,
      bucket: result.bucket,
    });

    res.json({ key, userId: context?.userId, ...result });
  });

  return router;
}
