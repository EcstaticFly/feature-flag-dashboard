import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signJwt } from '../src/auth/jwt.js';
import { requireAdmin, requireSdkOrAdmin, type AuthConfig } from '../src/middleware/auth.js';
import { errorHandler } from '../src/middleware/errors.js';

const AUTH: AuthConfig = {
  jwtSecret: 'test-secret-that-is-at-least-32-characters-long',
  jwtExpiresInSeconds: 3600,
  sdkApiKey: 'test-sdk-api-key-1234',
    integrationApiKey: 'test-integration-key-1234',
};

const adminToken = signJwt(
  { sub: 'user-1', email: 'admin@example.com', role: 'admin' },
  AUTH.jwtSecret,
  3600,
).token;

/** A miniature app exposing one admin route and one SDK route. */
function buildApp() {
  const app = express();
  app.get('/admin', requireAdmin(AUTH), (req, res) => res.json({ actor: req.actor }));
  app.get('/sdk', requireSdkOrAdmin(AUTH), (req, res) => res.json({ actor: req.actor }));
  app.use(errorHandler);
  return app;
}

describe('requireAdmin', () => {
  it('accepts a valid admin token and exposes the actor', async () => {
    const res = await request(buildApp()).get('/admin').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.actor).toEqual({ type: 'user', id: 'user-1' });
  });

  it('rejects a request with no credentials', async () => {
    const res = await request(buildApp()).get('/admin');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it.each([
    ['garbage token', { Authorization: 'Bearer not-a-token' }],
    ['wrong scheme', { Authorization: adminToken }],
    ['basic auth', { Authorization: 'Basic dXNlcjpwYXNz' }],
  ])('rejects %s', async (_label, headers) => {
    expect((await request(buildApp()).get('/admin').set(headers)).status).toBe(401);
  });

  it('REJECTS the SDK API key — a client app must never be able to write', async () => {
    const res = await request(buildApp()).get('/admin').set('x-api-key', AUTH.sdkApiKey);
    expect(res.status).toBe(401);
  });
});

describe('requireSdkOrAdmin', () => {
  it('accepts the SDK API key', async () => {
    const res = await request(buildApp()).get('/sdk').set('x-api-key', AUTH.sdkApiKey);
    expect(res.status).toBe(200);
    expect(res.body.actor).toEqual({ type: 'sdk', id: 'sdk' });
  });

  it('also accepts an admin token — admins may read what their apps read', async () => {
    const res = await request(buildApp()).get('/sdk').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.actor).toEqual({ type: 'user', id: 'user-1' });
  });

  it.each([
    ['a wrong key', 'nope'],
    ['a prefix of the real key', AUTH.sdkApiKey.slice(0, -1)],
    ['the key plus a suffix', `${AUTH.sdkApiKey}x`],
  ])('rejects %s', async (_label, key) => {
    expect((await request(buildApp()).get('/sdk').set('x-api-key', key)).status).toBe(401);
  });

  it('rejects a request with no credentials', async () => {
    expect((await request(buildApp()).get('/sdk')).status).toBe(401);
  });
});
