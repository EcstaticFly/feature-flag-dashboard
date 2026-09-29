import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog, SYSTEM_INTEGRATION_ACTOR } from '../src/db/schema.js';
import { ADMIN_EMAIL, AUTH, startTestApp, type TestApp } from './helpers/test-app.js';

/**
 * POST /api/integrations/alert — the receiving end of an external alert.
 *
 * Nothing calls it yet; these tests are what prove it will work unchanged when
 * the error tracker arrives.
 */

let ctx: TestApp;

const auth = () => ({ Authorization: `Bearer ${ctx.token}` });
const integrationKey = () => ({ 'x-integration-key': AUTH.integrationApiKey });

const ALERT = { reason: 'error rate 12% over 5 minutes', source: 'error-tracker' };

async function createFlag(key: string, enabled = true): Promise<void> {
  await request(ctx.app)
    .post('/api/flags')
    .set(auth())
    .send({ key, name: key, enabled, rolloutPercentage: 25 })
    .expect(201);
}

async function systemAuditRows(key: string) {
  const flag = (await request(ctx.app).get(`/api/flags/${key}`).set(auth())).body as { id: string };
  return ctx.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.flagId, flag.id), eq(auditLog.actor, SYSTEM_INTEGRATION_ACTOR)));
}

const alert = (body: Record<string, unknown>) =>
  request(ctx.app).post('/api/integrations/alert').set(integrationKey()).send(body);

beforeAll(async () => {
  ctx = await startTestApp({ withRedis: true });
});

afterAll(async () => {
  await ctx?.close();
});

describe('disabling a flag', () => {
  it('turns the flag off and says it acted', async () => {
    await createFlag('spiking-flag');

    const res = await alert({ flagKey: 'spiking-flag', ...ALERT });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      flagKey: 'spiking-flag',
      disabled: true,
      alreadyDisabled: false,
      auditLogged: true,
    });

    const flag = await request(ctx.app).get('/api/flags/spiking-flag').set(auth());
    expect(flag.body.enabled).toBe(false);
    // The rollout is untouched — only the kill switch was thrown.
    expect(flag.body.rolloutPercentage).toBe(25);
  });

  it('records why, attributed to the system (FR-12)', async () => {
    const entries = await request(ctx.app).get('/api/flags/spiking-flag/audit').set(auth());
    const [latest] = entries.body.entries;

    expect(latest).toMatchObject({
      action: 'update',
      actor: SYSTEM_INTEGRATION_ACTOR,
      actorLabel: 'System (integration)',
      metadata: ALERT,
    });
    expect(latest.oldValue).toMatchObject({ enabled: true });
    expect(latest.newValue).toMatchObject({ enabled: false });
  });

  it('reaches running SDKs, because it goes through the flag service', async () => {
    const sdk = await request(ctx.app)
      .get('/api/sdk/flags')
      .set({ 'x-api-key': AUTH.sdkApiKey });

    expect(sdk.body.flags).toContainEqual(
      expect.objectContaining({ key: 'spiking-flag', enabled: false }),
    );
  });
});

describe('idempotency', () => {
  // The milestone's named requirement: the caller retries on its own timeouts,
  // so the same alert can arrive twice.
  it('writes exactly one audit entry when the same alert arrives twice', async () => {
    await createFlag('retried-flag');

    const first = await alert({ flagKey: 'retried-flag', ...ALERT });
    const second = await alert({ flagKey: 'retried-flag', ...ALERT });

    expect(first.body).toMatchObject({ alreadyDisabled: false, auditLogged: true });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ alreadyDisabled: true, auditLogged: false });

    expect(await systemAuditRows('retried-flag')).toHaveLength(1);
  });

  it('stays quiet through a burst of retries', async () => {
    await createFlag('burst-flag');
    for (let i = 0; i < 5; i += 1) {
      await alert({ flagKey: 'burst-flag', ...ALERT });
    }

    expect(await systemAuditRows('burst-flag')).toHaveLength(1);
  });

  it('writes nothing at all for a flag that was already off', async () => {
    await createFlag('already-off-flag', false);

    const res = await alert({ flagKey: 'already-off-flag', ...ALERT });

    expect(res.body).toMatchObject({ alreadyDisabled: true, auditLogged: false });
    expect(await systemAuditRows('already-off-flag')).toHaveLength(0);
  });

  it('acts again if a human turns the flag back on', async () => {
    // The recovery story: a false positive is re-enabled by a person, and a
    // later alert can legitimately disable it again.
    await request(ctx.app)
      .patch('/api/flags/retried-flag')
      .set(auth())
      .send({ enabled: true })
      .expect(200);

    const res = await alert({ flagKey: 'retried-flag', reason: 'it spiked again', source: 'error-tracker' });

    expect(res.body).toMatchObject({ alreadyDisabled: false, auditLogged: true });
    expect(await systemAuditRows('retried-flag')).toHaveLength(2);
  });
});

describe('the audit trail tells the whole story (SRS 5.4)', () => {
  it('shows the auto-disable and the human recovery, newest first', async () => {
    await createFlag('story-flag');
    await alert({ flagKey: 'story-flag', ...ALERT });
    await request(ctx.app)
      .patch('/api/flags/story-flag')
      .set(auth())
      .send({ enabled: true })
      .expect(200);

    const { body } = await request(ctx.app).get('/api/flags/story-flag/audit').set(auth());

    expect(body.entries.map((e: { actorLabel: string }) => e.actorLabel)).toEqual([
      ADMIN_EMAIL, // the human put it back
      'System (integration)', // the system took it down
      ADMIN_EMAIL, // the human created it
    ]);
    // A human's change carries no integration metadata.
    expect(body.entries[0].metadata).toBeNull();
    expect(body.entries[1].metadata).toEqual(ALERT);
  });
});

describe('rejections', () => {
  it('404s for an unknown flag', async () => {
    const res = await alert({ flagKey: 'no-such-flag', ...ALERT });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('flag_not_found');
  });

  it('404s for a soft-deleted flag', async () => {
    await createFlag('deleted-flag');
    await request(ctx.app).delete('/api/flags/deleted-flag').set(auth()).expect(204);

    expect((await alert({ flagKey: 'deleted-flag', ...ALERT })).status).toBe(404);
  });

  it.each([
    ['no reason', { flagKey: 'spiking-flag', source: 'error-tracker' }],
    ['no source', { flagKey: 'spiking-flag', reason: 'boom' }],
    ['an empty reason', { flagKey: 'spiking-flag', reason: '', source: 'x' }],
    ['no flagKey', { ...ALERT }],
    ['a non-slug flagKey', { flagKey: 'Not A Slug', ...ALERT }],
    ['an unknown extra field', { flagKey: 'spiking-flag', ...ALERT, severity: 'high' }],
  ])('400s for %s', async (_label, body) => {
    const res = await alert(body);
    expect(res.status).toBe(400);
  });
});

describe('the credential boundary', () => {
  const post = () =>
    request(ctx.app).post('/api/integrations/alert').send({ flagKey: 'spiking-flag', ...ALERT });

  it('401s without a key', async () => {
    expect((await post()).status).toBe(401);
  });

  it('401s with a wrong key', async () => {
    expect((await post().set({ 'x-integration-key': 'nope' })).status).toBe(401);
  });

  // Both directions matter: this endpoint always writes `system:integration` as
  // the actor, so accepting a human's token would make that attribution a lie.
  it('401s for an admin token', async () => {
    expect((await post().set(auth())).status).toBe(401);
  });

  it('401s for the SDK key', async () => {
    expect((await post().set({ 'x-api-key': AUTH.sdkApiKey })).status).toBe(401);
  });

  it('does not let the integration key touch flag CRUD', async () => {
    expect((await request(ctx.app).get('/api/flags').set(integrationKey())).status).toBe(401);
    expect(
      (await request(ctx.app).delete('/api/flags/spiking-flag').set(integrationKey())).status,
    ).toBe(401);
  });
});
