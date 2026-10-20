import { describe, expect, it } from 'vitest';
import { CONTEXT_LIMITS, joinSignedContext, splitSignedContext } from '../src/index.js';

const SIG = 'A'.repeat(43);

describe('splitSignedContext', () => {
  it('splits a well-formed v1 token into exactly what was signed', () => {
    const token = joinSignedContext('eyJ1c2VySWQiOiJ1MSJ9', SIG);
    expect(splitSignedContext(token)).toEqual({
      signingInput: 'v1.eyJ1c2VySWQiOiJ1MSJ9',
      payload: 'eyJ1c2VySWQiOiJ1MSJ9',
      signature: SIG,
    });
  });

  it.each([
    ['a non-string', 42],
    ['an empty string', ''],
    ['an unknown version', `v2.abc.${SIG}`],
    ['a missing payload', `v1..${SIG}`],
    ['a short signature', 'v1.abc.' + 'A'.repeat(42)],
    ['a long signature', 'v1.abc.' + 'A'.repeat(44)],
    ['standard base64 characters', `v1.ab+/.${SIG}`],
    ['padding', `v1.abc=.${SIG}`],
    ['an extra part', `v1.abc.def.${SIG}`],
    ['surrounding whitespace', ` v1.abc.${SIG} `],
  ])('rejects %s', (_label, token) => {
    expect(splitSignedContext(token)).toBeNull();
  });

  it('rejects anything over the length limit before matching it', () => {
    const payload = 'a'.repeat(CONTEXT_LIMITS.maxSignedContextLength);
    expect(splitSignedContext(joinSignedContext(payload, SIG))).toBeNull();
  });

  it('matches in linear time on a hostile, maximal-length input', () => {
    const hostile = 'v1.' + 'a'.repeat(CONTEXT_LIMITS.maxSignedContextLength - 4) + '!';
    const started = performance.now();
    expect(splitSignedContext(hostile)).toBeNull();
    expect(performance.now() - started).toBeLessThan(50);
  });
});
