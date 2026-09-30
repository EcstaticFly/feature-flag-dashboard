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
  // Held by a second service (the error tracker) so it can disable a flag in
  // response to an alert — and do nothing else.
  INTEGRATION_API_KEY: z.string().min(16, 'must be at least 16 characters'),
  // TTL on both cache tiers — the safety net for a missed pub/sub invalidation.
  FLAG_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(30),
  // What evaluation returns when no source (Redis or Postgres) can be reached.
  // fail-closed: false, so users keep the behaviour the app had before the flag
  // existed. See README "Caching and degradation".
  FLAG_FALLBACK_POLICY: z.enum(['fail-closed', 'fail-open']).default('fail-closed'),
  /**
   * Fraction of evaluations that emit the structured log line, 0–1.
   *
   * Defaults to 1 — every evaluation, exactly as before. At NFR-03 throughput
   * that is 500 JSON serialisations and stdout writes per second, so this dial
   * exists to turn it down without a code change. See the Performance section
   * of the README for what it actually costs.
   */
  FLAG_EVAL_LOG_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1),
  /**
   * Connect timeouts, in milliseconds.
   *
   * The defaults are tuned for local Docker, where a connection is instant and
   * failing fast is what makes /health honest. Managed free tiers are the
   * opposite: Neon scales to zero after a few minutes idle and takes seconds to
   * wake, and Upstash adds a cross-region TLS handshake. At 1500 ms a perfectly
   * normal cold start reads as an outage — and five of those in a row open the
   * circuit breaker, so the API fails closed on healthy infrastructure.
   *
   * Hence configurable rather than raised: local behaviour stays identical, and
   * a deployment sets what its infrastructure actually needs. See the README's
   * Deployment section for the recommended production values.
   */
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(1500),
  REDIS_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(1500),
  /** Per-check ceiling for /health. Raise it wherever a cold start is expected. */
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
  /**
   * Permits the development credentials below. `docker-compose.yml` sets it,
   * because that stack is deliberately zero-configuration; nothing else should.
   */
  ALLOW_DEV_CREDENTIALS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof envSchema>;

/**
 * The placeholder credentials committed to this repository.
 *
 * They are not secrets and were never meant to be: they sit in `.env.example`,
 * `docker-compose.yml`, the README and the k6 scripts so that a clean clone runs
 * with no configuration. That convenience is only safe while they cannot reach a
 * real deployment by accident — anyone who can read this repo could sign an
 * admin token with the JWT secret below, so a deployment using it has no
 * authentication at all. Hence the guard in `loadConfig`.
 */
const DEV_CREDENTIALS = {
  JWT_SECRET: 'dev-only-jwt-secret-change-me-at-least-32-chars',
  SDK_API_KEY: 'dev-only-sdk-api-key-change-me',
  INTEGRATION_API_KEY: 'dev-only-integration-key-change-me',
} as const;

/** Every credential still set to this repository's public placeholder value. */
export function devCredentialsInUse(config: Config): string[] {
  return (Object.keys(DEV_CREDENTIALS) as (keyof typeof DEV_CREDENTIALS)[]).filter(
    (key) => config[key] === DEV_CREDENTIALS[key],
  );
}

/** Parses process.env; throws a readable error listing every missing/invalid variable. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  // Deliberately outside the zod schema: the check spans several fields, and its
  // message has to name the offending ones and say what to do about them.
  const placeholders = devCredentialsInUse(parsed.data);
  if (placeholders.length > 0 && !parsed.data.ALLOW_DEV_CREDENTIALS) {
    const verb = placeholders.length === 1 ? 'is' : 'are';
    throw new Error(
      [
        `Refusing to start: ${placeholders.join(', ')} ${verb} still set to this ` +
          "repository's development placeholder, which is public.",
        'Generate real values with:',
        `  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`,
        'Set ALLOW_DEV_CREDENTIALS=true only for a throwaway local stack.',
      ].join('\n'),
    );
  }

  return parsed.data;
}

/** The boolean an unreadable flag evaluates to, per the configured policy. */
export function fallbackValue(policy: Config['FLAG_FALLBACK_POLICY']): boolean {
  return policy === 'fail-open';
}
