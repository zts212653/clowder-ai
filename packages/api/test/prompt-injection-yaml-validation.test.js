import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { promptInjectionRoutes } from '../dist/routes/prompt-injection.js';

const AUTH_HEADERS = { 'x-cat-cafe-user': 'test-user' };

/**
 * Focused test: YAML overlay endpoints must reject non-object YAML values.
 * Regression for codex-connector P2: `YAML.parse("null")` returns null,
 * `Object.entries(null)` throws, crashing prompt construction downstream.
 *
 * Write endpoints (PUT) require session-only auth (cookie-backed sessionUserId),
 * not header-based identity. Tests simulate this via onRequest hook.
 */
describe('prompt-injection YAML validation', () => {
  /** Build app WITHOUT session — for read/preview endpoints that accept header auth */
  async function buildApp() {
    const app = Fastify({ logger: false });
    await app.register(promptInjectionRoutes);
    await app.ready();
    return app;
  }

  /** Build app WITH simulated session — for write endpoints that require session cookie */
  async function buildSessionApp() {
    const app = Fastify({ logger: false });
    app.addHook('onRequest', (req, _reply, done) => {
      req.sessionUserId = 'test-user';
      done();
    });
    await app.register(promptInjectionRoutes);
    await app.ready();
    return app;
  }

  // S6 is the YAML segment (workflow-triggers)
  const YAML_SEGMENT = 'S6';

  describe('POST /api/prompt-injection/segment/:id/preview', () => {
    it('rejects null YAML with 400', async () => {
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/prompt-injection/segment/${YAML_SEGMENT}/preview`,
          headers: AUTH_HEADERS,
          payload: { content: 'null' },
        });
        assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}`);
        const body = JSON.parse(res.body);
        assert.ok(body.error, 'response should have error field');
        assert.match(body.error, /mapping|object/i, 'error should mention mapping/object');
      } finally {
        await app.close();
      }
    });

    it('rejects scalar YAML with 400', async () => {
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/prompt-injection/segment/${YAML_SEGMENT}/preview`,
          headers: AUTH_HEADERS,
          payload: { content: '42' },
        });
        assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}`);
        const body = JSON.parse(res.body);
        assert.match(body.error, /mapping|object/i);
      } finally {
        await app.close();
      }
    });

    it('rejects array YAML with 400', async () => {
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/prompt-injection/segment/${YAML_SEGMENT}/preview`,
          headers: AUTH_HEADERS,
          payload: { content: '- item1\n- item2' },
        });
        assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}`);
        const body = JSON.parse(res.body);
        assert.match(body.error, /mapping|object/i);
      } finally {
        await app.close();
      }
    });

    it('accepts valid YAML mapping', async () => {
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: 'POST',
          url: `/api/prompt-injection/segment/${YAML_SEGMENT}/preview`,
          headers: AUTH_HEADERS,
          payload: { content: 'ragdoll: "test value"' },
        });
        assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}`);
        const body = JSON.parse(res.body);
        assert.equal(body.segmentId, YAML_SEGMENT);
        assert.ok(body.rendered, 'should have rendered field');
      } finally {
        await app.close();
      }
    });
  });

  describe('PUT /api/prompt-injection/segment/:id/override', () => {
    it('rejects header-only auth with 401 (requires session cookie)', async () => {
      const app = await buildApp();
      try {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/prompt-injection/segment/${YAML_SEGMENT}/override`,
          headers: AUTH_HEADERS,
          payload: { content: 'ragdoll: "valid"' },
        });
        assert.equal(res.statusCode, 401, `expected 401, got ${res.statusCode}`);
      } finally {
        await app.close();
      }
    });

    it('rejects non-owner session with 403 when DEFAULT_OWNER_USER_ID is set', async () => {
      const prev = process.env.DEFAULT_OWNER_USER_ID;
      process.env.DEFAULT_OWNER_USER_ID = 'real-owner';
      try {
        // buildSessionApp sets sessionUserId = 'test-user' (not the owner)
        const app = await buildSessionApp();
        try {
          const res = await app.inject({
            method: 'PUT',
            url: `/api/prompt-injection/segment/${YAML_SEGMENT}/override`,
            payload: { content: 'ragdoll: "valid"' },
          });
          assert.equal(res.statusCode, 403, `expected 403, got ${res.statusCode}`);
          const body = JSON.parse(res.body);
          assert.ok(body.error, 'response should have error field');
        } finally {
          await app.close();
        }
      } finally {
        if (prev === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
        else process.env.DEFAULT_OWNER_USER_ID = prev;
      }
    });

    it('rejects null YAML with 400 (session auth)', async () => {
      const app = await buildSessionApp();
      try {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/prompt-injection/segment/${YAML_SEGMENT}/override`,
          payload: { content: 'null' },
        });
        assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}`);
        const body = JSON.parse(res.body);
        assert.ok(body.error, 'response should have error field');
        assert.match(body.error, /mapping|object/i, 'error should mention mapping/object');
      } finally {
        await app.close();
      }
    });

    it('rejects scalar YAML with 400 (session auth)', async () => {
      const app = await buildSessionApp();
      try {
        const res = await app.inject({
          method: 'PUT',
          url: `/api/prompt-injection/segment/${YAML_SEGMENT}/override`,
          payload: { content: 'just a string' },
        });
        assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}`);
        const body = JSON.parse(res.body);
        assert.match(body.error, /mapping|object/i);
      } finally {
        await app.close();
      }
    });
  });
});
