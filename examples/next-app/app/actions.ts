'use server';

import { cookies } from 'next/headers';
import { isDemoUser, SESSION_COOKIE } from '@/lib/session';

/**
 * Sign in and out. Called from <form action>, so Next.js re-renders the page
 * (and the layout's FlagProvider) for the new user in the same round trip.
 */

export async function signIn(formData: FormData): Promise<void> {
  const user = formData.get('user');
  if (!isDemoUser(user)) return;
  (await cookies()).set(SESSION_COOKIE, user, { httpOnly: true, sameSite: 'lax', path: '/' });
}

export async function signOut(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
