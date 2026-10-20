/**
 * Parsing for CLIENT_ALLOWED_ORIGINS — which websites may call the browser API.
 *
 * Exact origins only. The temptations this deliberately refuses:
 *
 * - Wildcard subdomains. `https://*.vercel.app` reads as "my preview
 *   deployments" but admits every Vercel app on the internet, because anyone
 *   can deploy one. List the origins you actually use.
 * - The literal `null` origin. Browsers send it from sandboxed iframes, `file:`
 *   pages and some redirects — contexts an attacker can produce at will.
 *   Allowing it is a well-known CORS hole.
 * - Paths. An origin has none; `https://example.com/app` is a configuration
 *   mistake, and silently trimming it would hide that.
 *
 * `*` alone is allowed, explicitly, for development or a deliberately public
 * key. The browser API never uses cookies, so a wildcard cannot leak a session.
 */

export type AllowedOrigins = '*' | readonly string[];

export type OriginsResult = { ok: true; origins: AllowedOrigins } | { ok: false; error: string };

export function parseAllowedOrigins(raw: string): OriginsResult {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (entries.length === 0) return { ok: false, error: 'must list at least one origin, or *' };

  if (entries.includes('*')) {
    return entries.length === 1
      ? { ok: true, origins: '*' }
      : { ok: false, error: '* must be the only entry when used' };
  }

  const origins = new Set<string>();
  for (const entry of entries) {
    if (entry.toLowerCase() === 'null') {
      return { ok: false, error: "'null' is not allowed: sandboxed and file: pages send it" };
    }
    if (entry.includes('*')) {
      return {
        ok: false,
        error: `'${entry}': wildcard subdomains are not supported — list each origin exactly`,
      };
    }

    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      return { ok: false, error: `'${entry}' is not a valid origin (expected scheme://host[:port])` };
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { ok: false, error: `'${entry}': only http and https origins are allowed` };
    }
    if (url.username !== '' || url.password !== '') {
      return { ok: false, error: `'${entry}': an origin cannot contain credentials` };
    }
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      return { ok: false, error: `'${entry}': an origin has no path, query or fragment` };
    }

    // `URL.origin` is exactly what a browser sends: lowercase scheme and host,
    // punycode for international names, and no default port.
    origins.add(url.origin);
  }

  return { ok: true, origins: Object.freeze([...origins]) };
}

/** Whether a request's Origin header is permitted. */
export function isOriginAllowed(origin: string, allowed: AllowedOrigins): boolean {
  return allowed === '*' || allowed.includes(origin);
}
