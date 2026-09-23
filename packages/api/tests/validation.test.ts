import { describe, expect, it } from 'vitest';
import { createFlagSchema, flagKeySchema, updateFlagSchema } from '../src/validation/flags.js';

describe('flag key', () => {
  it.each(['a', 'new-checkout-flow', 'v2', 'a1-b2-c3'])('accepts %s', (key) => {
    expect(flagKeySchema.safeParse(key).success).toBe(true);
  });

  it.each(['New-Checkout', 'new_checkout', 'new--checkout', '-lead', 'trail-', '', 'has space', 'ünïcode'])(
    'rejects %s',
    (key) => {
      expect(flagKeySchema.safeParse(key).success).toBe(false);
    },
  );
});

describe('createFlagSchema', () => {
  it('applies defaults for the optional fields', () => {
    const parsed = createFlagSchema.parse({ key: 'my-flag', name: 'My flag' });
    expect(parsed).toMatchObject({ enabled: false, rolloutPercentage: 0, targetingRules: [] });
  });

  it.each([0, 50, 100])('accepts rolloutPercentage %i', (pct) => {
    expect(createFlagSchema.safeParse({ key: 'k', name: 'n', rolloutPercentage: pct }).success).toBe(
      true,
    );
  });

  it.each([-1, 101, 12.5])('rejects rolloutPercentage %s', (pct) => {
    expect(createFlagSchema.safeParse({ key: 'k', name: 'n', rolloutPercentage: pct }).success).toBe(
      false,
    );
  });

  it('rejects unknown fields', () => {
    expect(createFlagSchema.safeParse({ key: 'k', name: 'n', sneaky: true }).success).toBe(false);
  });
});

describe('targetingRules', () => {
  const withRules = (targetingRules: unknown) =>
    createFlagSchema.safeParse({ key: 'k', name: 'n', targetingRules });

  it('accepts a userId allowlist and an attribute rule', () => {
    expect(
      withRules([
        { attribute: 'userId', operator: 'in', values: ['u1', 'u2'] },
        { attribute: 'email', operator: 'eq', values: ['a@b.com'] },
      ]).success,
    ).toBe(true);
  });

  it.each([
    ['not an array', { attribute: 'userId', operator: 'in', values: ['u1'] }],
    ['unknown operator', [{ attribute: 'userId', operator: 'startsWith', values: ['u1'] }]],
    ['empty values', [{ attribute: 'userId', operator: 'in', values: [] }]],
    ['missing attribute', [{ operator: 'in', values: ['u1'] }]],
    ['non-string values', [{ attribute: 'userId', operator: 'in', values: [1, 2] }]],
    ['extra key', [{ attribute: 'userId', operator: 'in', values: ['u1'], negate: true }]],
  ])('rejects %s', (_label, rules) => {
    expect(withRules(rules).success).toBe(false);
  });
});

describe('updateFlagSchema', () => {
  it('accepts a partial patch', () => {
    expect(updateFlagSchema.safeParse({ enabled: true }).success).toBe(true);
  });

  it('rejects an attempt to change the key — it is the SDK contract', () => {
    expect(updateFlagSchema.safeParse({ key: 'other-key' }).success).toBe(false);
  });

  it('rejects an empty patch', () => {
    expect(updateFlagSchema.safeParse({}).success).toBe(false);
  });
});
