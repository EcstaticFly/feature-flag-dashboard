import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  parseContext,
  SIGNED_CONTEXT_KEY_LABEL,
  splitSignedContext,
  type ClientContext,
} from '@feature-flags/core';

/**
 * Verifies the identity tokens the server SDK's `signContext` produces. The
 * format is defined once, in @feature-flags/core; this is the node:crypto half.
 *
 * Order matters and is deliberate: structure, then signature, and only then
 * is the payload decoded and parsed. Nothing an attacker controls is fed to
 * JSON.parse until the signature proves our own signer wrote it.
 */

export type VerifyResult =
  | { ok: true; context: ClientContext }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'invalid_payload' };

export type SignedContextVerifier = (token: unknown) => VerifyResult;

/** The key tokens are signed with — never the SDK key itself. */
export function deriveSigningKey(sdkApiKey: string): Buffer {
  return createHmac('sha256', sdkApiKey).update(SIGNED_CONTEXT_KEY_LABEL, 'utf8').digest();
}

export function createSignedContextVerifier(sdkApiKey: string): SignedContextVerifier {
  const signingKey = deriveSigningKey(sdkApiKey);

  return (token: unknown): VerifyResult => {
    const parts = splitSignedContext(token);
    if (!parts) return { ok: false, reason: 'malformed' };

    const expected = createHmac('sha256', signingKey).update(parts.signingInput, 'utf8').digest();
    const presented = Buffer.from(parts.signature, 'base64url');
    // timingSafeEqual requires equal lengths; checking first also keeps a short
    // signature from throwing. The pattern already fixes the length at 32 bytes.
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      return { ok: false, reason: 'bad_signature' };
    }

    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(parts.payload, 'base64url').toString('utf8'));
    } catch {
      return { ok: false, reason: 'invalid_payload' };
    }

    // A correctly signed payload that still breaks the rules means the signer
    // has a bug. Refuse it rather than trust it.
    const parsed = parseContext(decoded);
    return parsed.ok ? { ok: true, context: parsed.context } : { ok: false, reason: 'invalid_payload' };
  };
}
