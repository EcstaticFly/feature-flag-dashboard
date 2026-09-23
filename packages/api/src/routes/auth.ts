import { eq } from 'drizzle-orm';
import { Router } from 'express';
import { signJwt } from '../auth/jwt.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import type { Db } from '../db/client.js';
import { users } from '../db/schema.js';
import type { AuthConfig } from '../middleware/auth.js';
import { AppError } from '../middleware/errors.js';
import { loginSchema } from '../validation/flags.js';

/**
 * A pre-computed hash verified against when the email is unknown, so a request
 * for a non-existent account costs the same time as a wrong password and
 * doesn't leak which emails are registered.
 */
let dummyHashPromise: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('invalid-password-placeholder');
  return dummyHashPromise;
}

export function createAuthRouter(db: Db, config: AuthConfig): Router {
  const router = Router();

  router.post('/login', async (req, res) => {
    const { email, password } = loginSchema.parse(req.body);
    const normalizedEmail = email.trim().toLowerCase();

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, normalizedEmail))
      .limit(1);

    const ok = user
      ? await verifyPassword(password, user.passwordHash)
      : await verifyPassword(password, await getDummyHash());

    // Same message either way — never reveal whether the email exists.
    if (!ok || !user) throw AppError.unauthorized('invalid email or password');

    const { token, expiresAt } = signJwt(
      { sub: user.id, email: user.email, role: user.role },
      config.jwtSecret,
      config.jwtExpiresInSeconds,
    );

    res.json({
      token,
      expiresAt,
      user: { id: user.id, email: user.email, role: user.role },
    });
  });

  return router;
}
