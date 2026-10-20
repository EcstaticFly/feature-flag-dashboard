/**
 * Test fixture for flagpilot/browser in real browsers.
 *
 * Plays the part of a host website: it serves a page that loads the BUILT
 * browser SDK (dist/browser.js, exactly what npm ships), and a /sign endpoint
 * standing in for the host's own backend, which signs the user's identity with
 * the real server SDK.
 *
 * It listens on two origins so CORS is tested for real against the compose
 * API: 5174 is in CLIENT_ALLOWED_ORIGINS, 5175 deliberately is not.
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFlagClient } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '..', 'dist');

const API_URL = process.env.FLAGPILOT_API_URL ?? 'http://localhost:4000';
const CLIENT_KEY = process.env.FLAGPILOT_CLIENT_KEY ?? 'dev-only-client-key-public';
// The host's server holds the SDK key; the page never sees it.
const signer = createFlagClient({
  apiUrl: API_URL,
  apiKey: process.env.FLAGPILOT_SDK_KEY ?? 'dev-only-sdk-api-key-change-me',
});

/**
 * The host page. Reads a scenario from the query string, runs the SDK, and
 * publishes what happened on `window`. It also records every uncaught error
 * and unhandled rejection: the tests require there to be none.
 */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>flagpilot browser fixture</title></head>
<body>
<p id="host">host page running</p>
<script>
  window.__errors = [];
  window.addEventListener('error', (e) => window.__errors.push('error: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => window.__errors.push('unhandledrejection: ' + String(e.reason)));
</script>
<script type="module">
  import { createBrowserClient } from '/sdk/browser.js';
  const params = new URLSearchParams(location.search);
  const config = JSON.parse(params.get('config') || '{}');
  const signAs = params.get('signAs');
  if (signAs) {
    const response = await fetch('/sign?userId=' + encodeURIComponent(signAs));
    config.signedContext = (await response.json()).token;
  }
  const client = createBrowserClient({ apiUrl: ${JSON.stringify(API_URL)}, clientKey: ${JSON.stringify(
    CLIENT_KEY,
  )}, ...config });
  window.__client = client;
  await client.ready(Number(params.get('wait') || 8000));
  window.__results = { flags: { ...client.getAll() }, status: client.getStatus() };
  // The host keeps running after the SDK, whatever happened inside it.
  document.getElementById('host').textContent = 'host page finished';
  window.__done = true;
</script>
</body></html>`;

function send(res, status, type, body, extraHeaders = {}) {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...extraHeaders });
  res.end(body);
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://fixture');
  switch (url.pathname) {
    case '/health':
      return send(res, 200, 'text/plain', 'ok');
    case '/sdk/browser.js':
      // CORS for the sandboxed-iframe case: an opaque-origin document fetches
      // module scripts in CORS mode.
      return send(res, 200, 'text/javascript', await readFile(resolve(dist, 'browser.js')), {
        'access-control-allow-origin': '*',
      });
    case '/sign': {
      const token = await signer.signContext({ userId: url.searchParams.get('userId') ?? undefined });
      return send(res, 200, 'application/json', JSON.stringify({ token }));
    }
    case '/csp':
      // A strict policy that does not allow the flag service in connect-src.
      return send(res, 200, 'text/html', PAGE, {
        'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
      });
    case '/sandboxed':
      // A sandboxed frame has an opaque origin, which browsers send as `null`.
      return send(
        res,
        200,
        'text/html',
        `<!doctype html><iframe id="frame" sandbox="allow-scripts" src="/${url.search}"></iframe>`,
      );
    case '/':
      return send(res, 200, 'text/html', PAGE);
    default:
      return send(res, 404, 'text/plain', 'not found');
  }
}

for (const port of [5174, 5175]) {
  createServer((req, res) => {
    handle(req, res).catch((err) => send(res, 500, 'text/plain', String(err)));
  }).listen(port, () => console.log(`[fixture] http://localhost:${port}`));
}
