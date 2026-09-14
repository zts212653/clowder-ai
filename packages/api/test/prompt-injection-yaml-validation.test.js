import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { promptInjectionRoutes } from '../dist/routes/prompt-injection.js';

const TEST_USER_ID = 'test-user';
const AUTH_HEADERS = { 'x-cat-cafe-user': TEST_USER_ID };
const LOCAL_WRITE_HEADERS = {
  host: '127.0.0.1:3004',
  origin: 'http://127.0.0.1:3003',
};
const YAML_SEGMENT = 'S6';

async function buildApp(sessionUserId = null) {
  const app = Fastify({ logger: false });
  if (sessionUserId) {
    app.addHook('onRequest', (request, _reply, done) => {
      request.sessionUserId = sessionUserId;
      done();
    });
  }
  await app.register(promptInjectionRoutes);
  await app.ready();
  return app;
}

async function withDefaultOwnerUserId(value, fn) {
  const previous = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previous;
  }
}

describe('prompt-injection YAML preview and retired overlay mutations', () => {
  describe('POST /api/prompt-injection/segment/:id/preview', () => {
    for (const [label, content] of [
      ['null', 'null'],
      ['scalar', '42'],
      ['array', '- item1\n- item2'],
    ]) {
      it(`rejects ${label} YAML with 400`, async () => {
        const app = await buildApp();
        try {
          const response = await app.inject({
            method: 'POST',
            url: `/api/prompt-injection/segment/${YAML_SEGMENT}/preview`,
            headers: AUTH_HEADERS,
            payload: { content },
          });
          assert.equal(response.statusCode, 400);
          assert.match(response.json().error, /mapping|object/i);
        } finally {
          await app.close();
        }
      });
    }

    it('accepts a valid YAML mapping', async () => {
      const app = await buildApp();
      try {
        const response = await app.inject({
          method: 'POST',
          url: `/api/prompt-injection/segment/${YAML_SEGMENT}/preview`,
          headers: AUTH_HEADERS,
          payload: { content: 'ragdoll: "test value"' },
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().segmentId, YAML_SEGMENT);
      } finally {
        await app.close();
      }
    });
  });

  it('keeps retired overlay writes behind session and owner gates', async () => {
    const unauthenticated = await buildApp();
    try {
      const response = await unauthenticated.inject({
        method: 'PUT',
        url: `/api/prompt-injection/segment/${YAML_SEGMENT}/override`,
        headers: AUTH_HEADERS,
        payload: { content: 'ragdoll: "valid"' },
      });
      assert.equal(response.statusCode, 401);
    } finally {
      await unauthenticated.close();
    }

    await withDefaultOwnerUserId('real-owner', async () => {
      const nonOwner = await buildApp(TEST_USER_ID);
      try {
        const response = await nonOwner.inject({
          method: 'PUT',
          url: `/api/prompt-injection/segment/${YAML_SEGMENT}/override`,
          headers: LOCAL_WRITE_HEADERS,
          payload: { content: 'ragdoll: "valid"' },
        });
        assert.equal(response.statusCode, 403);
      } finally {
        await nonOwner.close();
      }
    });
  });

  it('rejects every legacy local-overlay mutation', async () => {
    await withDefaultOwnerUserId(TEST_USER_ID, async () => {
      const app = await buildApp(TEST_USER_ID);
      try {
        for (const request of [
          { method: 'PUT', url: '/api/prompt-injection/segment/S6/override', payload: { content: 'x: "y"' } },
          { method: 'DELETE', url: '/api/prompt-injection/segment/S6/override' },
          { method: 'POST', url: '/api/prompt-injection/segment/S6/restore-backup' },
        ]) {
          const response = await app.inject({ ...request, headers: LOCAL_WRITE_HEADERS });
          assert.equal(response.statusCode, 409);
          assert.equal(response.json().code, 'versioned_editor_required');
        }
      } finally {
        await app.close();
      }
    });
  });
});
