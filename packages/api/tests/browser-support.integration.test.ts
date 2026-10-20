import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ALLOWED_ORIGIN, AUTH, CLIENT_KEY, startTestApp, type TestApp } from './helpers/test-app.js';

/*
 * Everything browser support changed outside the browser endpoint itself:
 * the per-flag `clientSide` field, the guard that refuses secret keys coming
 * from a browser, and the settings the dashboard's setup page reads.
 */

let ctx: TestApp;
const admin = () => ({ Authorization: `Bearer ${ctx.token}` });

beforeAll(async () => {
  ctx = await startTestApp({ clientApi: {} });
});

afterAll(async () => {
  await ctx?.close();
});

async function auditCount(key: string): Promise<number> {
  const res = await request(ctx.app).get(`/api/flags/${key}/audit`).set(admin()).expect(200);
  return res.body.entries.length;
}

describe('the clientSide field', () => {
  it('defaults to false — every flag starts server-only', async () => {
    const res = await request(ctx.app)
      .post('/api/flags')
      .set(admin())
      .send({ key: 'cs-default', name: 'Default' })
      .expect(201);
    expect(res.body.clientSide).toBe(false);
  });

  it('can be set at creation and is returned by the flag routes', async () => {
    await request(ctx.app)
      .post('/api/flags')
      .set(admin())
      .send({ key: 'cs-created', name: 'Created', clientSide: true })
      .expect(201);
    const one = await request(ctx.app).get('/api/flags/cs-created').set(admin()).expect(200);
    expect(one.body.clientSide).toBe(true);
    const list = await request(ctx.app).get('/api/flags').set(admin()).expect(200);
    expect(list.body.flags.find((f: { key: string }) => f.key === 'cs-created').clientSide).toBe(true);
  });

  // The trap: updateFlag only writes when a field in MUTABLE_FIELDS changed.
  // Without clientSide there, this PATCH would return 200 having changed nothing.
  it('toggling only clientSide is a real change: it persists and is audited', async () => {
    await request(ctx.app).post('/api/flags').set(admin()).send({ key: 'cs-toggle', name: 'Toggle' }).expect(201);
    const before = await auditCount('cs-toggle');

    const res = await request(ctx.app)
      .patch('/api/flags/cs-toggle')
      .set(admin())
      .send({ clientSide: true })
      .expect(200);
    expect(res.body.clientSide).toBe(true);
    expect(await auditCount('cs-toggle')).toBe(before + 1);

    const audit = await request(ctx.app).get('/api/flags/cs-toggle/audit').set(admin()).expect(200);
    expect(audit.body.entries[0].oldValue.clientSide).toBe(false);
    expect(audit.body.entries[0].newValue.clientSide).toBe(true);
  });

  it('setting clientSide to its current value is still a no-op with no audit row', async () => {
    await request(ctx.app)
      .post('/api/flags')
      .set(admin())
      .send({ key: 'cs-noop', name: 'Noop', clientSide: true })
      .expect(201);
    const before = await auditCount('cs-noop');
    await request(ctx.app).patch('/api/flags/cs-noop').set(admin()).send({ clientSide: true }).expect(200);
    expect(await auditCount('cs-noop')).toBe(before);
  });

  it('rejects a non-boolean clientSide', async () => {
    await request(ctx.app)
      .post('/api/flags')
      .set(admin())
      .send({ key: 'cs-bad', name: 'Bad', clientSide: 'yes' })
      .expect(400);
  });

  it('is part of the server SDK feed, which 0.1.0 SDKs safely ignore', async () => {
    const res = await request(ctx.app)
      .get('/api/sdk/flags')
      .set('x-api-key', AUTH.sdkApiKey)
      .expect(200);
    const created = res.body.flags.find((f: { key: string }) => f.key === 'cs-created');
    expect(created).toMatchObject({ key: 'cs-created', clientSide: true });
  });

  it('takes effect on the browser endpoint as soon as it is toggled', async () => {
    const browserKeys = async () => {
      const res = await request(ctx.app)
        .post('/api/client/flags')
        .set('x-flagpilot-client-key', CLIENT_KEY)
        .set('content-type', 'application/json')
        .send('{}')
        .expect(200);
      return Object.keys(res.body.flags);
    };

    await request(ctx.app).post('/api/flags').set(admin()).send({ key: 'cs-live', name: 'Live' }).expect(201);
    expect(await browserKeys()).not.toContain('cs-live');

    await request(ctx.app).patch('/api/flags/cs-live').set(admin()).send({ clientSide: true }).expect(200);
    expect(await browserKeys()).toContain('cs-live');

    await request(ctx.app).patch('/api/flags/cs-live').set(admin()).send({ clientSide: false }).expect(200);
    expect(await browserKeys()).not.toContain('cs-live');
  });
});

describe('secret keys are refused when they come from a browser', () => {
  it('refuses the SDK key with an Origin header, and logs the page but not the key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const res = await request(ctx.app)
        .get('/api/sdk/flags')
        .set('x-api-key', AUTH.sdkApiKey)
        .set('Origin', 'https://leaky.example')
        .expect(403);
      expect(res.body.error.code).toBe('secret_key_from_browser');
      const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('https://leaky.example');
      expect(logged).not.toContain(AUTH.sdkApiKey);
    } finally {
      warn.mockRestore();
    }
  });

  it('refuses the SDK key from a browser on the evaluate route too', async () => {
    await request(ctx.app)
      .get('/api/flags/cs-created/evaluate?userId=u1')
      .set('x-api-key', AUTH.sdkApiKey)
      .set('Origin', 'https://leaky.example')
      .expect(403);
  });

  it('refuses the integration key from a browser', async () => {
    const res = await request(ctx.app)
      .post('/api/integrations/alert')
      .set('x-integration-key', AUTH.integrationApiKey)
      .set('Origin', 'https://leaky.example')
      .send({ flagKey: 'cs-created', reason: 'r', source: 's' })
      .expect(403);
    expect(res.body.error.code).toBe('secret_key_from_browser');
  });

  it('leaves servers alone: the same key with no Origin works exactly as before', async () => {
    await request(ctx.app).get('/api/sdk/flags').set('x-api-key', AUTH.sdkApiKey).expect(200);
  });

  it('answers an invalid key from a browser with the usual 401, not a false alarm', async () => {
    const res = await request(ctx.app)
      .get('/api/sdk/flags')
      .set('x-api-key', 'wrong-key-wrong-key')
      .set('Origin', 'https://leaky.example')
      .expect(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('does not affect admin tokens', async () => {
    await request(ctx.app).get('/api/flags').set(admin()).set('Origin', ALLOWED_ORIGIN).expect(200);
  });
});

describe('GET /api/settings/sdk', () => {
  it('shows an admin the browser API settings, including the public client key', async () => {
    const res = await request(ctx.app).get('/api/settings/sdk').set(admin()).expect(200);
    expect(res.body).toEqual({
      serverSdk: { configured: true },
      browserSdk: {
        enabled: true,
        clientKey: CLIENT_KEY,
        allowedOrigins: [ALLOWED_ORIGIN],
        requireSignedContext: true,
      },
    });
  });

  it('never returns a secret, not even to an admin', async () => {
    const res = await request(ctx.app).get('/api/settings/sdk').set(admin()).expect(200);
    const body = JSON.stringify(res.body);
    for (const secret of [AUTH.sdkApiKey, AUTH.integrationApiKey, AUTH.jwtSecret]) {
      expect(body).not.toContain(secret);
    }
  });

  it('is admin-only: neither the SDK key nor no credential will do', async () => {
    await request(ctx.app).get('/api/settings/sdk').expect(401);
    await request(ctx.app).get('/api/settings/sdk').set('x-api-key', AUTH.sdkApiKey).expect(401);
  });
});
