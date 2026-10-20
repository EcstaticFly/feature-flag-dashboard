import { CONTEXT_LIMITS, joinSignedContext } from '@feature-flags/core';
import { describe, expect, it } from 'vitest';
import { createSignedContextVerifier } from '../src/client/signed-context.js';
import { signForTest, signRawPayloadForTest } from './helpers/sign.js';

const KEY = 'sdk-key-used-for-signing-tests';
const verify = createSignedContextVerifier(KEY);

describe('signed context verification', () => {
  it('accepts a token from the matching key and returns its context', () => {
    const token = signForTest({ userId: 'alice', attributes: { plan: 'pro' } }, KEY);
    expect(verify(token)).toEqual({
      ok: true,
      context: { userId: 'alice', attributes: { plan: 'pro' } },
    });
  });

  it('refuses a token signed with a different SDK key — another deployment, or a rotated key', () => {
    expect(verify(signForTest({ userId: 'alice' }, 'some-other-sdk-key'))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('refuses a token whose payload was altered after signing', () => {
    const genuine = signForTest({ userId: 'alice' }, KEY);
    const forgedPayload = Buffer.from('{"userId":"heidi"}').toString('base64url');
    const tampered = joinSignedContext(forgedPayload, genuine.split('.')[2]!);
    expect(verify(tampered)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a token whose signature was altered', () => {
    const genuine = signForTest({ userId: 'alice' }, KEY);
    const [, payload, signature] = genuine.split('.');
    const flipped = (signature![0] === 'A' ? 'B' : 'A') + signature!.slice(1);
    expect(verify(joinSignedContext(payload!, flipped))).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it.each([undefined, 42, '', 'not-a-token', 'v1.only-two-parts'])(
    'refuses %o as malformed, before computing anything',
    (token) => {
      expect(verify(token)).toEqual({ ok: false, reason: 'malformed' });
    },
  );

  it('refuses a token over the length limit as malformed', () => {
    const huge = signRawPayloadForTest(
      JSON.stringify({ userId: 'u'.repeat(CONTEXT_LIMITS.maxSignedContextLength) }),
      KEY,
    );
    expect(verify(huge)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('refuses a correctly signed payload that is not JSON', () => {
    expect(verify(signRawPayloadForTest('not json', KEY))).toEqual({
      ok: false,
      reason: 'invalid_payload',
    });
  });

  it('refuses a correctly signed payload that breaks the context rules — a signer bug is not trusted', () => {
    const token = signRawPayloadForTest('{"userId":"u1","attributes":{"__proto__":"x"}}', KEY);
    expect(verify(token)).toEqual({ ok: false, reason: 'invalid_payload' });
  });

  it('produces the same token for the same context however it was built', () => {
    const a = signForTest({ userId: 'u1', attributes: { plan: 'pro', region: 'eu' } }, KEY);
    const b = signForTest({ attributes: { region: 'eu', plan: 'pro' }, userId: 'u1' }, KEY);
    expect(a).toBe(b);
  });
});
