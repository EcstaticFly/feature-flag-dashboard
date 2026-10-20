import 'server-only';
import { cookies } from 'next/headers';

/**
 * A stand-in for real authentication: the "signed-in user" is a cookie.
 *
 * alice and heidi are the demo accounts from the main README. For the
 * `new-checkout-flow` flag at 50%, alice is in (bucket 34) and heidi is out
 * (bucket 85).
 */

export const DEMO_USERS = ['alice', 'heidi'] as const;
export type DemoUser = (typeof DEMO_USERS)[number];

export const SESSION_COOKIE = 'demo_user';

export function isDemoUser(value: unknown): value is DemoUser {
  return typeof value === 'string' && (DEMO_USERS as readonly string[]).includes(value);
}

export async function currentUser(): Promise<DemoUser | null> {
  const value = (await cookies()).get(SESSION_COOKIE)?.value;
  return isDemoUser(value) ? value : null;
}
