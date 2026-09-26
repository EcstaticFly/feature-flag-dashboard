import { describe, expect, it } from 'vitest';
import {
  computeBucket,
  evaluateFlag,
  evaluateFlagDetailed,
  type FlagConfig,
  type TargetingRule,
} from '../src/index.js';

const KEY = 'new-checkout-flow';

function flag(overrides: Partial<FlagConfig> = {}): FlagConfig {
  return {
    key: KEY,
    enabled: true,
    rolloutPercentage: 0,
    targetingRules: [],
    ...overrides,
  };
}

const users = (n: number) => Array.from({ length: n }, (_, i) => `user_${i}`);
const allowlist = (...ids: string[]): TargetingRule => ({
  attribute: 'userId',
  operator: 'in',
  values: ids,
});

/** A user whose bucket is exactly `target`, for testing the rollout boundary. */
function userInBucket(target: number): string {
  for (let i = 0; i < 100_000; i += 1) {
    if (computeBucket(`user_${i}`, KEY) === target) return `user_${i}`;
  }
  throw new Error(`no user found in bucket ${target}`);
}

describe('percentage rollout', () => {
  it('0% is false for everybody', () => {
    const f = flag({ rolloutPercentage: 0 });
    expect(users(1000).filter((id) => evaluateFlag(f, { userId: id }))).toHaveLength(0);
  });

  it('100% is true for everybody', () => {
    const f = flag({ rolloutPercentage: 100 });
    expect(users(1000).filter((id) => evaluateFlag(f, { userId: id }))).toHaveLength(1000);
  });

  it('includes roughly the configured share of users', () => {
    const f = flag({ rolloutPercentage: 25 });
    const included = users(10_000).filter((id) => evaluateFlag(f, { userId: id })).length;
    expect(Math.abs(included / 100 - 25)).toBeLessThanOrEqual(3);
  });

  it('is exclusive at the boundary: bucket N is out at N%, in at N+1%', () => {
    const user = userInBucket(40);
    expect(evaluateFlag(flag({ rolloutPercentage: 40 }), { userId: user })).toBe(false);
    expect(evaluateFlag(flag({ rolloutPercentage: 41 }), { userId: user })).toBe(true);
  });

  it('reports the bucket and which side of the rollout the user fell on', () => {
    const user = userInBucket(40);
    expect(evaluateFlagDetailed(flag({ rolloutPercentage: 41 }), { userId: user })).toEqual({
      enabled: true,
      reason: 'rollout_in',
      bucket: 40,
    });
    expect(evaluateFlagDetailed(flag({ rolloutPercentage: 40 }), { userId: user })).toEqual({
      enabled: false,
      reason: 'rollout_out',
      bucket: 40,
    });
  });

  it('does not clamp an out-of-range percentage — that is the API layer’s job', () => {
    // Documents the boundary deliberately: validation and the DB CHECK constraint
    // reject these before they can be stored, so core stays a pure function.
    expect(evaluateFlag(flag({ rolloutPercentage: 150 }), { userId: 'user_1' })).toBe(true);
    expect(evaluateFlag(flag({ rolloutPercentage: -10 }), { userId: 'user_1' })).toBe(false);
  });
});

describe('kill switch', () => {
  it('a disabled flag is false even at 100% with a matching allowlist', () => {
    const f = flag({
      enabled: false,
      rolloutPercentage: 100,
      targetingRules: [allowlist('user_7')],
    });
    expect(evaluateFlagDetailed(f, { userId: 'user_7' })).toEqual({
      enabled: false,
      reason: 'kill_switch',
    });
  });

  it('is false for an anonymous user too', () => {
    expect(evaluateFlag(flag({ enabled: false }), undefined)).toBe(false);
  });
});

describe('targeting rules', () => {
  it('a matching rule wins over a 0% rollout', () => {
    const f = flag({ rolloutPercentage: 0, targetingRules: [allowlist('user_7')] });
    expect(evaluateFlagDetailed(f, { userId: 'user_7' })).toEqual({
      enabled: true,
      reason: 'rule_match',
      ruleIndex: 0,
    });
    expect(evaluateFlag(f, { userId: 'user_8' })).toBe(false);
  });

  it('reports the first matching rule when several match', () => {
    const f = flag({
      targetingRules: [allowlist('user_1', 'user_7'), allowlist('user_7')],
    });
    expect(evaluateFlagDetailed(f, { userId: 'user_7' }).ruleIndex).toBe(0);
  });

  it('resolves the userId attribute from the context id, not from attributes', () => {
    const f = flag({ targetingRules: [allowlist('real-id')] });
    expect(evaluateFlag(f, { userId: 'real-id', attributes: { userId: 'other' } })).toBe(true);
    expect(evaluateFlag(f, { userId: 'other', attributes: { userId: 'real-id' } })).toBe(false);
  });

  it('targets arbitrary attributes such as email and plan', () => {
    const f = flag({
      targetingRules: [
        { attribute: 'email', operator: 'in', values: ['vip@example.com'] },
        { attribute: 'plan', operator: 'eq', values: ['pro'] },
      ],
    });
    expect(evaluateFlag(f, { userId: 'u', attributes: { email: 'vip@example.com' } })).toBe(true);
    expect(evaluateFlagDetailed(f, { userId: 'u', attributes: { plan: 'pro' } }).ruleIndex).toBe(1);
    expect(evaluateFlag(f, { userId: 'u', attributes: { plan: 'free' } })).toBe(false);
  });

  it('compares case- and whitespace-insensitively on both sides', () => {
    const f = flag({
      targetingRules: [{ attribute: 'email', operator: 'in', values: ['  VIP@Example.COM '] }],
    });
    expect(evaluateFlag(f, { userId: 'u', attributes: { email: 'vip@example.com' } })).toBe(true);
    expect(evaluateFlag(f, { userId: 'u', attributes: { email: ' Vip@Example.com  ' } })).toBe(true);
  });

  it('compares numeric and boolean attributes as strings', () => {
    const f = flag({
      targetingRules: [
        { attribute: 'age', operator: 'eq', values: ['42'] },
        { attribute: 'beta', operator: 'eq', values: ['true'] },
      ],
    });
    expect(evaluateFlag(f, { userId: 'u', attributes: { age: 42 } })).toBe(true);
    expect(evaluateFlag(f, { userId: 'u', attributes: { beta: true } })).toBe(true);
  });

  it('eq matches only the single configured value', () => {
    const f = flag({ targetingRules: [{ attribute: 'plan', operator: 'eq', values: ['pro'] }] });
    expect(evaluateFlag(f, { userId: 'u', attributes: { plan: 'pro' } })).toBe(true);
    expect(evaluateFlag(f, { userId: 'u', attributes: { plan: 'propro' } })).toBe(false);
  });
});

describe('rules that cannot be applied are skipped, never thrown on', () => {
  const skipped = (rule: unknown) =>
    flag({ rolloutPercentage: 100, targetingRules: [rule as TargetingRule] });

  it.each([
    ['an attribute the context does not have', { attribute: 'plan', operator: 'in', values: ['pro'] }],
    ['an unknown operator', { attribute: 'userId', operator: 'startsWith', values: ['user'] }],
    ['an empty values array', { attribute: 'userId', operator: 'in', values: [] }],
    ['values that are not an array', { attribute: 'userId', operator: 'in', values: 'user_1' }],
    ['a missing attribute name', { operator: 'in', values: ['user_1'] }],
    ['a null rule', null],
  ])('skips a rule with %s and carries on to the percentage', (_label, rule) => {
    const f = skipped(rule);
    expect(() => evaluateFlag(f, { userId: 'user_1' })).not.toThrow();
    // Falls through to the 100% rollout rather than matching or failing.
    expect(evaluateFlagDetailed(f, { userId: 'user_1' }).reason).toBe('rollout_in');
  });

  it('still applies later rules after skipping an unusable one', () => {
    const f = flag({
      targetingRules: [
        { attribute: 'userId', operator: 'startsWith' as never, values: ['user'] },
        allowlist('user_1'),
      ],
    });
    expect(evaluateFlagDetailed(f, { userId: 'user_1' }).ruleIndex).toBe(1);
  });

  it('ignores a non-array targetingRules value', () => {
    const f = { ...flag({ rolloutPercentage: 100 }), targetingRules: null as never };
    expect(evaluateFlag(f, { userId: 'user_1' })).toBe(true);
  });
});

describe('anonymous users', () => {
  // Documented consequence: anonymous traffic gets the flag as soon as it is
  // enabled, regardless of the rollout percentage.
  it.each([
    ['no context at all', undefined],
    ['an empty userId', { userId: '' }],
    ['a blank userId', { userId: '   ' }],
  ])('falls back to the flag’s enabled state with %s', (_label, context) => {
    expect(evaluateFlagDetailed(flag({ rolloutPercentage: 0 }), context)).toEqual({
      enabled: true,
      reason: 'anonymous',
    });
    expect(evaluateFlag(flag({ enabled: false, rolloutPercentage: 100 }), context)).toBe(false);
  });

  it('ignores targeting rules for anonymous users', () => {
    const f = flag({ rolloutPercentage: 0, targetingRules: [allowlist('user_7')] });
    expect(evaluateFlagDetailed(f, { userId: '' }).reason).toBe('anonymous');
  });
});

describe('evaluateFlag', () => {
  it('returns exactly the boolean from evaluateFlagDetailed', () => {
    const configs = [
      flag(),
      flag({ enabled: false }),
      flag({ rolloutPercentage: 100 }),
      flag({ rolloutPercentage: 50, targetingRules: [allowlist('user_3')] }),
    ];
    for (const f of configs) {
      for (const id of users(50)) {
        const context = { userId: id };
        expect(evaluateFlag(f, context)).toBe(evaluateFlagDetailed(f, context).enabled);
      }
    }
  });
});
