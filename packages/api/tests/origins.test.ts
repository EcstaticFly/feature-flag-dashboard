import { describe, expect, it } from 'vitest';
import { isOriginAllowed, parseAllowedOrigins } from '../src/client/origins.js';

const ok = (raw: string) => {
  const result = parseAllowedOrigins(raw);
  if (!result.ok) throw new Error(`expected ok: ${result.error}`);
  return result.origins;
};
const rejected = (raw: string) => {
  const result = parseAllowedOrigins(raw);
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.error;
};

describe('parseAllowedOrigins', () => {
  it('normalises each entry to exactly what a browser sends as Origin', () => {
    expect(ok('https://App.Example.com, http://localhost:5173')).toEqual([
      'https://app.example.com',
      'http://localhost:5173',
    ]);
  });

  it('drops a default port and a trailing slash, as browsers do', () => {
    expect(ok('https://example.com:443/')).toEqual(['https://example.com']);
    expect(ok('http://example.com:80')).toEqual(['http://example.com']);
  });

  it('keeps a non-default port', () => {
    expect(ok('https://example.com:8443')).toEqual(['https://example.com:8443']);
  });

  it('removes duplicates and ignores empty entries from stray commas', () => {
    expect(ok('https://a.com,,https://a.com/, https://b.com ,')).toEqual(['https://a.com', 'https://b.com']);
  });

  it('accepts * only on its own', () => {
    expect(ok('*')).toBe('*');
    expect(ok(' * ')).toBe('*');
    expect(rejected('*,https://a.com')).toMatch(/only entry/);
  });

  it('refuses the literal null origin, in any case', () => {
    expect(rejected('null')).toMatch(/'null' is not allowed/);
    expect(rejected('https://a.com,NULL')).toMatch(/'null' is not allowed/);
  });

  it('refuses wildcard subdomains, which would admit every app on a shared host', () => {
    expect(rejected('https://*.vercel.app')).toMatch(/wildcard subdomains/);
  });

  it.each([
    ['a path', 'https://example.com/app'],
    ['a query', 'https://example.com/?x=1'],
    ['a fragment', 'https://example.com/#top'],
    ['credentials', 'https://user:pass@example.com'],
    ['a non-web scheme', 'ftp://example.com'],
    ['a missing scheme', 'example.com'],
    ['a scheme-less host and port', 'localhost:3000'],
  ])('refuses %s', (_label, raw) => {
    expect(rejected(raw)).not.toBe('');
  });

  it('refuses an empty list', () => {
    expect(rejected(' , ')).toMatch(/at least one origin/);
  });
});

describe('isOriginAllowed', () => {
  it('matches exactly, not by prefix or suffix', () => {
    const allowed = ['https://app.example.com'];
    expect(isOriginAllowed('https://app.example.com', allowed)).toBe(true);
    expect(isOriginAllowed('https://app.example.com.evil.com', allowed)).toBe(false);
    expect(isOriginAllowed('https://evil-app.example.com', allowed)).toBe(false);
    expect(isOriginAllowed('http://app.example.com', allowed)).toBe(false);
  });

  it('allows anything in wildcard mode', () => {
    expect(isOriginAllowed('https://anything.test', '*')).toBe(true);
  });
});
