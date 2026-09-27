import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  // Signs admin session tokens. 32+ chars so an HS256 key isn't the weak link.
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters'),
  JWT_EXPIRES_IN_SECONDS: z.coerce.number().int().positive().default(3600),
  // Read-only credential used by the SDK; never grants writes.
  SDK_API_KEY: z.string().min(16, 'must be at least 16 characters'),
  // TTL on both cache tiers — the safety net for a missed pub/sub invalidation.
  FLAG_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  // What evaluation returns when no source (Redis or Postgres) can be reached.
  // fail-closed: false, so users keep the behaviour the app had before the flag
  // existed. See README "Caching and degradation".
  FLAG_FALLBACK_POLICY: z.enum(['fail-closed', 'fail-open']).default('fail-closed'),
});

export type Config = z.infer<typeof envSchema>;

/** Parses process.env; throws a readable error listing every missing/invalid variable. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

/** The boolean an unreadable flag evaluates to, per the configured policy. */
export function fallbackValue(policy: Config['FLAG_FALLBACK_POLICY']): boolean {
  return policy === 'fail-open';
}
