/**
 * Shared flag types and pure helpers.
 *
 * This package has ZERO runtime dependencies and is bundled into the published
 * SDK, so nothing may be added here that can't ship inside a consumer's app.
 * Milestone 2 adds `computeBucket` and `evaluateFlag` alongside these types.
 */

/** Comparison operators a targeting rule may use. */
export const SUPPORTED_OPERATORS = ['in', 'eq'] as const;

export type TargetingOperator = (typeof SUPPORTED_OPERATORS)[number];

/**
 * One targeting rule. An allowlist is just
 * `{ attribute: 'userId', operator: 'in', values: [...] }` — targeting by
 * `email`, `plan` or any other attribute works identically.
 */
export interface TargetingRule {
  attribute: string;
  operator: TargetingOperator;
  values: string[];
}

/**
 * The user a flag is evaluated for. `userId` is always what the percentage
 * bucket hashes — it must be a stable identifier (a database id), never an
 * email, which can change and would move the user between buckets.
 */
export interface UserContext {
  userId: string;
  attributes?: Record<string, string | number | boolean>;
}

/** The flag shape `GET /api/sdk/flags` returns and the SDK caches. */
export interface FlagConfig {
  key: string;
  enabled: boolean;
  rolloutPercentage: number;
  targetingRules: TargetingRule[];
}

/**
 * The single definition of how rule values and user attributes are compared.
 * Both sides of every comparison go through this, so `"  Pro "` matches `"pro"`.
 */
export function normalizeValue(value: string | number | boolean): string {
  return String(value).trim().toLowerCase();
}

/** Narrowing helper so unknown operators can be skipped rather than thrown on. */
export function isSupportedOperator(value: unknown): value is TargetingOperator {
  return typeof value === 'string' && (SUPPORTED_OPERATORS as readonly string[]).includes(value);
}
