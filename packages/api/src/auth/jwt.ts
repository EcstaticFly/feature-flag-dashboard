import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal HS256 JWT, hand-rolled per CLAUDE.md.
 *
 * The security of a hand-rolled verifier rests on being strict rather than
 * flexible: exactly one algorithm is accepted, the header must match exactly
 * (so `alg: "none"` and alg-confusion attacks have nowhere to land), `exp` is
 * mandatory, and the signature comparison is constant-time.
 */

const HEADER = { alg: 'HS256', typ: 'JWT' } as const;

export interface JwtPayload {
  /** Subject — the user id. */
  sub: string;
  email: string;
  role: string;
  /** Issued at (seconds since epoch). */
  iat: number;
  /** Expiry (seconds since epoch). */
  exp: number;
}

export class JwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JwtError';
  }
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(signingInput: string, secret: string): string {
  return createHmac('sha256', secret).update(signingInput).digest('base64url');
}

export interface SignedToken {
  token: string;
  /** Expiry as an ISO timestamp, for the login response. */
  expiresAt: string;
}

export function signJwt(
  claims: Pick<JwtPayload, 'sub' | 'email' | 'role'>,
  secret: string,
  expiresInSeconds: number,
): SignedToken {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + expiresInSeconds;
  const payload: JwtPayload = { ...claims, iat, exp };

  const signingInput = `${base64UrlEncode(JSON.stringify(HEADER))}.${base64UrlEncode(
    JSON.stringify(payload),
  )}`;

  return {
    token: `${signingInput}.${sign(signingInput, secret)}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

/** Verifies signature, header and expiry. Throws `JwtError` on any failure. */
export function verifyJwt(token: string, secret: string): JwtPayload {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('malformed token');
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];

  const expected = Buffer.from(sign(`${headerB64}.${payloadB64}`, secret), 'utf8');
  const actual = Buffer.from(signatureB64, 'utf8');
  // Length check first: timingSafeEqual throws on a length mismatch.
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new JwtError('invalid signature');
  }

  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    throw new JwtError('malformed token');
  }

  // Exact header match — no algorithm negotiation, ever.
  const h = header as Record<string, unknown>;
  if (h.alg !== HEADER.alg || h.typ !== HEADER.typ) {
    throw new JwtError('unsupported token header');
  }

  const p = payload as Record<string, unknown>;
  if (typeof p.sub !== 'string' || typeof p.email !== 'string' || typeof p.role !== 'string') {
    throw new JwtError('malformed token');
  }
  if (typeof p.exp !== 'number' || typeof p.iat !== 'number') {
    throw new JwtError('malformed token');
  }
  if (p.exp <= Math.floor(Date.now() / 1000)) {
    throw new JwtError('token expired');
  }

  return p as unknown as JwtPayload;
}
