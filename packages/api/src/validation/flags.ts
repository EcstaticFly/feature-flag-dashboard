import { SUPPORTED_OPERATORS } from '@feature-flags/core';
import { z } from 'zod';

/** Slug format — lowercase letters/digits in hyphen-separated groups. */
export const FLAG_KEY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const flagKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(FLAG_KEY_PATTERN, 'must be lowercase letters, numbers and single hyphens');

export const targetingRuleSchema = z
  .strictObject({
    attribute: z.string().min(1).max(64),
    // Mirrors @feature-flags/core so the two definitions cannot drift.
    operator: z.enum(SUPPORTED_OPERATORS),
    values: z.array(z.string().min(1).max(256)).min(1).max(100),
  })
  .superRefine((rule, ctx) => {
    // The evaluator compares `eq` against values[0]. Accepting extra values
    // would let a rule look correct while silently ignoring most of it;
    // `in` is the operator for matching a list.
    if (rule.operator === 'eq' && rule.values.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['values'],
        message: "operator 'eq' takes exactly one value; use 'in' to match a list",
      });
    }
  });

export const targetingRulesSchema = z.array(targetingRuleSchema).max(20);

export const rolloutPercentageSchema = z.number().int().min(0).max(100);

export const createFlagSchema = z.strictObject({
  key: flagKeySchema,
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullish(),
  enabled: z.boolean().default(false),
  rolloutPercentage: rolloutPercentageSchema.default(0),
  targetingRules: targetingRulesSchema.default([]),
});

/**
 * `key` is intentionally absent: it is the SDK's contract for a flag, so it is
 * immutable. `.strict()` turns an attempt to change it into a 400.
 */
export const updateFlagSchema = z
  .strictObject({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullable(),
    enabled: z.boolean(),
    rolloutPercentage: rolloutPercentageSchema,
    targetingRules: targetingRulesSchema,
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'at least one field must be provided',
  });

export type CreateFlagInput = z.infer<typeof createFlagSchema>;
export type UpdateFlagInput = z.infer<typeof updateFlagSchema>;

/** Query for GET /api/flags/:key/audit. Capping is done in the service. */
export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional(),
});

export const loginSchema = z.strictObject({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(512),
});
