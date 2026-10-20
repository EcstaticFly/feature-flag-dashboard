import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { JwtError, verifyJwt } from '../auth/jwt.js';
import { SYSTEM_INTEGRATION_ACTOR } from '../db/schema.js';
import { AppError } from './errors.js';

export interface AuthConfig {
  jwtSecret: string;
  jwtExpiresInSeconds: number;
  sdkApiKey: string;
  integrationApiKey: string;
}

/** Constant-time string comparison that tolerates differing lengths. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function bearerToken(req: Request): string | undefined {
  const header = req.get('authorization');
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  if (!token || scheme?.toLowerCase() !== 'bearer') return undefined;
  return token;
}

/** Verifies an admin Bearer token, or returns undefined if there isn't a usable one. */
function authenticateAdmin(req: Request, config: AuthConfig): boolean {
  const token = bearerToken(req);
  if (!token) return false;
  try {
    const payload = verifyJwt(token, config.jwtSecret);
    req.actor = { type: 'user', id: payload.sub };
    return true;
  } catch (err) {
    if (err instanceof JwtError) return false;
    throw err;
  }
}

/**
 * Admin-only: a valid JWT. The SDK API key is deliberately NOT accepted here —
 * a client app holding the SDK key must never be able to write.
 */
export function requireAdmin(config: AuthConfig): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!authenticateAdmin(req, config)) {
      next(AppError.unauthorized('valid admin token required'));
      return;
    }
    next();
  };
}

/**
 * A browser always sends `Origin` on a cross-origin request; server-side HTTP
 * clients (Node's fetch, k6, the dashboard's server components) do not. So a
 * valid SECRET key arriving with an Origin header means the key has been
 * shipped inside a web page, where anyone can read it.
 *
 * The request is refused and the event logged — naming the page, never the
 * key — so the operator knows to rotate it. Refusing also stops the mistake
 * from "working", which is what would let it ship unnoticed.
 */
function refuseSecretFromBrowser(req: Request, header: string): AppError | undefined {
  if (req.get('origin') === undefined) return undefined;
  console.warn(
    JSON.stringify({
      event: 'secret_key_from_browser',
      ts: new Date().toISOString(),
      header,
      origin: req.get('origin'),
    }),
  );
  return new AppError(
    403,
    'secret_key_from_browser',
    'secret keys must never be used from a browser; use the browser SDK and its public client key',
  );
}

/**
 * Read-only endpoints the SDK uses: an `x-api-key` matching SDK_API_KEY, or an
 * admin Bearer token (admins may read what their apps read).
 */
export function requireSdkOrAdmin(config: AuthConfig): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const apiKey = req.get('x-api-key');
    if (apiKey && safeEqual(apiKey, config.sdkApiKey)) {
      const refusal = refuseSecretFromBrowser(req, 'x-api-key');
      if (refusal) {
        next(refusal);
        return;
      }
      req.actor = { type: 'sdk', id: 'sdk' };
      next();
      return;
    }
    if (authenticateAdmin(req, config)) {
      next();
      return;
    }
    next(AppError.unauthorized('valid SDK API key or admin token required'));
  };
}

/**
 * The integration endpoint's own credential.
 *
 * Deliberately the ONLY thing accepted there — not an admin token, not the SDK
 * key. Every audit row that endpoint writes is attributed to
 * `system:integration`, so accepting a human's token would make that
 * attribution a lie. It also keeps the blast radius small: this key can switch
 * a flag off and nothing more, and revoking it disturbs neither the dashboard
 * nor any SDK.
 */
export function requireIntegrationKey(config: AuthConfig): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const key = req.get('x-integration-key');
    if (!key || !safeEqual(key, config.integrationApiKey)) {
      next(AppError.unauthorized('valid integration key required'));
      return;
    }
    const refusal = refuseSecretFromBrowser(req, 'x-integration-key');
    if (refusal) {
      next(refusal);
      return;
    }
    req.actor = { type: 'system', id: SYSTEM_INTEGRATION_ACTOR };
    next();
  };
}
