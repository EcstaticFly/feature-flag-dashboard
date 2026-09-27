import { Router } from 'express';
import { requireAdmin, type AuthConfig } from '../middleware/auth.js';
import { AppError } from '../middleware/errors.js';
import type { FlagService } from '../services/flags/flag-service.js';
import { createFlagSchema, flagKeySchema, updateFlagSchema } from '../validation/flags.js';

/**
 * Admin-only flag CRUD. All SQL lives in the flag service, not here — and the
 * service invalidates the cache on every mutation, so these handlers never
 * touch Redis either.
 */
export function createFlagsRouter(flags: FlagService, config: AuthConfig): Router {
  const router = Router();
  router.use(requireAdmin(config));

  const actorOf = (req: { actor?: { id: string } }): string => {
    const actor = req.actor?.id;
    if (!actor) throw AppError.unauthorized();
    return actor;
  };

  const parseKey = (raw: string): string => {
    const parsed = flagKeySchema.safeParse(raw);
    if (!parsed.success) {
      throw AppError.badRequest('invalid_flag_key', 'flag key is not a valid slug');
    }
    return parsed.data;
  };

  router.post('/', async (req, res) => {
    const input = createFlagSchema.parse(req.body);
    res.status(201).json(await flags.createFlag(actorOf(req), input));
  });

  router.get('/', async (_req, res) => {
    res.json({ flags: await flags.listFlags() });
  });

  router.get('/:key', async (req, res) => {
    res.json(await flags.getFlagByKey(parseKey(req.params.key)));
  });

  router.patch('/:key', async (req, res) => {
    const patch = updateFlagSchema.parse(req.body);
    res.json(await flags.updateFlag(actorOf(req), parseKey(req.params.key), patch));
  });

  router.delete('/:key', async (req, res) => {
    await flags.softDeleteFlag(actorOf(req), parseKey(req.params.key));
    res.status(204).end();
  });

  return router;
}
