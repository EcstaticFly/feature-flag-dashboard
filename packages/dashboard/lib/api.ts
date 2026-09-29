import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * The only path between the dashboard and the Express API.
 *
 * Every call happens on the server: the JWT lives in an httpOnly cookie that
 * client JavaScript cannot read, is attached here as an Authorization header,
 * and never reaches the browser. That also means no CORS is involved.
 */

export const SESSION_COOKIE = 'ff_session';

/** Server-side only — deliberately not NEXT_PUBLIC_, so it can't leak to the client. */
const API_URL = (process.env.FLAGS_API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

export interface ApiErrorBody {
  error: { code: string; message: string; details?: { path: string; message: string }[] };
}

/** An API response that failed. Actions turn this into form state, never a throw. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** Field-keyed messages for inline form errors. */
  fieldErrors(): Record<string, string> {
    const fields: Record<string, string> = {};
    for (const detail of this.details ?? []) {
      // zod paths look like `targetingRules.0.values`; the first segment is the field.
      const field = detail.path.split('.')[0] ?? '_';
      fields[field] ??= detail.message;
    }
    return fields;
  }
}

/** The flag service could not be reached at all — a different problem from a 4xx. */
export class ApiUnreachableError extends Error {
  constructor(cause: unknown) {
    super('the flag service is unreachable');
    this.name = 'ApiUnreachableError';
    this.cause = cause;
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Calls the API as the logged-in admin.
 *
 * `cache: 'no-store'` on every request: flag state must never look stale to an
 * admin, and Next would otherwise happily serve a cached fetch.
 */
export async function apiFetch<T>(
  path: string,
  init: RequestInit & { parseJson?: boolean } = {},
): Promise<T> {
  const { parseJson = true, ...rest } = init;

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...rest,
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        ...(await authHeader()),
        ...rest.headers,
      },
    });
  } catch (err) {
    throw new ApiUnreachableError(err);
  }

  if (response.status === 401) {
    // The middleware only checks that a cookie exists; an expired JWT gets this
    // far. Cookies can't be mutated from a Server Component, so hand off to the
    // logout route, which clears it and explains why on the login page.
    redirect('/api/logout?expired=1');
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiError(
      response.status,
      body?.error.code ?? 'unknown_error',
      body?.error.message ?? `request failed with ${response.status}`,
      body?.error.details,
    );
  }

  return (parseJson ? await response.json() : undefined) as T;
}

/** Logs in against the API. Used only by the login Route Handler. */
export async function apiLogin(
  email: string,
  password: string,
): Promise<{ token: string; expiresAt: string; user: { id: string; email: string } }> {
  const response = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    throw new ApiError(response.status, 'unauthorized', 'invalid email or password');
  }
  return response.json();
}
