import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { JwtError, signJwt, verifyJwt } from '../src/auth/jwt.js';

const SECRET = 'test-secret-that-is-at-least-32-characters-long';
const CLAIMS = { sub: 'user-1', email: 'admin@example.com', role: 'admin' };

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/** Builds a token signed with `secret` but with an arbitrary header/payload. */
function forge(header: unknown, payload: unknown, secret: string): string {
  const input = `${b64(header)}.${b64(payload)}`;
  return `${input}.${createHmac('sha256', secret).update(input).digest('base64url')}`;
}

describe('signJwt / verifyJwt', () => {
  it('round-trips the claims and sets iat/exp', () => {
    const { token, expiresAt } = signJwt(CLAIMS, SECRET, 3600);
    const payload = verifyJwt(token, SECRET);

    expect(payload).toMatchObject(CLAIMS);
    expect(payload.exp - payload.iat).toBe(3600);
    expect(new Date(expiresAt).getTime()).toBe(payload.exp * 1000);
  });

  it('rejects a token signed with a different secret', () => {
    const { token } = signJwt(CLAIMS, 'another-secret-at-least-32-characters-xx', 3600);
    expect(() => verifyJwt(token, SECRET)).toThrow(JwtError);
  });

  it('rejects a tampered payload', () => {
    const { token } = signJwt(CLAIMS, SECRET, 3600);
    const [header, , signature] = token.split('.') as [string, string, string];
    const forgedPayload = b64({ ...CLAIMS, role: 'superadmin', iat: 1, exp: 9999999999 });

    expect(() => verifyJwt(`${header}.${forgedPayload}.${signature}`, SECRET)).toThrow(
      /invalid signature/,
    );
  });

  it('rejects alg: none even when the signature field matches the forged header', () => {
    // A correctly-signed token that merely *claims* a different algorithm must
    // still be refused — the verifier never negotiates.
    const token = forge(
      { alg: 'none', typ: 'JWT' },
      { ...CLAIMS, iat: 1, exp: 9999999999 },
      SECRET,
    );
    expect(() => verifyJwt(token, SECRET)).toThrow(/unsupported token header/);
  });

  it('rejects an expired token', () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const token = forge({ alg: 'HS256', typ: 'JWT' }, { ...CLAIMS, iat: past - 60, exp: past }, SECRET);
    expect(() => verifyJwt(token, SECRET)).toThrow(/expired/);
  });

  it('rejects a token with no exp claim', () => {
    const token = forge({ alg: 'HS256', typ: 'JWT' }, { ...CLAIMS, iat: 1 }, SECRET);
    expect(() => verifyJwt(token, SECRET)).toThrow(/malformed/);
  });

  it('rejects malformed tokens without throwing anything but JwtError', () => {
    for (const bad of ['', 'abc', 'a.b', 'a.b.c.d', 'not-base64.$$$.zzz']) {
      expect(() => verifyJwt(bad, SECRET)).toThrow(JwtError);
    }
  });
});
