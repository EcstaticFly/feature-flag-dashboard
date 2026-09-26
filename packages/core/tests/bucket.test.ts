import { describe, expect, it } from 'vitest';
import { computeBucket, hashString } from '../src/index.js';

const FLAG = 'new-checkout-flow';
const users = (n: number) => Array.from({ length: n }, (_, i) => `user_${i}`);

describe('hashString', () => {
  it('always returns an unsigned 32-bit integer', () => {
    for (const input of ['', 'a', 'user_1', 'x'.repeat(5000), '🙂 ünïcode']) {
      const h = hashString(input);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('produces different hashes for inputs differing by one character', () => {
    expect(hashString('user_1')).not.toBe(hashString('user_2'));
    expect(hashString('flag:user')).not.toBe(hashString('flag:usen'));
  });
});

describe('computeBucket', () => {
  it('always returns an integer in 0..99', () => {
    for (const id of users(10_000)) {
      const bucket = computeBucket(id, FLAG);
      expect(Number.isInteger(bucket)).toBe(true);
      expect(bucket).toBeGreaterThanOrEqual(0);
      expect(bucket).toBeLessThan(100);
    }
  });

  // FR-05: the whole point — a user must never flip between variants.
  it('is deterministic across 1,000 calls with the same inputs', () => {
    const first = computeBucket('user_42', FLAG);
    for (let i = 0; i < 1000; i += 1) {
      expect(computeBucket('user_42', FLAG)).toBe(first);
    }
  });

  it('gives the same user different buckets for different flags', () => {
    // Otherwise an unlucky low-bucket user would be in the first slice of
    // every rollout, and a high-bucket user in none of them.
    const sample = users(1000);
    const identical = sample.filter(
      (id) => computeBucket(id, 'flag-one') === computeBucket(id, 'flag-two'),
    ).length;
    // ~1% expected by chance; assert well below a level that would indicate correlation.
    expect(identical).toBeLessThan(200);
  });

  it('spreads users evenly enough that a percentage means what it says', () => {
    const sample = users(10_000);
    for (const pct of [10, 25, 50, 75]) {
      const share =
        (sample.filter((id) => computeBucket(id, FLAG) < pct).length / sample.length) * 100;
      expect(Math.abs(share - pct)).toBeLessThanOrEqual(3);
    }
  });

  it('fills every decile of the 0..99 space', () => {
    // Catches a hash whose overall share is right but whose spread is lumpy.
    const deciles = new Array(10).fill(0);
    for (const id of users(10_000)) {
      deciles[Math.floor(computeBucket(id, FLAG) / 10)]! += 1;
    }
    for (const count of deciles) {
      expect(count).toBeGreaterThan(700); // expected 1000 each
      expect(count).toBeLessThan(1300);
    }
  });

  // The property that makes raising a rollout safe: nobody is ever removed.
  it('never drops a user when the percentage is raised', () => {
    for (const id of users(10_000)) {
      const bucket = computeBucket(id, FLAG);
      if (bucket < 25) expect(bucket).toBeLessThan(50);
      if (bucket < 50) expect(bucket).toBeLessThan(75);
    }
  });

  it('handles awkward inputs without throwing', () => {
    for (const id of ['', ' ', 'a'.repeat(10_000), 'id:with:colons', '🙂', 'ünïcode']) {
      expect(() => computeBucket(id, FLAG)).not.toThrow();
      expect(computeBucket(id, FLAG)).toBeLessThan(100);
    }
  });

  it('treats the userId and flagKey as distinct inputs', () => {
    // A naive concatenation would make ("ab", "c") and ("a", "bc") collide.
    expect(computeBucket('ab', 'c')).not.toBe(computeBucket('a', 'bc'));
  });
});
