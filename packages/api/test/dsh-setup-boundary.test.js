import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { resolveDshSetupLaunch } from '../dist/routes/dsh-setup-launch.js';
import { registerDshSetupRoutes } from '../dist/routes/dsh-setup-route.js';
import { dshSourceProfiles } from '../dist/routes/dsh-setup-service.js';

test('recognizes a real package descriptor and keeps ordered overlays; rejects wrappers and extra flags', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-setup-target-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  });
  mkdirSync(join(root, 'profiles/acp'), { recursive: true });
  writeFileSync(
    join(root, 'profiles/acp/package.json'),
    JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-acp-app'] } } }),
  );
  const pkg = join(root, 'dsh');
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }));
  const entry = join(pkg, 'lib/bin.js'),
    a = join(root, 'a.yml'),
    b = join(root, 'b.yml');
  const args = [entry, '--profile', 'acp', '--patch', a, '--patch', b];
  assert.deepEqual(resolveDshSetupLaunch(process.execPath, args, root).args, args);
  assert.equal(resolveDshSetupLaunch(process.execPath, args, root).profileIndex, 2);
  for (const invalid of [
    [entry, '--eval', 'code'],
    [...args, '--from-default-profile', 'acp'],
    [...args, '--patch', '../outside.yml'],
  ])
    assert.throws(() => resolveDshSetupLaunch(process.execPath, invalid, root), /custom_startup/);
  assert.throws(
    () => resolveDshSetupLaunch(process.execPath, [join(root, 'wrapper.js'), '--profile', 'acp'], root),
    /custom_startup/,
  );
});
test('source discovery never initializes or advertises partial profiles', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-setup-profiles-'));
  for (const profile of ['desktop', 'partial']) {
    mkdirSync(join(root, 'profiles', profile), { recursive: true });
    writeFileSync(
      join(root, 'profiles', profile, 'package.json'),
      JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }),
    );
  }
  writeFileSync(join(root, 'profiles/desktop/cordis.yml'), '[]');
  assert.deepEqual(dshSourceProfiles(root), ['desktop']);
});
test('configuration and model-test endpoints require a direct authenticated owner, never header identity', async () => {
  const app = Fastify();
  registerDshSetupRoutes(app);
  for (const action of ['inspect', 'prepare', 'test']) {
    const unauthenticated = await app.inject({
      method: 'POST',
      url: `/api/cats/dsh-setup/${action}`,
      headers: { 'x-cat-cafe-user': 'owner' },
      payload: {},
    });
    assert.equal(unauthenticated.statusCode, 401);
    const proxied = await app.inject({
      method: 'POST',
      url: `/api/cats/dsh-setup/${action}`,
      headers: { 'x-forwarded-for': '192.0.2.1' },
      payload: {},
    });
    assert.equal(proxied.statusCode, 403);
  }
  await app.close();
});

test('Desktop inspection accepts runtime IDs, never client-supplied executables or environment', async (t) => {
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'fixture-owner';
  t.after(() => {
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
  });
  const app = Fastify();
  app.decorateRequest('sessionUserId', 'fixture-owner');
  registerDshSetupRoutes(app, { audit: async () => {} });
  for (const extra of [{ command: 'arbitrary' }, { args: ['--eval', 'code'] }, { env: { DSH_HOME: 'untrusted' } }]) {
    const result = await app.inject({
      method: 'POST',
      url: '/api/cats/dsh-setup/inspect',
      payload: { runtimeId: 'dsh', ...extra },
    });
    assert.equal(result.statusCode, 400);
    assert.equal(result.json().error, 'dsh_setup_invalid_request');
  }
  await app.close();
});
