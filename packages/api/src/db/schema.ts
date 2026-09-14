import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Flag targeting rules. Shape is intentionally loose at the DB layer — the
 * targeting service (Milestone 3) owns validation and evaluation.
 */
export type TargetingRules = Record<string, unknown>;

export const flags = pgTable(
  'flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Slug-format identifier used by the SDK, e.g. `new-checkout-flow`.
    key: text('key').notNull().unique(),
    name: text('name').notNull(),
    description: text('description'),
    enabled: boolean('enabled').notNull().default(false),
    rolloutPercentage: integer('rollout_percentage').notNull().default(0),
    targetingRules: jsonb('targeting_rules').$type<TargetingRules>().notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'flags_rollout_percentage_range',
      sql`${t.rolloutPercentage} >= 0 AND ${t.rolloutPercentage} <= 100`,
    ),
  ],
);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  // Single admin role in v1; kept as text so adding roles later is a data change, not DDL.
  role: text('role').notNull().default('admin'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Actor value used when a change originates from the integration endpoint (FR-12). */
export const SYSTEM_INTEGRATION_ACTOR = 'system:integration';

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    flagId: uuid('flag_id')
      .notNull()
      .references(() => flags.id, { onDelete: 'cascade' }),
    // A user id, or the literal `system:integration`.
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('audit_log_flag_id_created_at_idx').on(t.flagId, t.createdAt)],
);

export type Flag = typeof flags.$inferSelect;
export type NewFlag = typeof flags.$inferInsert;
export type User = typeof users.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;
