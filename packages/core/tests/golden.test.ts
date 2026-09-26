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
