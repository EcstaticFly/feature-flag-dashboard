import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

async function countAppliedMigrations(): Promise<number> {
  const res = await pool.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
  );
  return Number(res.rows[0]?.count);
}

describe('database migrations', () => {
  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:16-alpine').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  it('applies cleanly against a fresh database and creates the expected tables', async () => {
    await runMigrations(container.getConnectionUri());

    const res = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    expect(res.rows.map((r) => r.table_name)).toEqual(['audit_log', 'flags', 'users']);
  });

  it('is tracked and re-runnable: a second run applies nothing new', async () => {
    const before = await countAppliedMigrations();
    expect(before).toBeGreaterThan(0);

    await runMigrations(container.getConnectionUri());

    expect(await countAppliedMigrations()).toBe(before);
  });

  it('enforces the 0-100 range on rollout_percentage', async () => {
    await expect(
      pool.query(
        `INSERT INTO flags (key, name, rollout_percentage) VALUES ('bad-flag', 'Bad', 101)`,
      ),
    ).rejects.toThrow(/flags_rollout_percentage_range/);
  });

  it('enforces unique flag keys', async () => {
    await pool.query(`INSERT INTO flags (key, name) VALUES ('dupe', 'First')`);
    await expect(
      pool.query(`INSERT INTO flags (key, name) VALUES ('dupe', 'Second')`),
    ).rejects.toThrow(/unique/i);
  });

  it('cascades audit_log rows when a flag is deleted', async () => {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO flags (key, name) VALUES ('cascade-me', 'Cascade') RETURNING id`,
    );
    const flagId = inserted.rows[0]!.id;
    await pool.query(
      `INSERT INTO audit_log (flag_id, actor, action, new_value) VALUES ($1, 'system:integration', 'create', '{}')`,
      [flagId],
    );

    await pool.query(`DELETE FROM flags WHERE id = $1`, [flagId]);

    const remaining = await pool.query(`SELECT 1 FROM audit_log WHERE flag_id = $1`, [flagId]);
    expect(remaining.rowCount).toBe(0);
  });
});
