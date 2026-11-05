import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { readUserPreferences, updateUserPreferences } from '../dist/config/user-preferences-store.js';
import { configOnboardingRoutes } from '../dist/routes/config-onboarding.js';

test('first-team entry receipts are session-owned, durable and monotonic without changing demo or other preferences', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onboarding-entry-'));
  const open = async () => {
    const app = Fastify();
    app.addHook('onRequest', async (request) => {
      request.sessionUserId = request.headers['test-session'];
    });
    await app.register(configOnboardingRoutes, { projectRoot: root });
    return app;
  };
  let app = await open();
  const get = (user) => app.inject({ url: '/api/config/onboarding/entry', headers: { 'test-session': user } });
  const put = (user, status) =>
    app.inject({
      method: 'PUT',
      url: '/api/config/onboarding/entry',
      headers: { 'test-session': user },
      payload: { status },
    });
  try {
    updateUserPreferences(root, () => ({ catOrder: ['old'], bubbleDefaults: { cliOutput: 'collapsed' } }));
    assert.equal((await get('one')).statusCode, 200);
    assert.equal((await get('one')).json().status, 'not_started');
    assert.equal(
      (await app.inject({ url: '/api/config/onboarding/entry', headers: { 'X-Cat-Cafe-User': 'one' } })).statusCode,
      401,
    );
    assert.equal((await put('one', 'pending')).statusCode, 200);
    assert.equal((await get('one')).json().version, 'first-run-entry-v1');
    assert.equal((await get('one')).json().status, 'pending');
    assert.equal((await get('two')).json().status, 'not_started');
    await app.close();
    app = await open();
    assert.equal((await get('one')).json().status, 'pending');
    assert.equal((await put('one', 'dismissed')).json().status, 'dismissed');
    assert.equal((await put('one', 'pending')).json().status, 'dismissed');
    assert.equal((await put('one', 'completed')).json().status, 'completed');
    assert.equal((await put('one', 'pending')).json().status, 'completed');
    assert.equal((await put('one', 'dismissed')).json().status, 'completed');
    assert.equal(
      (await app.inject({ url: '/api/config/onboarding', headers: { 'test-session': 'one' } })).json().status,
      'not_started',
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/config/onboarding',
          headers: { 'test-session': 'one' },
          payload: { status: 'pending' },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/config/onboarding/entry',
          headers: { 'test-session': 'one' },
          payload: { status: 'pending', userId: 'two' },
        })
      ).statusCode,
      400,
    );
    assert.deepEqual(readUserPreferences(root).catOrder, ['old']);
    assert.deepEqual(readUserPreferences(root).bubbleDefaults, { cliOutput: 'collapsed' });
    assert.equal((await get('two')).json().status, 'not_started');
  } finally {
    await app.close();
    assert.ok(root.startsWith(join(tmpdir(), 'onboarding-entry-')));
    rmSync(root, { recursive: true, force: true });
  }
});
