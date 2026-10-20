import { describe, expect, it, vi } from 'vitest';
// The real signer, from the SDK package's source. Two independent
// implementations of one token format — Web Crypto in the SDK, node:crypto
// here — are exactly where a mismatch would hide, so they are tested together.
import { createFlagClient } from '../../sdk/src/client.js';
import { createSignedContextVerifier } from '../src/client/signed-context.js';
import { signForTest } from './helpers/sign.js';

const SDK_KEY = 'shared-sdk-key-for-interop-tests';

function signer(apiKey = SDK_KEY) {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  return createFlagClient({
    apiUrl: 'http://flags.test',
    apiKey,
    fetch: () => Promise.reject(new Error('no network in this test')),
  });
}

describe('SDK signContext ↔ API verifier', () => {
  it('a token the SDK signs verifies in the API, carrying the same context', async () => {
    const token = await signer().signContext({ userId: 'alice', attributes: { plan: 'pro', seats: 5, beta: true } });
    expect(token).not.toBeNull();

    expect(createSignedContextVerifier(SDK_KEY)(token)).toEqual({
      ok: true,
      context: { userId: 'alice', attributes: { plan: 'pro', seats: 5, beta: true } },
    });
  });

  it('is byte-for-byte identical to the reference signer', async () => {
    const context = { userId: 'u-42', attributes: { region: 'eu', plan: 'pro' } };
    expect(await signer().signContext(context)).toBe(signForTest(context, SDK_KEY));
  });

  it('handles non-ASCII context values identically on both sides', async () => {
    const context = { userId: 'josé-ü-日本', attributes: { city: 'Zürich' } };
    const token = await signer().signContext(context);
    expect(token).toBe(signForTest(context, SDK_KEY));
    expect(createSignedContextVerifier(SDK_KEY)(token)).toMatchObject({ ok: true, context });
  });

  it('a token from one deployment is refused by another', async () => {
    const token = await signer('staging-sdk-key-1234').signContext({ userId: 'alice' });
    expect(createSignedContextVerifier(SDK_KEY)(token)).toEqual({ ok: false, reason: 'bad_signature' });
  });
});
