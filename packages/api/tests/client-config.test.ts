import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const BASE_ENV = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/d',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a-secret-that-is-at-least-32-characters-long',
  SDK_API_KEY: 'sdk-key-at-least-16-chars',
  INTEGRATION_API_KEY: 'integration-key-at-least-16',
};

const load = (extra: Record<string, string>) => loadConfig({ ...BASE_ENV, ...extra } as NodeJS.ProcessEnv);

describe('browser API configuration', () => {
  it('is off unless a client key is set, so existing deployments are unchanged', () => {
    const config = load({});
    expect(config.CLIENT_API_KEY).toBeUndefined();
    expect(config.CLIENT_ALLOWED_ORIGINS).toBeUndefined();
  });

  it('treats an empty CLIENT_API_KEY= line as unset rather than refusing to boot', () => {
    expect(load({ CLIENT_API_KEY: '', CLIENT_ALLOWED_ORIGINS: '' }).CLIENT_API_KEY).toBeUndefined();
  });

  it('parses the key, the origins and the signing policy', () => {
    const config = load({
      CLIENT_API_KEY: 'public-client-key-1234',
      CLIENT_ALLOWED_ORIGINS: 'https://app.example.com, http://localhost:5173',
    });
    expect(config.CLIENT_API_KEY).toBe('public-client-key-1234');
    expect(config.CLIENT_ALLOWED_ORIGINS).toEqual(['https://app.example.com', 'http://localhost:5173']);
  });

  it('requires signed contexts by default', () => {
    expect(load({}).CLIENT_REQUIRE_SIGNED_CONTEXT).toBe(true);
    expect(load({ CLIENT_REQUIRE_SIGNED_CONTEXT: 'false' }).CLIENT_REQUIRE_SIGNED_CONTEXT).toBe(false);
  });

  it.each(['FALSE', '0', 'no', 'off'])(
    'does not relax signing for %o — only the exact string "false" does',
    (value) => {
      expect(() => load({ CLIENT_REQUIRE_SIGNED_CONTEXT: value })).toThrow(/CLIENT_REQUIRE_SIGNED_CONTEXT/);
    },
  );

  it('refuses to start with a client key but no origins', () => {
    expect(() => load({ CLIENT_API_KEY: 'public-client-key-1234' })).toThrow(
      /CLIENT_ALLOWED_ORIGINS: required when CLIENT_API_KEY is set/,
    );
  });

  it('refuses an origin list it cannot trust, naming the variable', () => {
    expect(() =>
      load({ CLIENT_API_KEY: 'public-client-key-1234', CLIENT_ALLOWED_ORIGINS: 'https://*.vercel.app' }),
    ).toThrow(/CLIENT_ALLOWED_ORIGINS: .*wildcard subdomains/);
  });

  it('refuses a short client key', () => {
    expect(() => load({ CLIENT_API_KEY: 'short', CLIENT_ALLOWED_ORIGINS: '*' })).toThrow(
      /CLIENT_API_KEY: must be at least 16 characters/,
    );
  });

  // The client key is published in every page that uses it, so it must never
  // equal a secret — that would publish the secret.
  it.each(['SDK_API_KEY', 'INTEGRATION_API_KEY', 'JWT_SECRET'] as const)(
    'refuses a client key equal to %s',
    (secret) => {
      expect(() => load({ CLIENT_API_KEY: BASE_ENV[secret], CLIENT_ALLOWED_ORIGINS: '*' })).toThrow(
        new RegExp(`CLIENT_API_KEY equals ${secret}`),
      );
    },
  );
});
