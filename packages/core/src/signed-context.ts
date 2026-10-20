/**
 * The signed-context token format, shared by the signer (the server SDK) and
 * the verifier (the API).
 *
 * A browser holds only a public key, so it cannot be trusted to say who the
 * user is: anyone could claim any userId and probe who sits on an allowlist.
 * Instead the host's own server — which already knows who is signed in —
 * signs the context, and the browser passes the token along unread.
 *
 *   v1.<base64url(canonical JSON)>.<base64url(HMAC-SHA256 signature)>
 *
 *   derivedKey = HMAC-SHA256(key = SDK key, data = SIGNED_CONTEXT_KEY_LABEL)
 *   signature  = HMAC-SHA256(key = derivedKey, data = "v1." + payload)
 *
 * The SDK key is never used directly on token content: deriving a dedicated
 * key keeps signing domain-separated from anything else the key might be used
 * for later.
 *
 * Deliberately no crypto and no byte encoding here. This package targets
 * plain ES2022 and ships inside browser bundles; the signer and the verifier
 * each use their own runtime's HMAC and base64 (Web Crypto, node:crypto) and
 * share only the format.
 */

import { CONTEXT_LIMITS } from './context.js';

export const SIGNED_CONTEXT_VERSION = 'v1';
export const SIGNED_CONTEXT_KEY_LABEL = 'flagpilot:signed-context:v1';

/**
 * Three dot-separated parts. Base64url has no dots, so the parts are
 * unambiguous; a SHA-256 signature is 32 bytes, i.e. 43 base64url characters.
 * No nested quantifiers, so matching is linear in the input length.
 */
const SIGNED_CONTEXT_PATTERN = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/;

export interface SignedContextParts {
  /** Exactly what was signed: `v1.<payload>`. */
  signingInput: string;
  payload: string;
  signature: string;
}

/** Splits a token, or returns null if it is not structurally a v1 token. */
export function splitSignedContext(token: unknown): SignedContextParts | null {
  if (typeof token !== 'string') return null;
  if (token.length === 0 || token.length > CONTEXT_LIMITS.maxSignedContextLength) return null;
  if (!SIGNED_CONTEXT_PATTERN.test(token)) return null;

  const lastDot = token.lastIndexOf('.');
  const payload = token.slice(SIGNED_CONTEXT_VERSION.length + 1, lastDot);
  return {
    signingInput: `${SIGNED_CONTEXT_VERSION}.${payload}`,
    payload,
    signature: token.slice(lastDot + 1),
  };
}

export function joinSignedContext(payload: string, signature: string): string {
  return `${SIGNED_CONTEXT_VERSION}.${payload}.${signature}`;
}
