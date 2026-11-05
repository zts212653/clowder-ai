import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import Fastify from 'fastify';
import { updateUserPreferences } from '../dist/config/user-preferences-store.js';
import { configOnboardingRoutes } from '../dist/routes/config-onboarding.js';

for (const fault of ['parse', 'EIO', 'array', 'null']) {
  for (const method of ['GET', 'PUT']) {
    test(`${fault}: ${method} preserves unknown preferences`, async () => {
      const root = fs.mkdtempSync(join(tmpdir(), 'onboarding-read-failure-'));
      fs.mkdirSync(join(root, '.cat-cafe'));
      const file = join(root, '.cat-cafe/user-preferences.json');
      const valid = JSON.stringify({
        catOrder: ['old-member'],
        bubbleDefaults: { cliOutput: 'collapsed' },
        onboardingGuides: { 'fixture-owner:collaboration-v1': { status: 'completed', updatedAt: 1 } },
      });
      const witness =
        fault === 'parse' ? valid.slice(0, -1) : fault === 'array' ? '[]' : fault === 'null' ? 'null' : valid;
      fs.writeFileSync(file, witness);
      const app = Fastify();
      app.addHook('onRequest', async (request) => {
        request.sessionUserId = 'fixture-owner';
      });
      await app.register(configOnboardingRoutes, { projectRoot: root });
      const originalRead = fs.readFileSync;
      let failOnce = fault === 'EIO';
      mock.method(fs, 'readFileSync', (path, ...args) => {
        if (path === file && failOnce) {
          failOnce = false;
          throw Object.assign(new Error('test-owned EIO'), { code: 'EIO' });
        }
        return originalRead(path, ...args);
      });
      syncBuiltinESMExports();
      try {
        const response = await app.inject({
          method,
          url: '/api/config/onboarding',
          ...(method === 'PUT' ? { payload: { status: 'dismissed' } } : {}),
        });
        assert.equal(response.statusCode, 503, 'unknown read cannot admit or save a fresh profile');
        assert.equal(response.json().code, 'preferences_unavailable');
        assert.equal(originalRead(file, 'utf8'), witness, 'failed read must preserve all original bytes');
      } finally {
        mock.restoreAll();
        syncBuiltinESMExports();
        await app.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test('all preference writers protect unreadable existing records inside the owner', () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'preference-owner-read-'));
  fs.mkdirSync(join(root, '.cat-cafe'));
  const file = join(root, '.cat-cafe/user-preferences.json');
  fs.writeFileSync(file, '{broken');
  let updated = false;
  try {
    assert.throws(() =>
      updateUserPreferences(root, () => {
        updated = true;
        return {};
      }),
    );
    assert.equal(updated, false);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a genuinely missing preference file admits first use and can persist a receipt', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'onboarding-first-use-'));
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    request.sessionUserId = 'fixture-owner';
  });
  await app.register(configOnboardingRoutes, { projectRoot: root });
  try {
    assert.equal((await app.inject('/api/config/onboarding')).json().status, 'not_started');
    assert.equal(
      (await app.inject({ method: 'PUT', url: '/api/config/onboarding', payload: { status: 'completed' } })).statusCode,
      200,
    );
    assert.equal((await app.inject('/api/config/onboarding')).json().status, 'completed');
  } finally {
    await app.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
