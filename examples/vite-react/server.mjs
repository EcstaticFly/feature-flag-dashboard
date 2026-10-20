// The backend half of the Vite example: it signs identities for the browser.
//
// In a real app this is your existing API: wherever you return the logged-in
// user (a /me or /session endpoint), also return `await signContext({ userId })`.
// The SDK key stays here, on the server. The Vite dev server proxies /session
// to this process (see vite.config.js).
//
//   cp .env.example .env.local   # then: npm run signer, and npm run dev

import express from 'express';
import { getStatus, init, signContext } from 'flagpilot';

try {
  // Values already in the environment win over the file.
  process.loadEnvFile(new URL('.env.local', import.meta.url));
} catch {
  // No .env.local: the environment alone is used.
}

const PORT = Number(process.env.SIGNER_PORT ?? 5180);
const DEMO_USERS = new Set(['alice', 'heidi']);

// Never throws. With a bad or missing key, signContext returns null and the
// browser simply asks as an anonymous visitor.
await init({
  apiUrl: process.env.FLAGPILOT_API_URL ?? 'http://localhost:4000',
  apiKey: process.env.FLAGPILOT_SDK_KEY ?? '',
});

const app = express();

app.get('/session', async (req, res) => {
  // A stand-in for real authentication.
  const user = typeof req.query.user === 'string' && DEMO_USERS.has(req.query.user) ? req.query.user : null;
  res.set('Cache-Control', 'no-store');
  res.json({ user, flagToken: user ? await signContext({ userId: user }) : null });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, sdk: getStatus().state });
});

app.listen(PORT, () => {
  console.log(`[signer] http://localhost:${PORT} (sdk: ${getStatus().state})`);
});
