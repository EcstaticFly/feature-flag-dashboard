import { describe, expect, it } from 'vitest';
import {
  canonicalContextJson,
  CONTEXT_LIMITS,
  isAnonymousContext,
  parseContext,
  toUserContext,
} from '../src/index.js';

/*
 * parseContext is the single gate for contexts that come from outside a
 * trusted server. The API, the server SDK's signer and the browser SDK all
 * call it, so these cases are the contract all three share.
 */

const ok = (input: unknown) => {
  const result = parseContext(input);
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result.context;
};
const rejected = (input: unknown) => {
  const result = parseContext(input);
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.error;
};

describe('parseContext — accepted', () => {
  it('treats undefined and null as anonymous', () => {
    expect(ok(undefined)).toEqual({});
    expect(ok(null)).toEqual({});
  });

  it('copies a userId and attributes', () => {
    expect(ok({ userId: 'u1', attributes: { plan: 'pro', seats: 5, beta: true } })).toEqual({
      userId: 'u1',
      attributes: { plan: 'pro', seats: 5, beta: true },
    });
  });

  it('treats an empty or whitespace userId as anonymous, as the evaluator does', () => {
    expect(ok({ userId: '' })).toEqual({});
    expect(ok({ userId: '   ' })).toEqual({});
  });

  it('drops an empty attribute bag', () => {
    expect(ok({ userId: 'u1', attributes: {} })).toEqual({ userId: 'u1' });
  });

  it('accepts values exactly at every limit', () => {
    const attributes: Record<string, string> = {};
    for (let i = 0; i < CONTEXT_LIMITS.maxAttributes; i += 1) {
      attributes[`a${i}`.padEnd(CONTEXT_LIMITS.maxAttributeNameLength, 'x')] = 'v'.repeat(
        CONTEXT_LIMITS.maxAttributeValueLength,
      );
    }
    const context = ok({ userId: 'u'.repeat(CONTEXT_LIMITS.maxUserIdLength), attributes });
    expect(Object.keys(context.attributes!)).toHaveLength(CONTEXT_LIMITS.maxAttributes);
  });

  it('returns a copy, never the caller’s object', () => {
    const input = { userId: 'u1', attributes: { plan: 'pro' } };
    const context = ok(input);
    expect(context).not.toBe(input);
    expect(context.attributes).not.toBe(input.attributes);
  });

  it('accepts an object whose prototype is not this realm’s Object.prototype', () => {
    const foreign = Object.create(null) as Record<string, unknown>;
    foreign.userId = 'u1';
    expect(ok(foreign)).toEqual({ userId: 'u1' });
  });
});

describe('parseContext — rejected', () => {
  it.each([
    ['a string', 'u1'],
    ['an array', ['u1']],
    ['a number', 5],
  ])('rejects %s as the context', (_label, input) => {
    expect(rejected(input)).toMatch(/must be an object/);
  });

  it('rejects unknown fields rather than silently dropping them', () => {
    expect(rejected({ userId: 'u1', role: 'admin' })).toMatch(/unknown context field 'role'/);
  });

  it('rejects a non-string userId', () => {
    expect(rejected({ userId: 42 })).toMatch(/userId must be a string/);
  });

  it('rejects a userId over the limit', () => {
    expect(rejected({ userId: 'u'.repeat(CONTEXT_LIMITS.maxUserIdLength + 1) })).toMatch(/at most/);
  });

  it('rejects more attributes than allowed', () => {
    const attributes: Record<string, string> = {};
    for (let i = 0; i <= CONTEXT_LIMITS.maxAttributes; i += 1) attributes[`a${i}`] = 'v';
    expect(rejected({ userId: 'u1', attributes })).toMatch(/at most 32 attributes/);
  });

  it.each(['__proto__', 'constructor', 'prototype'])('rejects the reserved name %s', (name) => {
    // JSON.parse is how a hostile body arrives: it creates `__proto__` as an
    // OWN key, which a plain object literal cannot.
    const input = JSON.parse(`{"userId":"u1","attributes":{"${name}":"x"}}`);
    expect(rejected(input)).toMatch(/not an allowed attribute name/);
  });

  it('rejects an empty or over-long attribute name', () => {
    expect(rejected({ userId: 'u1', attributes: { '': 'x' } })).toMatch(/1-64 characters/);
    expect(rejected({ userId: 'u1', attributes: { ['n'.repeat(65)]: 'x' } })).toMatch(
      /1-64 characters/,
    );
  });

  it.each([
    ['an object', { nested: true }],
    ['an array', ['a']],
    ['null', null],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects %s as an attribute value', (_label, value) => {
    expect(rejected({ userId: 'u1', attributes: { plan: value } })).toMatch(/plan/);
  });

  it('rejects an over-long string value', () => {
    const value = 'v'.repeat(CONTEXT_LIMITS.maxAttributeValueLength + 1);
    expect(rejected({ userId: 'u1', attributes: { plan: value } })).toMatch(/at most/);
  });

  it('turns an unreadable object into a rejection, never an exception', () => {
    const hostile = {
      get userId(): string {
        throw new Error('boom');
      },
    };
    expect(() => parseContext(hostile)).not.toThrow();
    expect(rejected(hostile)).toMatch(/could not be read/);
  });
});

describe('canonicalContextJson', () => {
  it('is independent of the order attributes were added in', () => {
    const a = canonicalContextJson({ userId: 'u1', attributes: { plan: 'pro', region: 'eu' } });
    const b = canonicalContextJson({ attributes: { region: 'eu', plan: 'pro' }, userId: 'u1' });
    expect(a).toBe(b);
    expect(a).toBe('{"userId":"u1","attributes":{"plan":"pro","region":"eu"}}');
  });

  it('serialises an anonymous context as an empty object', () => {
    expect(canonicalContextJson({})).toBe('{}');
  });
});

describe('toUserContext / isAnonymousContext', () => {
  it('maps a missing userId to undefined, which the evaluator treats as anonymous', () => {
    expect(toUserContext({})).toBeUndefined();
    expect(toUserContext({ attributes: { plan: 'pro' } })).toBeUndefined();
  });

  it('keeps the attributes alongside a userId', () => {
    expect(toUserContext({ userId: 'u1', attributes: { plan: 'pro' } })).toEqual({
      userId: 'u1',
      attributes: { plan: 'pro' },
    });
  });

  it('calls a context anonymous only when it carries nothing identifying', () => {
    expect(isAnonymousContext({})).toBe(true);
    expect(isAnonymousContext({ userId: 'u1' })).toBe(false);
    expect(isAnonymousContext({ attributes: { plan: 'pro' } })).toBe(false);
  });
});
