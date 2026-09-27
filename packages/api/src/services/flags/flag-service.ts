import type { FlagConfig } from '@feature-flags/core';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { auditLog, flags, type AuditAction, type Flag } from '../../db/schema.js';
import { AppError, isPgError, PG_UNIQUE_VIOLATION } from '../../middleware/errors.js';
import type { CreateFlagInput, UpdateFlagInput } from '../../validation/flags.js';

/**
 * The flag service is the ONLY place that reads or writes flag rows. Routes call
 * it; so does the integration endpoint (Milestone 6), which is why `actor` is a
 * parameter rather than something read from a request.
 *
 * Every mutation writes its audit row inside the same transaction as the change
 * itself: NFR-05 means a change isn't committed unless its audit entry is.
 *
 * Use `createFlagService(db, cache)` rather than the raw functions below: it
 * invalidates the cache after every successful mutation, in one place, so no
 * caller can forget to.
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

/** One flag's config, or undefined when no live flag has that key. */
export async function getFlagConfig(db: Db, key: string): Promise<FlagConfig | undefined> {
  const [row] = await db.select().from(flags).where(liveFlag(key)).limit(1);
  return row ? toFlagConfig(row) : undefined;
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

/** The slice of the flag cache the service needs — keeps this module Redis-free. */
export interface FlagInvalidator {
  invalidate(key: string): Promise<void>;
}

export interface FlagService {
  listFlags(): Promise<PublicFlag[]>;
  listSdkFlags(): Promise<FlagConfig[]>;
  getFlagByKey(key: string): Promise<PublicFlag>;
  createFlag(actor: string, input: CreateFlagInput): Promise<PublicFlag>;
  updateFlag(actor: string, key: string, patch: UpdateFlagInput): Promise<PublicFlag>;
  softDeleteFlag(actor: string, key: string): Promise<void>;
}

/**
 * Binds the service to a database and (optionally) a cache.
 *
 * Invalidation happens AFTER the transaction commits: doing it inside would be
 * wrong if the transaction then rolled back, and doing it before commit could
 * repopulate the cache with data that never landed. A failed invalidation is
 * logged but does not fail the request — the cache TTL heals it within seconds.
 */
export function createFlagService(db: Db, cache?: FlagInvalidator): FlagService {
  const invalidate = async (key: string): Promise<void> => {
    if (!cache) return;
    try {
      await cache.invalidate(key);
    } catch (err) {
      console.error(`[flags] cache invalidation failed for '${key}':`, (err as Error).message);
    }
  };

  return {
    listFlags: () => listFlags(db),
    listSdkFlags: () => listSdkFlags(db),
    getFlagByKey: (key) => getFlagByKey(db, key),

    async createFlag(actor, input) {
      const flag = await createFlag(db, actor, input);
      await invalidate(flag.key);
      return flag;
    },

    async updateFlag(actor, key, patch) {
      const flag = await updateFlag(db, actor, key, patch);
      await invalidate(key);
      return flag;
    },

    async softDeleteFlag(actor, key) {
      await softDeleteFlag(db, actor, key);
      await invalidate(key);
    },
  };
}
