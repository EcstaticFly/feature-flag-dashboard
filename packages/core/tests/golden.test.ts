import { describe, expect, it } from 'vitest';
import { computeBucket, hashString } from '../src/index.js';

/**
 * Regression lock on the bucketing contract.
 *
 * These numbers were generated once from the implementation and are now FROZEN.
 * If a change to the hash makes this file fail, that change reshuffles every
 * existing user into a new bucket — people mid-rollout would flip between the
 * old and new experience for no visible reason. Fix the change, never the
 * expectations.
 *
 * They also pin the two processes together: the API and the SDK both import
 * this code, and a value that drifted in one would show up here.
 */

describe('frozen bucket values', () => {
  it.each([
    ['user_1', 'new-checkout-flow', 75],
    ['user_2', 'new-checkout-flow', 88],
    ['user_42', 'new-checkout-flow', 73],
    ['user_42', 'dark-mode', 57],
    ['', 'new-checkout-flow', 4],
    ['a', 'b', 21],
    ['9f1d6c2e-0b3a-4c58-8f21-7d6e5a4b3c2d', 'beta-banner', 86],
    ['USER_1', 'new-checkout-flow', 99],
  ])('computeBucket(%j, %j) === %i', (userId, flagKey, expected) => {
    expect(computeBucket(userId, flagKey)).toBe(expected);
  });

  it('buckets are case-sensitive on the user id', () => {
    // user_1 -> 75, USER_1 -> 99: ids are used verbatim, never normalised.
    expect(computeBucket('user_1', 'new-checkout-flow')).not.toBe(
      computeBucket('USER_1', 'new-checkout-flow'),
    );
  });
});

describe('frozen hash values', () => {
  it.each([
    ['', 2_872_998_923],
    ['a', 444_641_715],
    ['new-checkout-flow:user_1', 67_205_275],
  ])('hashString(%j) === %i', (input, expected) => {
    expect(hashString(input)).toBe(expected);
  });
});

/*
 * The accounts the README's demo runbook uses, and the buckets it claims for
 * them. The runbook says "at 10% only carol is in" and "heidi is in only via the
 * allowlist" — statements that are true because of these exact numbers.
 *
 * Without this, changing the hash would leave a documented, rehearsed demo
 * quietly wrong, and the first person to notice would be whoever is watching it.
 */
describe('demo runbook accounts (README: Demo runbook)', () => {
  const FLAG = 'new-checkout-flow';

  it.each([
    ['carol', 2],
    ['dave', 32],
    ['alice', 34],
    ['grace', 39],
    ['frank', 40],
    ['bob', 41],
    ['erin', 57],
    ['heidi', 85],
  ])('computeBucket(%j, "new-checkout-flow") === %i', (userId, expected) => {
    expect(computeBucket(userId, FLAG)).toBe(expected);
  });

  const inAt = (pct: number) =>
    ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi'].filter(
      (u) => computeBucket(u, FLAG) < pct,
    );

  it('nobody is in at 0%', () => {
    expect(inAt(0)).toEqual([]);
  });

  // The step that makes the demo land: one recognisable account turns on.
  it('only carol is in at 10%', () => {
    expect(inAt(10)).toEqual(['carol']);
  });

  it('six of the eight are in at 50%', () => {
    expect(inAt(50)).toEqual(['alice', 'bob', 'carol', 'dave', 'frank', 'grace']);
  });

  // heidi is the furthest out of anyone, which is exactly why the runbook
  // allowlists her: seeing her turn on at 10% can only be the rule, never luck.
  it('heidi is the last account a rising rollout would reach', () => {
    const buckets = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace'].map((u) =>
      computeBucket(u, FLAG),
    );
    expect(computeBucket('heidi', FLAG)).toBeGreaterThan(Math.max(...buckets));
  });
});
