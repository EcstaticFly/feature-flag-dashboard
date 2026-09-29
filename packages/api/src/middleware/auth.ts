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
function safeEqual(a: string, b: string): boolean {
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
 * Read-only endpoints the SDK uses: an `x-api-key` matching SDK_API_KEY, or an
 * admin Bearer token (admins may read what their apps read).
 */
export function requireSdkOrAdmin(config: AuthConfig): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const apiKey = req.get('x-api-key');
    if (apiKey && safeEqual(apiKey, config.sdkApiKey)) {
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
    req.actor = { type: 'system', id: SYSTEM_INTEGRATION_ACTOR };
    next();
  };
}
