import { Router } from 'express';
import { SYSTEM_INTEGRATION_ACTOR } from '../db/schema.js';
import { requireIntegrationKey, type AuthConfig } from '../middleware/auth.js';
import type { FlagService } from '../services/flags/flag-service.js';
import { alertSchema } from '../validation/flags.js';

/**
 * The receiving end of an external alert (FR-11, FR-12).
 *
 * The story: an app ships a feature behind a flag, the error tracker sees a
 * spike, and it calls here — so "we shipped a bug" becomes "the system caught
 * it and rolled itself back", with the audit trail explaining why. A human can
 * re-enable the flag afterwards; the history shows exactly what happened.
 *
 * Nothing calls this yet. It is built so the second project needs no changes on
 * this side when it arrives.
 *
 * This module depends only on the flag service's public update function, never
 * on the internals of other modules — which is also what gives it cache
 * invalidation for free, so an auto-disable reaches running SDKs like any other
 * change.
 */
export function createIntegrationsRouter(flags: FlagService, config: AuthConfig): Router {
  const router = Router();
  router.use(requireIntegrationKey(config));

  router.post('/alert', async (req, res) => {
    const { flagKey, reason, source } = alertSchema.parse(req.body);

    // 404s for an unknown key and for a soft-deleted one alike.
    const flag = await flags.getFlagByKey(flagKey);

    if (!flag.enabled) {
      // The caller retries on its own timeouts, so the same alert can arrive
      // twice. Report success without writing a second audit entry.
      res.json({ flagKey, disabled: true, alreadyDisabled: true, auditLogged: false });
      return;
    }

    await flags.updateFlag(SYSTEM_INTEGRATION_ACTOR, flagKey, { enabled: false }, { reason, source });

    // Always 200, never 204 or a 4xx for an already-off flag: a machine that
    // retries on non-2xx would otherwise retry forever against a flag that is
    // already in the state it asked for.
    res.json({ flagKey, disabled: true, alreadyDisabled: false, auditLogged: true });
  });

  return router;
}

/*
 * Note on the read-then-act race: two simultaneous alerts could both observe
 * `enabled: true`. That is harmless. `updateFlag` takes SELECT ... FOR UPDATE
 * and writes no audit row when nothing actually changed, so exactly one entry
 * is recorded either way. The check above is an optimisation and an honest
 * `alreadyDisabled` flag — not the correctness guarantee.
 */
