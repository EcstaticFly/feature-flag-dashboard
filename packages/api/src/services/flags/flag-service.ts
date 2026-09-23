import type { FlagConfig } from '@feature-flags/core';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { auditLog, flags, type AuditAction, type Flag } from '../../db/schema.js';
import { AppError, isPgError, PG_UNIQUE_VIOLATION } from '../../middleware/errors.js';
import type { CreateFlagInput, UpdateFlagInput } from '../../validation/flags.js';

/**
 * The flag service is the ONLY place that reads or writes flag rows. Routes call
 * these functions; so does the integration endpoint (Milestone 6), which is why
 * `actor` is a parameter rather than something read from a request.
 *
 * Every mutation writes its audit row inside the same transaction as the change
 * itself: NFR-05 means a change isn't committed unless its audit entry is.
 */

/** Public representation of a flag — what routes return and audit rows record. */
export interface PublicFlag {
  id: string;
  key: string;
  name: string;
  description: string | null;
  enabled: boolean;
  rolloutPercentage: number;
  targetingRules: FlagConfig['targetingRules'];
  createdAt: string;
  updatedAt: string;
}

export function toPublicFlag(row: Flag): PublicFlag {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    rolloutPercentage: row.rolloutPercentage,
    targetingRules: row.targetingRules,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toFlagConfig(row: Flag): FlagConfig {
  return {
    key: row.key,
    enabled: row.enabled,
    rolloutPercentage: row.rolloutPercentage,
    targetingRules: row.targetingRules,
  };
}

const liveFlag = (key: string) => and(eq(flags.key, key), isNull(flags.deletedAt));

/** Fields a mutation may change — the ones compared to decide if anything actually changed. */
const MUTABLE_FIELDS = [
  'name',
  'description',
  'enabled',
  'rolloutPercentage',
  'targetingRules',
] as const;

export async function listFlags(db: Db): Promise<PublicFlag[]> {
  const rows = await db.select().from(flags).where(isNull(flags.deletedAt)).orderBy(asc(flags.key));
  return rows.map(toPublicFlag);
}

/** Flag configs for the SDK. Milestone 3 puts the Redis cache in front of this. */
export async function listSdkFlags(db: Db): Promise<FlagConfig[]> {
  const rows = await db.select().from(flags).where(isNull(flags.deletedAt)).orderBy(asc(flags.key));
  return rows.map(toFlagConfig);
}

export async function getFlagByKey(db: Db, key: string): Promise<PublicFlag> {
  const [row] = await db.select().from(flags).where(liveFlag(key)).limit(1);
  if (!row) throw AppError.notFound('flag_not_found', `no flag with key '${key}'`);
  return toPublicFlag(row);
}

export async function createFlag(
  db: Db,
  actor: string,
  input: CreateFlagInput,
): Promise<PublicFlag> {
  try {
    return await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(flags)
        .values({
          key: input.key,
          name: input.name,
          description: input.description ?? null,
          enabled: input.enabled,
          rolloutPercentage: input.rolloutPercentage,
          targetingRules: input.targetingRules,
        })
        .returning();

      const created = toPublicFlag(row!);
      await writeAudit(tx, created.id, actor, 'create', null, created);
      return created;
    });
  } catch (err) {
    // Insert-and-catch rather than check-then-insert: two concurrent creates of
    // the same key can't both believe they won.
    if (isPgError(err, PG_UNIQUE_VIOLATION)) {
      throw AppError.conflict('flag_key_exists', `a flag with key '${input.key}' already exists`);
    }
    throw err;
  }
}

export async function updateFlag(
  db: Db,
  actor: string,
  key: string,
  patch: UpdateFlagInput,
): Promise<PublicFlag> {
  return db.transaction(async (tx) => {
    // FOR UPDATE: two concurrent patches of the same flag serialise here, so the
    // audit log's old/new values always reflect a real transition.
    const [existing] = await tx.select().from(flags).where(liveFlag(key)).limit(1).for('update');
    if (!existing) throw AppError.notFound('flag_not_found', `no flag with key '${key}'`);

    const before = toPublicFlag(existing);
    const changed = MUTABLE_FIELDS.filter(
      (field) =>
        patch[field] !== undefined &&
        JSON.stringify(patch[field]) !== JSON.stringify(before[field]),
    );

    // Nothing actually changes → no write, no audit noise. This is what makes
    // Milestone 6's "already-disabled flag is an idempotent no-op" free.
    if (changed.length === 0) return before;

    const [row] = await tx
      .update(flags)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(flags.id, existing.id))
      .returning();

    const after = toPublicFlag(row!);
    await writeAudit(tx, after.id, actor, 'update', before, after);
    return after;
  });
}

export async function softDeleteFlag(db: Db, actor: string, key: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [existing] = await tx.select().from(flags).where(liveFlag(key)).limit(1).for('update');
    if (!existing) throw AppError.notFound('flag_not_found', `no flag with key '${key}'`);

    const before = toPublicFlag(existing);
    await tx
      .update(flags)
      .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(flags.id, existing.id));

    // The row survives, so this audit entry (and every earlier one) keeps its
    // flag_id reference valid.
    await writeAudit(tx, before.id, actor, 'delete', before, null);
  });
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function writeAudit(
  tx: Tx,
  flagId: string,
  actor: string,
  action: AuditAction,
  oldValue: PublicFlag | null,
  newValue: PublicFlag | null,
): Promise<void> {
  await tx.insert(auditLog).values({ flagId, actor, action, oldValue, newValue });
}
