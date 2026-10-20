import { createHmac } from 'node:crypto';
import { canonicalContextJson, joinSignedContext, type ClientContext } from '@feature-flags/core';
import { deriveSigningKey } from '../../src/client/signed-context.js';

/**
 * A reference signer for tests, written independently of the server SDK's Web
 * Crypto signer so the two can be checked against each other.
 */
export function signForTest(context: ClientContext, sdkApiKey: string): string {
  const payload = Buffer.from(canonicalContextJson(context), 'utf8').toString('base64url');
  const signature = createHmac('sha256', deriveSigningKey(sdkApiKey))
    .update(`v1.${payload}`, 'utf8')
    .digest('base64url');
  return joinSignedContext(payload, signature);
}

/** Signs an arbitrary payload — for tests that need a valid signature over invalid content. */
export function signRawPayloadForTest(rawJson: string, sdkApiKey: string): string {
  const payload = Buffer.from(rawJson, 'utf8').toString('base64url');
  const signature = createHmac('sha256', deriveSigningKey(sdkApiKey))
    .update(`v1.${payload}`, 'utf8')
    .digest('base64url');
  return joinSignedContext(payload, signature);
}
