import { NextResponse, type NextRequest } from 'next/server';

const SESSION_COOKIE = 'ff_session';

/**
 * Gate protected routes before anything renders, so an unauthenticated visitor
 * never sees a flash of the flag list.
 *
 * This only checks that a session cookie EXISTS. Whether the JWT inside is still
 * valid is the API's call — lib/api.ts handles a 401 by redirecting to logout.
 */
export function proxy(request: NextRequest) {
  const hasSession = request.cookies.has(SESSION_COOKIE);
  const { pathname } = request.nextUrl;

  if (!hasSession) {
    const login = new URL('/login', request.url);
    if (pathname !== '/') login.searchParams.set('next', pathname);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  // Everything except the login page, the auth route handlers, and static assets.
  matcher: ['/((?!login|api/login|api/logout|_next/static|_next/image|favicon.ico).*)'],
};
