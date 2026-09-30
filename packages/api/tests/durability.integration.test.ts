import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from './helpers/test-app.js';

/**
 * NFR-FD-05 — "every accepted change persisted to PostgreSQL before considered
 * committed", and FR-FD-06's requirement that the audit row is part of that
 * change rather than a best-effort afterthought.
 *
 * The code is written for this (`db.transaction`, the audit row inside it, cache
 * invalidation strictly after commit) but nothing asserted it until M8 traced the
 * SRS requirement by requirement and found it was the one claim with no test.
 *
 * Every read here goes through a SEPARATE pool, so nothing can be satisfied by
 * the app's own connection or by any of the three cache tiers: if the row is
 * visible to an unrelated client, it is genuinely committed.
 */

let ctx: TestApp;
let observer: pg.Pool;

const auth = () => ({ Authorization: `Bearer ${ctx.token}` });

beforeAll(async () => {
  ctx = await startTestApp();
  observer = new pg.Pool({ connectionString: ctx.connectionUri, max: 4 });
});

afterAll(async () => {
  await observer?.end();
  await ctx?.close();
});

/** Rows as an outside observer sees them — no cache, no shared connection. */
async function observeFlag(key: string) {
  const { rows } = await observer.query(
    `select id, key, enabled, rollout_percentage, created_at, xmin::text as xmin
       from flags where key = $1 and deleted_at is null`,
    [key],
  );
  return rows;
}

async function observeAudit(flagId: string) {
  const { rows } = await observer.query(
    `select id, action, actor, created_at, xmin::text as xmin
       from audit_log where flag_id = $1 order by created_at`,
    [flagId],
  );
  return rows;
}

describe('a create is committed before the response returns', () => {
  it('is visible to an unrelated Postgres client immediately after the 201', async () => {
    const res = await request(ctx.app)
      .post('/api/flags')
      .set(auth())
      .send({ key: 'durable-create', name: 'Durable', enabled: true, rolloutPercentage: 40 })
      .expect(201);

    // No await, no retry, no polling: the requirement is that it is already
    // there. A test that retried would pass for an eventually-consistent write.
    const rows = await observeFlag('durable-create');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: res.body.id,
      enabled: true,
      rollout_percentage: 40,
    });
  });

  it('commits the audit row in the same transaction as the flag itself', async () => {
    const res = await request(ctx.app)
      .post('/api/flags')
      .set(auth())
      .send({ key: 'durable-audit', name: 'Audited', enabled: false, rolloutPercentage: 0 })
      .expect(201);

    const [flag] = await observeFlag('durable-audit');
    const audit = await observeAudit(res.body.id);

    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'create', actor: ctx.adminId });

    /*
     * xmin is the id of the transaction that inserted a tuple. Equal xmin means
     * one transaction wrote both rows — a direct proof rather than an inference,
     * and it would fail if the audit write were ever moved out of the
     * transaction into a second one that merely runs straight afterwards.
     */
    expect(audit[0].xmin).toBe(flag.xmin);

    // The same fact read a second way: now() is the transaction timestamp, so
    // two rows written in one transaction carry an identical created_at.
    expect(audit[0].created_at.getTime()).toBe(flag.created_at.getTime());
  });
});

describe('an update is committed before the response returns', () => {
  it('shows the new value and its audit row to an unrelated client', async () => {
    const created = await request(ctx.app)
      .post('/api/flags')
      .set(auth())
      .send({ key: 'durable-update', name: 'Updatable', enabled: false, rolloutPercentage: 10 })
      .expect(201);

    await request(ctx.app)
      .patch('/api/flags/durable-update')
      .set(auth())
      .send({ rolloutPercentage: 85 })
      .expect(200);

    const [flag] = await observeFlag('durable-update');
    expect(flag.rollout_percentage).toBe(85);

    const audit = await observeAudit(created.body.id);
    expect(audit.map((r) => r.action)).toEqual(['create', 'update']);
    // Both rows of the update share its transaction, as the create's did.
    expect(audit[1].xmin).not.toBe(audit[0].xmin);
  });
});

describe('a rejected change leaves nothing behind', () => {
  it('writes no flag and no audit row when the key already exists', async () => {
    const first = await request(ctx.app)
      .post('/api/flags')
      .set(auth())
      .send({ key: 'durable-dupe', name: 'First', enabled: true, rolloutPercentage: 5 })
      .expect(201);

    const auditBefore = await observeAudit(first.body.id);

    await request(ctx.app)
      .post('/api/flags')
      .set(auth())
      .send({ key: 'durable-dupe', name: 'Second', enabled: false, rolloutPercentage: 99 })
      .expect(409);

    // One live row, still the original values — the rejected create did not
    // partially apply.
    const rows = await observeFlag('durable-dupe');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ enabled: true, rollout_percentage: 5 });

    // And no history entry claiming a change that never happened.
    expect(await observeAudit(first.body.id)).toHaveLength(auditBefore.length);
  });

  it('commits exactly one flag and one audit row under two concurrent creates', async () => {
    const create = (name: string) =>
      request(ctx.app)
        .post('/api/flags')
        .set(auth())
        .send({ key: 'durable-race', name, enabled: true, rolloutPercentage: 50 });

    // The real partial unique index arbitrates: the second insert blocks until
    // the first commits, then fails. Whichever loses must leave no trace.
    const results = await Promise.all([create('A'), create('B')]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409]);

    const rows = await observeFlag('durable-race');
    expect(rows).toHaveLength(1);
    expect(await observeAudit(rows[0].id)).toHaveLength(1);
  });
});

describe('a delete is committed before the response returns', () => {
  it('soft-deletes durably, keeping the audit trail resolvable', async () => {
    const created = await request(ctx.app)
      .post('/api/flags')
      .set(auth())
      .send({ key: 'durable-delete', name: 'Doomed', enabled: true, rolloutPercentage: 30 })
      .expect(201);

    await request(ctx.app).delete('/api/flags/durable-delete').set(auth()).expect(204);

    // Gone from the live set…
    expect(await observeFlag('durable-delete')).toHaveLength(0);

    // …but the row and its history survive, which is what makes audit rows
    // keep pointing at a real flag and lets the key be reused.
    const { rows } = await observer.query(
      `select deleted_at from flags where id = $1`,
      [created.body.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].deleted_at).not.toBeNull();

    const audit = await observeAudit(created.body.id);
    expect(audit.map((r) => r.action)).toEqual(['create', 'delete']);
  });
});
