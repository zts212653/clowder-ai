/**
 * Skills write-route owner gate tests (AC-E4)
 * POST /api/skills/sync and POST /api/skills/resolve-conflict
 * must require DEFAULT_OWNER_USER_ID match (fail-closed).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { skillsRoutes } from '../dist/routes/skills.js';

const OWNER_ID = 'owner-user';
const NON_OWNER_ID = 'random-visitor';

async function buildSkillsApp() {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    const sessionUser = request.headers['x-test-session-user'];
    if (typeof sessionUser === 'string' && sessionUser.trim()) {
      request.sessionUserId = sessionUser.trim();
    }
  });
  await app.register(skillsRoutes);
  await app.ready();
  return app;
}

describe('Skills write-route owner gate (AC-E4)', () => {
  it('POST /api/skills/sync returns 403 when user is not owner', async () => {
    const prev = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;

    const app = await buildSkillsApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/sync',
        headers: { 'x-test-session-user': NON_OWNER_ID },
        payload: {},
      });

      assert.equal(res.statusCode, 403, 'non-owner should get 403');
      const body = JSON.parse(res.body);
      assert.ok(body.error, 'should return error message');
    } finally {
      if (prev === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prev;
      await app.close();
    }
  });

  it('POST /api/skills/resolve-conflict returns 403 when user is not owner', async () => {
    const prev = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;

    const app = await buildSkillsApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/resolve-conflict',
        headers: { 'x-test-session-user': NON_OWNER_ID },
        payload: { skillName: 'debugging', choice: 'official' },
      });

      assert.equal(res.statusCode, 403, 'non-owner should get 403');
      const body = JSON.parse(res.body);
      assert.ok(body.error, 'should return error message');
    } finally {
      if (prev === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prev;
      await app.close();
    }
  });

  it('POST /api/skills/sync returns 403 when DEFAULT_OWNER_USER_ID is unset', async () => {
    const prev = process.env.DEFAULT_OWNER_USER_ID;
    delete process.env.DEFAULT_OWNER_USER_ID;

    const app = await buildSkillsApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/sync',
        headers: { 'x-test-session-user': 'any-user' },
        payload: {},
      });

      assert.equal(res.statusCode, 403, 'unset owner ID should fail closed');
    } finally {
      if (prev === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prev;
      await app.close();
    }
  });

  it('POST /api/skills/sync rejects header-only (forgeable) identity', async () => {
    const prev = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;

    const app = await buildSkillsApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/sync',
        headers: { 'x-cat-cafe-user': OWNER_ID },
        payload: {},
      });
      assert.equal(res.statusCode, 401, 'header-only identity should be rejected');
    } finally {
      if (prev === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prev;
      await app.close();
    }
  });

  it('POST /api/skills/resolve-conflict rejects non-managed skill', async () => {
    const prev = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;

    const app = await buildSkillsApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/resolve-conflict',
        headers: { 'x-test-session-user': OWNER_ID },
        payload: { skillName: 'nonexistent-definitely-fake', choice: 'official' },
      });
      assert.equal(res.statusCode, 400, 'non-managed skill should be rejected');
      const body = JSON.parse(res.body);
      assert.ok(body.error?.includes('not managed'), 'error should mention not managed');
    } finally {
      if (prev === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prev;
      await app.close();
    }
  });

  it('POST /api/skills/sync succeeds when user matches owner via session', async () => {
    const prev = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;

    const app = await buildSkillsApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/sync',
        headers: { 'x-test-session-user': OWNER_ID },
        payload: {},
      });

      assert.notEqual(res.statusCode, 403, 'owner should not get 403');
      assert.notEqual(res.statusCode, 401, 'owner should not get 401');
    } finally {
      if (prev === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prev;
      await app.close();
    }
  });
});
