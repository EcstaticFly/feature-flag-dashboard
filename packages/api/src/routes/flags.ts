import { Router } from 'express';
import { requireAdmin, type AuthConfig } from '../middleware/auth.js';
import { AppError } from '../middleware/errors.js';
import type { FlagService } from '../services/flags/flag-service.js';
import {
  auditQuerySchema,
  createFlagSchema,
  flagKeySchema,
  updateFlagSchema,
} from '../validation/flags.js';

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

  // Each flag carries who last changed it, so the dashboard can show
  // "last updated by X" without a second round trip per row.
  router.get('/', async (_req, res) => {
    res.json({ flags: await flags.listFlagsWithActors() });
  });

  router.get('/:key', async (req, res) => {
    res.json(await flags.getFlagWithActor(parseKey(req.params.key)));
  });

  /**
   * Audit history for one flag, newest first (FR-06). Until now the audit log
   * was written but readable nowhere.
   */
  router.get('/:key/audit', async (req, res) => {
    const parsed = auditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      throw AppError.badRequest('invalid_query', 'limit must be a positive integer');
    }
    const entries = await flags.getFlagAudit(parseKey(req.params.key), parsed.data.limit);
    res.json({ entries });
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
