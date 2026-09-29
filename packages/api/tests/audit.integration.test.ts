import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SYSTEM_INTEGRATION_ACTOR } from '../src/db/schema.js';
import { AUDIT_MAX_LIMIT } from '../src/services/flags/flag-service.js';
import { ADMIN_EMAIL, AUTH, startTestApp, type TestApp } from './helpers/test-app.js';

/**
 * The audit log has been written since Milestone 1 but was readable nowhere.
 * The dashboard needs it, so Milestone 5 exposes it.
 */

let ctx: TestApp;

const auth = () => ({ Authorization: `Bearer ${ctx.token}` });
const sdkKey = () => ({ 'x-api-key': AUTH.sdkApiKey });

beforeAll(async () => {
  ctx = await startTestApp();
});

afterAll(async () => {
  await ctx?.close();
});

describe('GET /api/flags/:key/audit', () => {
  it('returns every change newest first, with the actor resolved to an email', async () => {
    await request(ctx.app)
      .post('/api/flags')
      .set(auth())
      .send({ key: 'history-flag', name: 'History', enabled: true, rolloutPercentage: 10 })
      .expect(201);
    await request(ctx.app)
      .patch('/api/flags/history-flag')
      .set(auth())
      .send({ rolloutPercentage: 60 })
      .expect(200);
    await request(ctx.app)
      .patch('/api/flags/history-flag')
      .set(auth())
      .send({ enabled: false })
      .expect(200);

    const res = await request(ctx.app).get('/api/flags/history-flag/audit').set(auth());

    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { action: string }) => e.action)).toEqual([
      'update',
      'update',
      'create',
    ]);
    // A bare uuid is useless on screen; the join turns it into something readable.
    expect(res.body.entries.every((e: { actorLabel: string }) => e.actorLabel === ADMIN_EMAIL)).toBe(
      true,
    );
    expect(res.body.entries[0].actor).toBe(ctx.adminId);
  });

  it('carries the before and after values of each change', async () => {
    const res = await request(ctx.app).get('/api/flags/history-flag/audit').set(auth());
    const [latest, middle, created] = res.body.entries;

    expect(created).toMatchObject({ action: 'create', oldValue: null });
    expect(created.newValue).toMatchObject({ rolloutPercentage: 10, enabled: true });
    expect(middle.oldValue).toMatchObject({ rolloutPercentage: 10 });
    expect(middle.newValue).toMatchObject({ rolloutPercentage: 60 });
    expect(latest.oldValue).toMatchObject({ enabled: true });
    expect(latest.newValue).toMatchObject({ enabled: false });
  });

  it('labels a system-initiated change rather than showing a raw sentinel', async () => {
    // Milestone 6's integration endpoint will write rows exactly like this.
    await ctx.flags.updateFlag(SYSTEM_INTEGRATION_ACTOR, 'history-flag', { enabled: true });

    const res = await request(ctx.app).get('/api/flags/history-flag/audit').set(auth());

    expect(res.body.entries[0]).toMatchObject({
      actor: SYSTEM_INTEGRATION_ACTOR,
      actorLabel: 'System (integration)',
    });
  });

  it('honours ?limit and caps it', async () => {
    const limited = await request(ctx.app)
      .get('/api/flags/history-flag/audit?limit=2')
      .set(auth());
    expect(limited.body.entries).toHaveLength(2);

    const capped = await request(ctx.app)
      .get(`/api/flags/history-flag/audit?limit=${AUDIT_MAX_LIMIT + 5000}`)
      .set(auth());
    expect(capped.status).toBe(200);
    expect(capped.body.entries.length).toBeLessThanOrEqual(AUDIT_MAX_LIMIT);
  });

  it.each(['0', '-1', 'abc'])('rejects limit=%s', async (limit) => {
    const res = await request(ctx.app)
      .get(`/api/flags/history-flag/audit?limit=${limit}`)
      .set(auth());
    expect(res.status).toBe(400);
  });

  // The subtle one: a key can be reused after a soft delete, so querying audit
  // by key rather than by the live flag's id would surface the old flag's
  // history under the new flag.
  it('shows only the live flag’s history after a key is deleted and recreated', async () => {
    await request(ctx.app)
      .post('/api/flags')
      .set(auth())
      .send({ key: 'reused-key', name: 'First life', rolloutPercentage: 5 })
      .expect(201);
    await request(ctx.app)
      .patch('/api/flags/reused-key')
      .set(auth())
      .send({ rolloutPercentage: 55 })
      .expect(200);
    await request(ctx.app).delete('/api/flags/reused-key').set(auth()).expect(204);

    await request(ctx.app)
      .post('/api/flags')
      .set(auth())
      .send({ key: 'reused-key', name: 'Second life' })
      .expect(201);

    const res = await request(ctx.app).get('/api/flags/reused-key/audit').set(auth());

    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0]).toMatchObject({ action: 'create' });
    expect(res.body.entries[0].newValue).toMatchObject({ name: 'Second life' });
  });

  it('404s for an unknown key and for a soft-deleted one', async () => {
    expect((await request(ctx.app).get('/api/flags/no-such-flag/audit').set(auth())).status).toBe(
      404,
    );

    await request(ctx.app)
      .post('/api/flags')
      .set(auth())
      .send({ key: 'gone-flag', name: 'Gone' })
      .expect(201);
    await request(ctx.app).delete('/api/flags/gone-flag').set(auth()).expect(204);

    expect((await request(ctx.app).get('/api/flags/gone-flag/audit').set(auth())).status).toBe(404);
  });

  it('is admin-only', async () => {
    expect((await request(ctx.app).get('/api/flags/history-flag/audit')).status).toBe(401);
    expect(
      (await request(ctx.app).get('/api/flags/history-flag/audit').set(sdkKey())).status,
    ).toBe(401);
  });
});

describe('last updated by, on flag reads', () => {
  it('appears on the list and the detail view', async () => {
    const list = await request(ctx.app).get('/api/flags').set(auth());
    const flag = list.body.flags.find((f: { key: string }) => f.key === 'history-flag');

    expect(flag.lastUpdatedBy).toBe('System (integration)');
    expect(new Date(flag.lastUpdatedAt).getTime()).toBeGreaterThan(0);

    const detail = await request(ctx.app).get('/api/flags/history-flag').set(auth());
    expect(detail.body.lastUpdatedBy).toBe('System (integration)');
  });

  it('reflects the most recent change, not the first', async () => {
    await request(ctx.app)
      .patch('/api/flags/history-flag')
      .set(auth())
      .send({ name: 'Renamed by a human' })
      .expect(200);

    const detail = await request(ctx.app).get('/api/flags/history-flag').set(auth());
    expect(detail.body.lastUpdatedBy).toBe(ADMIN_EMAIL);
  });

  // Guards a real hazard: PublicFlag is what gets stored in audit_log's
  // old_value/new_value, so these fields must not leak into those snapshots.
  it('does not appear inside audit snapshots', async () => {
    const res = await request(ctx.app).get('/api/flags/history-flag/audit').set(auth());

    for (const entry of res.body.entries) {
      for (const snapshot of [entry.oldValue, entry.newValue]) {
        if (snapshot) expect(snapshot).not.toHaveProperty('lastUpdatedBy');
      }
    }
  });
});
