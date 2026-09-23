import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

describe('hashPassword / verifyPassword', () => {
  it('verifies the correct password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple');

    await expect(verifyPassword('correct horse battery staple', stored)).resolves.toBe(true);
    await expect(verifyPassword('wrong password', stored)).resolves.toBe(false);
  });

  it('never stores the plaintext and salts each hash independently', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');

    expect(a).not.toContain('same-password');
    expect(a).not.toBe(b);
    await expect(verifyPassword('same-password', b)).resolves.toBe(true);
  });

  it('records its parameters so work factors can be raised later', async () => {
    const stored = await hashPassword('x');
    expect(stored.split('$').slice(0, 4)).toEqual(['scrypt', '16384', '8', '1']);
  });

  it('returns false rather than throwing for a malformed stored hash', async () => {
    for (const bad of ['', 'not-a-hash', 'scrypt$1$2$3', 'bcrypt$16384$8$1$aaaa$bbbb']) {
      await expect(verifyPassword('x', bad)).resolves.toBe(false);
    }
  });
});
