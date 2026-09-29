import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/api';

/**
 * Clears the session and returns to the login page.
 *
 * Also the landing spot when the API rejects an expired token: Server
 * Components cannot mutate cookies, so lib/api.ts redirects here instead.
 */
function clearSession(request: Request) {
  const url = new URL(request.url);
  const login = new URL('/login', url.origin);
  if (url.searchParams.get('expired')) login.searchParams.set('expired', '1');

  const response = NextResponse.redirect(login);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}

export const GET = clearSession;
export const POST = clearSession;
