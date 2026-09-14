import { describe, expect, it } from 'vitest';
import { isEnabled } from '../src/index.js';

describe('@feature-flags/sdk', () => {
  it('exports isEnabled with the FR-07 signature', () => {
    expect(typeof isEnabled).toBe('function');
    expect(() => isEnabled('any-flag', { userId: 'u1' })).toThrow(/not implemented/);
  });
});
