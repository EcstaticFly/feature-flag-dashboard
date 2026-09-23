import { describe, expect, it } from 'vitest';
import { isSupportedOperator, normalizeValue, SUPPORTED_OPERATORS } from '../src/index.js';

describe('normalizeValue', () => {
  it('trims and lowercases strings so both sides of a comparison match', () => {
    expect(normalizeValue('  Pro ')).toBe('pro');
    expect(normalizeValue('USER@Example.COM')).toBe('user@example.com');
  });

  it('coerces numbers and booleans to comparable strings', () => {
    expect(normalizeValue(42)).toBe('42');
    expect(normalizeValue(true)).toBe('true');
  });
});

describe('isSupportedOperator', () => {
  it('accepts every supported operator', () => {
    for (const op of SUPPORTED_OPERATORS) {
      expect(isSupportedOperator(op)).toBe(true);
    }
  });

  it('rejects unknown operators so they can be skipped, not thrown on', () => {
    expect(isSupportedOperator('startsWith')).toBe(false);
    expect(isSupportedOperator(undefined)).toBe(false);
  });
});
