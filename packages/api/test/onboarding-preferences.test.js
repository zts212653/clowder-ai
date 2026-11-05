import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { readUserPreferences, updateUserPreferences } from '../dist/config/user-preferences-store.js';
import { configOnboardingRoutes } from '../dist/routes/config-onboarding.js';

test('persists guide receipts by authenticated operator and version across app reopen', async () => {
  const root = mkdtempSync(join(tmpdir(), 'onboarding-preferences-'));
  const open = async () => {
    const app = Fastify();
    app.addHook('onRequest', async (request) => {
      request.sessionUserId = request.headers['test-session'];
    });
    await app.register(configOnboardingRoutes, { projectRoot: root });
    return app;
  };
  let app = await open();
  const get = (user) => app.inject({ url: '/api/config/onboarding', headers: { 'test-session': user } });
  try {
    updateUserPreferences(root, () => ({ catOrder: ['old-id'], bubbleDefaults: { cliOutput: 'collapsed' } }));
    assert.equal((await app.inject({ url: '/api/config/onboarding' })).statusCode, 401);
    assert.equal(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/config/onboarding',
          payload: { status: 'completed', userId: 'other' },
        })
      ).statusCode,
      401,
    );
    assert.equal((await get('one')).json().status, 'not_started');
    const save = await app.inject({
      method: 'PUT',
      url: '/api/config/onboarding',
      headers: { 'test-session': 'one' },
      payload: { status: 'completed' },
    });
    assert.equal(save.statusCode, 200);
    await app.close();
    app = await open();
    assert.equal((await get('one')).json().status, 'completed');
    assert.equal((await get('two')).json().status, 'not_started');
    assert.deepEqual(readUserPreferences(root).catOrder, ['old-id']);
    assert.deepEqual(readUserPreferences(root).bubbleDefaults, { cliOutput: 'collapsed' });
    await app.inject({
      method: 'PUT',
      url: '/api/config/onboarding',
      headers: { 'test-session': 'one' },
      payload: { status: 'dismissed' },
    });
    assert.equal((await get('one')).json().status, 'completed', 'later close cannot downgrade delivery completion');
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
