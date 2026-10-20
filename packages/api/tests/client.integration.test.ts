import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { CacheUnavailableError, type FlagCache } from '../src/services/cache/flag-cache.js';
import { signForTest } from './helpers/sign.js';
import { ALLOWED_ORIGIN, AUTH, CLIENT_KEY, startTestApp, type TestApp } from './helpers/test-app.js';

/*
 * POST /api/client/flags — the browser endpoint.
 *
 * Its key is public, so these tests are mostly about what it refuses: which
 * flags it hides, which callers it turns away, and which identities it will
 * not take on a browser's word.
 *
 * Bucket facts relied on below (frozen hash, pinned in core's golden tests):
 * for 'new-checkout-flow', carol is bucket 2 and alice bucket 34.
 */

let ctx: TestApp;
const admin = () => ({ Authorization: `Bearer ${ctx.token}` });

const client = (body: unknown = {}, origin: string | null = ALLOWED_ORIGIN) => {
  const req = request(ctx.app)
    .post('/api/client/flags')
    .set('x-flagpilot-client-key', CLIENT_KEY)
    .set('content-type', 'application/json');
  if (origin !== null) req.set('Origin', origin);
  return req.send(JSON.stringify(body));
};

async function createFlag(body: Record<string, unknown>): Promise<void> {
  await request(ctx.app).post('/api/flags').set(admin()).send(body).expect(201);
}

beforeAll(async () => {
  ctx = await startTestApp({ clientApi: {} });
  await createFlag({ key: 'browser-on', name: 'On', enabled: true, rolloutPercentage: 100, clientSide: true });
  await createFlag({ key: 'browser-off', name: 'Off', enabled: false, rolloutPercentage: 100, clientSide: true });
  await createFlag({ key: 'server-only', name: 'Hidden', enabled: true, rolloutPercentage: 100 });
  await createFlag({
    key: 'new-checkout-flow',
    name: 'Checkout',
    enabled: true,
    rolloutPercentage: 10,
    clientSide: true,
  });
  await createFlag({
    key: 'beta-banner',
    name: 'Beta',
    enabled: true,
    rolloutPercentage: 0,
    clientSide: true,
    targetingRules: [{ attribute: 'userId', operator: 'in', values: ['heidi'] }],
  });
});

afterAll(async () => {
  await ctx?.close();
});

describe('what a browser can see', () => {
  it('returns only flags exposed to browsers, as booleans', async () => {
    const res = await client().expect(200);
    expect(res.body).toEqual({
      flags: {
        'beta-banner': true,
        'browser-off': false,
        'browser-on': true,
        'new-checkout-flow': true,
      },
    });
  });

  it('does not reveal that a server-only flag exists — absent, not false', async () => {
    const res = await client().expect(200);
    expect(Object.keys(res.body.flags)).not.toContain('server-only');
  });

  it('never sends rules, percentages, reasons or buckets', async () => {
    const res = await client({ signedContext: signForTest({ userId: 'alice' }, AUTH.sdkApiKey) });
    const text = JSON.stringify(res.body);
    for (const leak of ['rolloutPercentage', 'targetingRules', 'reason', 'bucket', 'heidi']) {
      expect(text).not.toContain(leak);
    }
    for (const value of Object.values(res.body.flags)) expect(typeof value).toBe('boolean');
  });

  it('sets the response headers that keep it out of caches and sniffers', async () => {
    const res = await client().expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['vary']).toMatch(/Origin/);
  });

  it('reports handler time for the load test, without exposing it to cross-origin pages', async () => {
    const res = await client().expect(200); // from an allowed origin
    expect(res.headers['server-timing']).toMatch(/^app;dur=\d+(\.\d+)?$/);
    expect(res.headers['access-control-expose-headers']).toBeUndefined();
  });
});

describe('identity', () => {
  it('evaluates a signed user against the rollout', async () => {
    const carol = await client({ signedContext: signForTest({ userId: 'carol' }, AUTH.sdkApiKey) });
    const alice = await client({ signedContext: signForTest({ userId: 'alice' }, AUTH.sdkApiKey) });
    expect(carol.body.flags['new-checkout-flow']).toBe(true);
    expect(alice.body.flags['new-checkout-flow']).toBe(false);
  });

  it('applies an allowlist for a signed user', async () => {
    const heidi = await client({ signedContext: signForTest({ userId: 'heidi' }, AUTH.sdkApiKey) });
    const alice = await client({ signedContext: signForTest({ userId: 'alice' }, AUTH.sdkApiKey) });
    expect(heidi.body.flags['beta-banner']).toBe(true);
    expect(alice.body.flags['beta-banner']).toBe(false);
  });

  it('refuses a browser naming its own user while signing is required', async () => {
    const res = await client({ context: { userId: 'heidi' } }).expect(403);
    expect(res.body.error.code).toBe('signed_context_required');
  });

  it('refuses unsigned attributes too — they are as spoofable as an id', async () => {
    const res = await client({ context: { attributes: { plan: 'pro' } } }).expect(403);
    expect(res.body.error.code).toBe('signed_context_required');
  });

  it('still serves an anonymous request with nothing but the public key', async () => {
    await client({}).expect(200);
    await client({ context: {} }).expect(200);
  });

  it('refuses a token that was altered or signed with another key, with one answer for both', async () => {
    const foreign = signForTest({ userId: 'heidi' }, 'another-deployments-sdk-key');
    const genuine = signForTest({ userId: 'alice' }, AUTH.sdkApiKey).split('.');
    const altered = `v1.${Buffer.from('{"userId":"heidi"}').toString('base64url')}.${genuine[2]}`;
    for (const signedContext of [foreign, altered, 'not-a-token']) {
      const res = await client({ signedContext }).expect(403);
      expect(res.body.error.code).toBe('invalid_signed_context');
    }
  });

  it('refuses a body carrying both a context and a signed context', async () => {
    const signedContext = signForTest({ userId: 'alice' }, AUTH.sdkApiKey);
    const res = await client({ signedContext, context: { userId: 'heidi' } }).expect(400);
    expect(res.body.error.code).toBe('ambiguous_context');
  });
});

describe('CORS', () => {
  it('echoes an allowed origin and never allows credentials', async () => {
    const res = await client().expect(200);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('refuses an origin that is not allowed, with no CORS headers at all', async () => {
    const res = await client({}, 'https://evil.example').expect(403);
    expect(res.body.error.code).toBe('origin_not_allowed');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows a request with no Origin — a host server proxying, not a browser', async () => {
    await client({}, null).expect(200);
  });

  it('answers an allowed preflight without needing the key', async () => {
    const res = await request(ctx.app)
      .options('/api/client/flags')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type, x-flagpilot-client-key')
      .expect(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.headers['access-control-allow-methods']).toBe('POST');
    expect(res.headers['access-control-allow-headers']).toBe('content-type, x-flagpilot-client-key');
    expect(res.headers['access-control-max-age']).toBe('7200');
  });

  it('refuses a preflight from a disallowed origin', async () => {
    const res = await request(ctx.app)
      .options('/api/client/flags')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST')
      .expect(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('puts CORS headers on errors, so an allowed page can read why it failed', async () => {
    const res = await request(ctx.app)
      .post('/api/client/flags')
      .set('Origin', ALLOWED_ORIGIN)
      .set('content-type', 'application/json')
      .send('{}')
      .expect(401);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.body.error.code).toBe('invalid_client_key');
  });
});

describe('what it refuses to process', () => {
  it('requires the client key', async () => {
    const res = await request(ctx.app)
      .post('/api/client/flags')
      .set('content-type', 'application/json')
      .send('{}')
      .expect(401);
    expect(res.body.error.code).toBe('invalid_client_key');
  });

  it('logs — without the key — when a secret is sent as the client key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await request(ctx.app)
        .post('/api/client/flags')
        .set('Origin', ALLOWED_ORIGIN)
        .set('x-flagpilot-client-key', AUTH.sdkApiKey)
        .set('content-type', 'application/json')
        .send('{}')
        .expect(401);
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('secret_key_sent_as_client_key');
      expect(logged).not.toContain(AUTH.sdkApiKey);
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses a body that is not JSON-typed', async () => {
    const res = await request(ctx.app)
      .post('/api/client/flags')
      .set('x-flagpilot-client-key', CLIENT_KEY)
      .set('content-type', 'text/plain')
      .send('{}')
      .expect(415);
    expect(res.body.error.code).toBe('unsupported_media_type');
  });

  it('refuses a body over 8 KB with 413, not 500', async () => {
    const res = await client({ context: { userId: 'u'.repeat(9 * 1024) } }).expect(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });

  it('refuses malformed JSON', async () => {
    const res = await request(ctx.app)
      .post('/api/client/flags')
      .set('x-flagpilot-client-key', CLIENT_KEY)
      .set('content-type', 'application/json')
      .send('{not json')
      .expect(400);
    expect(res.body.error.code).toBe('invalid_json');
  });

  it('refuses unknown body fields', async () => {
    const res = await client({ context: {}, admin: true }).expect(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('never writes a user id, attributes, key or token into its logs', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const signedContext = signForTest({ userId: 'carol', attributes: { email: 'c@x.io' } }, AUTH.sdkApiKey);
      await client({ signedContext }).expect(200);
      const logged = log.mock.calls.map((c) => String(c[0])).join('\n');
      for (const secret of ['carol', 'c@x.io', CLIENT_KEY, signedContext]) {
        expect(logged).not.toContain(secret);
      }
    } finally {
      log.mockRestore();
    }
  });
});

describe('when signing is optional', () => {
  const optionalApp = () =>
    createApp({
      db: ctx.db,
      flags: ctx.flags,
      cache: ctx.cache,
      fallback: false,
      auth: AUTH,
      checks: {},
      clientApi: {
        clientApiKey: CLIENT_KEY,
        allowedOrigins: '*',
        requireSignedContext: false,
        sdkApiKey: AUTH.sdkApiKey,
        secretKeys: [AUTH.sdkApiKey],
      },
    });

  const post = (body: unknown) =>
    request(optionalApp())
      .post('/api/client/flags')
      .set('Origin', 'https://anywhere.example')
      .set('x-flagpilot-client-key', CLIENT_KEY)
      .set('content-type', 'application/json')
      .send(JSON.stringify(body));

  it('accepts a plain context and evaluates it', async () => {
    const res = await post({ context: { userId: 'carol' } }).expect(200);
    expect(res.body.flags['new-checkout-flow']).toBe(true);
  });

  it('answers any origin with a literal * in wildcard mode', async () => {
    const res = await post({}).expect(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('still enforces the context rules', async () => {
    const res = await post({ context: { userId: 'u1', attributes: { constructor: 'x' } } }).expect(400);
    expect(res.body.error.code).toBe('invalid_context');
  });
});

describe('when no flag source is reachable', () => {
  it('answers 503 rather than an empty map, which would switch every browser flag off', async () => {
    const deadCache = {
      getAll: () => Promise.reject(new CacheUnavailableError('down')),
    } as unknown as FlagCache;
    const app = createApp({
      db: ctx.db,
      flags: ctx.flags,
      cache: deadCache,
      fallback: false,
      auth: AUTH,
      checks: {},
      clientApi: {
        clientApiKey: CLIENT_KEY,
        allowedOrigins: [ALLOWED_ORIGIN],
        requireSignedContext: true,
        sdkApiKey: AUTH.sdkApiKey,
        secretKeys: [],
      },
    });
    const res = await request(app)
      .post('/api/client/flags')
      .set('Origin', ALLOWED_ORIGIN)
      .set('x-flagpilot-client-key', CLIENT_KEY)
      .set('content-type', 'application/json')
      .send('{}')
      .expect(503);
    expect(res.body.error.code).toBe('flags_unavailable');
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
  });
});

describe('when the browser API is not configured', () => {
  it('does not exist at all', async () => {
    const app = createApp({
      db: ctx.db,
      flags: ctx.flags,
      cache: ctx.cache,
      fallback: false,
      auth: AUTH,
      checks: {},
    });
    await request(app)
      .post('/api/client/flags')
      .set('x-flagpilot-client-key', CLIENT_KEY)
      .set('content-type', 'application/json')
      .send('{}')
      .expect(404);
  });
});
