import {
  evaluateFlag,
  isAnonymousContext,
  parseContext,
  toUserContext,
  type ClientContext,
  type FlagConfig,
} from '@feature-flags/core';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { isOriginAllowed, type AllowedOrigins } from '../client/origins.js';
import { createSignedContextVerifier } from '../client/signed-context.js';
import { safeEqual } from '../middleware/auth.js';
import { AppError } from '../middleware/errors.js';
import { CacheUnavailableError, type FlagCache } from '../services/cache/flag-cache.js';

/**
 * The browser API: `POST /api/client/flags`.
 *
 * Everything else in this service assumes a trusted caller holding a secret.
 * This endpoint is called from web pages, with a key that is PUBLIC — anyone
 * can read it out of a page's source. So it is built to give away as little as
 * possible:
 *
 * - Only flags an admin marked `clientSide` are considered. Every other flag is
 *   absent from the response, not reported as false, so its existence stays private.
 * - Evaluation happens here. The response is `{ key: boolean }` — never a rule,
 *   a percentage, an allowlist, a reason or a bucket.
 * - Who the user is comes from a token the host's own server signed, because a
 *   browser could otherwise claim any userId and probe who is on an allowlist.
 * - Exact-origin CORS, a small body limit, and the strict shared context rules.
 */

export const CLIENT_KEY_HEADER = 'x-flagpilot-client-key';

/** Chrome caps preflight caching at two hours; Firefox allows a day. */
const PREFLIGHT_MAX_AGE_SECONDS = 7200;
const BODY_LIMIT = '8kb';

export interface ClientApiConfig {
  /** The public browser key. */
  clientApiKey: string;
  allowedOrigins: AllowedOrigins;
  requireSignedContext: boolean;
  /** Verifies signed contexts; tokens are signed with a key derived from this. */
  sdkApiKey: string;
  /** Secrets that must never arrive as the client key — that would mean one shipped in a page. */
  secretKeys: readonly string[];
  /** Fraction of requests that emit the structured log line (0-1). */
  logSampleRate: number;
}

const bodySchema = z.strictObject({
  context: z.unknown().optional(),
  signedContext: z.string().optional(),
});

function logSampled(sampleRate: number, entry: Record<string, unknown>): void {
  if (Math.random() >= sampleRate) return;
  console.log(JSON.stringify({ event: 'client_flags_served', ts: new Date().toISOString(), ...entry }));
}

function securityLog(event: string, req: Request): void {
  // The origin identifies the page that leaked something. The key itself is
  // never logged — logging a leaked secret would leak it a second time.
  console.warn(
    JSON.stringify({ event, ts: new Date().toISOString(), origin: req.get('origin') ?? null }),
  );
}

export function createClientRouter(cache: FlagCache, config: ClientApiConfig): Router {
  const router = Router();
  const verifySignedContext = createSignedContextVerifier(config.sdkApiKey);

  // 1. CORS and response hygiene. Runs first, so even an error further down
  //    carries the CORS headers and an allowed page can read why it failed.
  router.use((req: Request, res: Response, next: NextFunction) => {
    res.vary('Origin');
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');

    const origin = req.get('origin');
    if (origin !== undefined) {
      if (!isOriginAllowed(origin, config.allowedOrigins)) {
        // Deliberately no CORS headers: the browser will not let the page read
        // this response at all. Requests without an Origin are not browsers
        // (a host's own server proxying), and are allowed.
        next(new AppError(403, 'origin_not_allowed', 'this origin may not call the browser API'));
        return;
      }
      res.set('Access-Control-Allow-Origin', config.allowedOrigins === '*' ? '*' : origin);
      // Never Access-Control-Allow-Credentials: this API has no cookies to send.
    }

    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'POST');
      res.set('Access-Control-Allow-Headers', `content-type, ${CLIENT_KEY_HEADER}`);
      res.set('Access-Control-Max-Age', String(PREFLIGHT_MAX_AGE_SECONDS));
      res.status(204).end();
      return;
    }
    next();
  });

  // 2. The key, before any body is read: an unauthenticated caller cannot make
  //    this service parse JSON for it.
  router.use((req: Request, _res: Response, next: NextFunction) => {
    const presented = req.get(CLIENT_KEY_HEADER);
    if (presented !== undefined && safeEqual(presented, config.clientApiKey)) {
      next();
      return;
    }
    if (presented !== undefined && config.secretKeys.some((secret) => safeEqual(presented, secret))) {
      securityLog('secret_key_sent_as_client_key', req);
    }
    next(new AppError(401, 'invalid_client_key', 'a valid client key is required'));
  });

  // 3. JSON only, and small. Checked explicitly so a missing or wrong
  //    Content-Type is a clear 415 rather than an empty body read as anonymous.
  router.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.method === 'POST' && !req.is('application/json')) {
      next(new AppError(415, 'unsupported_media_type', 'send the body as application/json'));
      return;
    }
    next();
  });
  router.use(express.json({ limit: BODY_LIMIT, strict: true }));

  router.post('/flags', async (req: Request, res: Response) => {
    const started = performance.now();
    const body = bodySchema.parse(req.body ?? {});

    if (body.context !== undefined && body.signedContext !== undefined) {
      throw AppError.badRequest('ambiguous_context', 'send either context or signedContext, not both');
    }

    let context: ClientContext;
    let signed = false;
    if (body.signedContext !== undefined) {
      const verified = verifySignedContext(body.signedContext);
      if (!verified.ok) {
        // One answer for every failure: telling malformed from forged would
        // only help someone forging.
        throw new AppError(
          403,
          'invalid_signed_context',
          'signedContext was not issued by this flag service, or was altered',
        );
      }
      context = verified.context;
      signed = true;
    } else {
      const parsed = parseContext(body.context);
      if (!parsed.ok) throw AppError.badRequest('invalid_context', parsed.error);
      context = parsed.context;
      if (config.requireSignedContext && !isAnonymousContext(context)) {
        throw new AppError(
          403,
          'signed_context_required',
          'this flag service only accepts a userId or attributes inside a signedContext from your server',
        );
      }
    }

    let configs: FlagConfig[];
    try {
      configs = await cache.getAll();
    } catch (err) {
      if (!(err instanceof CacheUnavailableError)) throw err;
      // A 503, never an empty map: the browser SDK keeps its last-known values
      // on an error, whereas `{ flags: {} }` would switch everything off.
      throw new AppError(503, 'flags_unavailable', 'no flag source is currently reachable');
    }

    const userContext = toUserContext(context);
    const flags: Record<string, boolean> = {};
    let count = 0;
    for (const flag of configs) {
      if (flag.clientSide !== true) continue;
      flags[flag.key] = evaluateFlag(flag, userContext);
      count += 1;
    }

    // Handler time, as on the evaluate route; the load test's gate reads it.
    // Not in Access-Control-Expose-Headers, so cross-origin pages cannot read it.
    res.setHeader('Server-Timing', `app;dur=${(performance.now() - started).toFixed(3)}`);
    res.json({ flags });
    // No user id, attributes, key or token: the line exists to count traffic.
    logSampled(config.logSampleRate, {
      count,
      signed,
      anonymous: userContext === undefined,
      ms: Number((performance.now() - started).toFixed(3)),
    });
  });

  return router;
}
