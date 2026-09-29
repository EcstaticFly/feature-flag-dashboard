import { NextResponse } from 'next/server';
import { ApiError, apiLogin, SESSION_COOKIE } from '@/lib/api';

/**
 * Exchanges credentials for a session.
 *
 * The browser posts here; this handler calls the Express API server-side and
 * puts the JWT into an httpOnly cookie. The token itself is never sent to the
 * client, so no client-side JavaScript — or XSS payload — can read it.
 */
export async function POST(request: Request) {
  let email: unknown;
  let password: unknown;
  try {
    ({ email, password } = await request.json());
  } catch {
    return NextResponse.json({ error: 'malformed request' }, { status: 400 });
  }

  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    return NextResponse.json({ error: 'email and password are required' }, { status: 400 });
  }

  try {
    const { token, expiresAt } = await apiLogin(email, password);

    const response = NextResponse.json({ ok: true });
    response.cookies.set({
      name: SESSION_COOKIE,
      value: token,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      // Expire the cookie exactly when the JWT does, so a stale cookie never
      // survives its token.
      expires: new Date(expiresAt),
    });
    return response;
  } catch (err) {
    if (err instanceof ApiError) {
      return NextResponse.json({ error: 'invalid email or password' }, { status: 401 });
    }
    return NextResponse.json({ error: 'the flag service is unreachable' }, { status: 503 });
  }
}
