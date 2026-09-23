import { SUPPORTED_OPERATORS } from '@feature-flags/core';
import { z } from 'zod';

/** Slug format — lowercase letters/digits in hyphen-separated groups. */
export const FLAG_KEY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const flagKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(FLAG_KEY_PATTERN, 'must be lowercase letters, numbers and single hyphens');

export const targetingRuleSchema = z.strictObject({
  attribute: z.string().min(1).max(64),
  // Mirrors @feature-flags/core so the two definitions cannot drift.
  operator: z.enum(SUPPORTED_OPERATORS),
  values: z.array(z.string().min(1).max(256)).min(1).max(100),
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

export const loginSchema = z.strictObject({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(512),
});
