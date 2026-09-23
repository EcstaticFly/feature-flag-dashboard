import { asc, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog } from '../src/db/schema.js';
import {
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  AUTH,
  startTestApp,
  type TestApp,
} from './helpers/test-app.js';

let ctx: TestApp;

const auth = () => ({ Authorization: `Bearer ${ctx.token}` });
const sdkKey = () => ({ 'x-api-key': AUTH.sdkApiKey });

async function auditRowsFor(flagId: string) {
  return ctx.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.flagId, flagId))
    .orderBy(asc(auditLog.createdAt));
}

beforeAll(async () => {
  ctx = await startTestApp();
});

afterAll(async () => {
  await ctx?.close();
});

describe('POST /api/auth/login', () => {
  it('issues a token for the seeded admin', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: ADMIN_EMAIL, role: 'admin' });
    expect(typeof res.body.token).toBe('string');
    expect(res.body).not.toHaveProperty('user.passwordHash');
  });

  it('gives the same 401 for a wrong password and an unknown email', async () => {
    const wrongPassword = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: ADMIN_EMAIL, password: 'nope' });
    const unknownEmail = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: ADMIN_PASSWORD });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(unknownEmail.body).toEqual(wrongPassword.body);
  });

  it('is case-insensitive on the email', async () => {
    const res = await request(ctx.app)
      .post('/api/auth/login')
      .send({ email: ADMIN_EMAIL.toUpperCase(), password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
  });
});

describe('flag lifecycle', () => {
  it('creates, reads, updates, lists and soft-deletes a flag, auditing each change', async () => {
    // create
    const created = await request(ctx.app)
      .post('/api/flags')
      .set(auth())
      .send({ key: 'new-checkout-flow', name: 'New checkout', description: 'v2 checkout' });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      key: 'new-checkout-flow',
      enabled: false,
      rolloutPercentage: 0,
      targetingRules: [],
    });
    const flagId = created.body.id as string;

    // read
    const fetched = await request(ctx.app).get('/api/flags/new-checkout-flow').set(auth());
    expect(fetched.status).toBe(200);
    expect(fetched.body.id).toBe(flagId);

    // update
    const patched = await request(ctx.app)
      .patch('/api/flags/new-checkout-flow')
      .set(auth())
      .send({
        enabled: true,
        rolloutPercentage: 25,
        targetingRules: [{ attribute: 'userId', operator: 'in', values: ['user-007'] }],
      });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ enabled: true, rolloutPercentage: 25 });

    // the SDK sees it, with only config fields
    const sdk = await request(ctx.app).get('/api/sdk/flags').set(sdkKey());
    expect(sdk.status).toBe(200);
    expect(sdk.body.flags).toEqual([
      {
        key: 'new-checkout-flow',
        enabled: true,
        rolloutPercentage: 25,
        targetingRules: [{ attribute: 'userId', operator: 'in', values: ['user-007'] }],
      },
    ]);

    // delete
    expect(
      (await request(ctx.app).delete('/api/flags/new-checkout-flow').set(auth())).status,
    ).toBe(204);

    // gone from both listings and from the detail route
    expect((await request(ctx.app).get('/api/flags').set(auth())).body.flags).toEqual([]);
    expect((await request(ctx.app).get('/api/sdk/flags').set(sdkKey())).body.flags).toEqual([]);
    expect((await request(ctx.app).get('/api/flags/new-checkout-flow').set(auth())).status).toBe(
      404,
    );

    // ...but the audit trail survives and is still linked to the flag
    const rows = await auditRowsFor(flagId);
    expect(rows.map((r) => r.action)).toEqual(['create', 'update', 'delete']);
    expect(rows.every((r) => r.actor === ctx.adminId)).toBe(true);

    const [create, update, remove] = rows;
    expect(create!.oldValue).toBeNull();
    expect(create!.newValue).toMatchObject({ key: 'new-checkout-flow', enabled: false });
    expect(update!.oldValue).toMatchObject({ enabled: false, rolloutPercentage: 0 });
    expect(update!.newValue).toMatchObject({ enabled: true, rolloutPercentage: 25 });
    expect(remove!.oldValue).toMatchObject({ key: 'new-checkout-flow' });
    expect(remove!.newValue).toBeNull();
  });

  it('allows a deleted key to be reused', async () => {
    const recreated = await request(ctx.app)
      .post('/api/flags')
      .set(auth())
      .send({ key: 'new-checkout-flow', name: 'New checkout, take two' });

    expect(recreated.status).toBe(201);
    await request(ctx.app).delete('/api/flags/new-checkout-flow').set(auth());
  });

  it('writes no audit row when a PATCH changes nothing', async () => {
    const created = await request(ctx.app)
      .post('/api/flags')
      .set(auth())
      .send({ key: 'noop-flag', name: 'No-op', rolloutPercentage: 10 });
    const flagId = created.body.id as string;

    const res = await request(ctx.app)
      .patch('/api/flags/noop-flag')
      .set(auth())
      .send({ rolloutPercentage: 10 });

    expect(res.status).toBe(200);
    expect(res.body.updatedAt).toBe(created.body.updatedAt);
    expect((await auditRowsFor(flagId)).map((r) => r.action)).toEqual(['create']);
  });
});

describe('error handling', () => {
  it('returns 409, not 500, for a duplicate key', async () => {
    await request(ctx.app).post('/api/flags').set(auth()).send({ key: 'dupe-flag', name: 'First' });
    const res = await request(ctx.app)
      .post('/api/flags')
      .set(auth())
      .send({ key: 'dupe-flag', name: 'Second' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('flag_key_exists');
  });

  it('returns 400 with field details for an invalid key', async () => {
    const res = await request(ctx.app)
      .post('/api/flags')
      .set(auth())
      .send({ key: 'Not A Slug', name: 'x' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
    expect(res.body.error.details).toContainEqual(
      expect.objectContaining({ path: 'key' }),
    );
  });

  it.each([
    ['unknown operator', [{ attribute: 'userId', operator: 'startsWith', values: ['u1'] }]],
    ['empty values', [{ attribute: 'userId', operator: 'in', values: [] }]],
    ['not an array', { attribute: 'userId', operator: 'in', values: ['u1'] }],
  ])('returns 400 for targeting rules with %s', async (_label, targetingRules) => {
    const res = await request(ctx.app)
      .post('/api/flags')
      .set(auth())
      .send({ key: 'rule-check', name: 'x', targetingRules });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('returns 400 invalid_json for a malformed body, not 500', async () => {
    const res = await request(ctx.app)
      .post('/api/flags')
      .set(auth())
      .set('Content-Type', 'application/json')
      .send('{"key": "broken",');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_json');
  });

  it('returns 404 for an unknown flag', async () => {
    expect((await request(ctx.app).get('/api/flags/does-not-exist').set(auth())).status).toBe(404);
    expect(
      (await request(ctx.app).patch('/api/flags/does-not-exist').set(auth()).send({ enabled: true }))
        .status,
    ).toBe(404);
    expect((await request(ctx.app).delete('/api/flags/does-not-exist').set(auth())).status).toBe(
      404,
    );
  });
});

describe('authorization', () => {
  it.each([
    ['GET', '/api/flags'],
    ['POST', '/api/flags'],
    ['GET', '/api/flags/some-flag'],
    ['PATCH', '/api/flags/some-flag'],
    ['DELETE', '/api/flags/some-flag'],
  ])('rejects unauthenticated %s %s with 401', async (method, path) => {
    const res = await (request(ctx.app) as never as Record<string, (p: string) => request.Test>)[
      method.toLowerCase()
    ]!(path);
    expect(res.status).toBe(401);
  });

  it('rejects the SDK key on every CRUD route', async () => {
    expect((await request(ctx.app).get('/api/flags').set(sdkKey())).status).toBe(401);
    expect(
      (await request(ctx.app).post('/api/flags').set(sdkKey()).send({ key: 'x', name: 'x' })).status,
    ).toBe(401);
  });

  it('rejects a missing or wrong x-api-key on the SDK route', async () => {
    expect((await request(ctx.app).get('/api/sdk/flags')).status).toBe(401);
    expect((await request(ctx.app).get('/api/sdk/flags').set('x-api-key', 'wrong')).status).toBe(
      401,
    );
  });

  it('lets an admin token read the SDK route', async () => {
    expect((await request(ctx.app).get('/api/sdk/flags').set(auth())).status).toBe(200);
  });
});
