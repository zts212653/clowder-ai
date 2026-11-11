import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';

assert.equal(process.env.CAT_CAFE_TEST_SANDBOX, '1', 'Run with packages/api/scripts/with-test-home.mjs');
const { DEFAULT_MOUNT_RULES } = await import('@cat-cafe/shared');
const { default: Fastify } = await import('fastify');
const { readCapabilitiesConfig, writeCapabilitiesConfig } = await import(
  '../../dist/config/capabilities/capability-orchestrator.js'
);
const { writeMountRules } = await import('../../dist/config/mount/mount-rules-store.js');
const { mountRulesRoutes } = await import('../../dist/routes/mount-rules.js');
const { skillsWriteRoutes } = await import('../../dist/routes/skills-write.js');
const { syncProject } = await import('../../dist/skills/skill-sync-engine.js');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'foreign-mount-cleanup-'));
  const home = join(root, 'home');
  const source = join(root, 'source');
  const privateDir = join(home, '.cac', 'skills');
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    DEFAULT_OWNER_USER_ID: process.env.DEFAULT_OWNER_USER_ID,
  };
  Object.assign(process.env, { HOME: home, USERPROFILE: home, DEFAULT_OWNER_USER_ID: 'owner-user' });
  t.after(async () => {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
    await rm(root, { recursive: true, force: true });
  });
  t.mock.method(console, 'warn', () => {});
  await Promise.all(
    [privateDir, join(source, 'probe-skill'), join(source, 'refs')].map((dir) => mkdir(dir, { recursive: true })),
  );
  await writeFile(join(source, 'probe-skill', 'SKILL.md'), '# probe\n');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(join(home, '.cac'), join(home, 'bridge'), linkType);
  // Simulate a link left by the old bug; this setup remains inside the temporary home.
  await symlink(join(source, 'probe-skill'), join(privateDir, 'probe-skill'), linkType);
  const rules = {
    ...structuredClone(DEFAULT_MOUNT_RULES),
    mountPoints: Object.fromEntries(
      Object.entries(DEFAULT_MOUNT_RULES.mountPoints).map(([id, rule]) => [id, { ...rule, enabled: false }]),
    ),
    customPaths: [
      { alias: 'blocked', path: 'bridge/skills' },
      { alias: 'safe', path: '.test-skills' },
    ],
  };
  await writeMountRules(home, rules);
  return { home, source, privateDir, rules };
}

it('removes an enabled skill from a private target when its mountPaths become out of policy', async (t) => {
  const { home, source, privateDir, rules } = await fixture(t);
  const result = await syncProject(home, source, {
    mountRules: rules,
    mountPathsBySkill: new Map([['probe-skill', ['safe']]]),
  });
  assert.deepEqual(await readdir(privateDir), []);
  assert.ok(result.unmounted.some((item) => item.skillName === 'probe-skill' && item.mountPointId === 'blocked'));
  assert.ok(result.mounted.some((item) => item.skillName === 'probe-skill' && item.mountPointId === 'safe'));
});

[
  { method: 'POST', url: '/api/skills/sync', routes: skillsWriteRoutes },
  { method: 'PUT', url: '/api/mount-rules', routes: mountRulesRoutes },
].forEach(({ method, url, routes }) => {
  it(`${method} ${url} cleans a disabled plugin's private managed link`, async (t) => {
    const { home, source, privateDir, rules } = await fixture(t);
    const config = await readCapabilitiesConfig(home);
    // Plugin-owned entries are reconciled by the route, independently of cat-cafe skill cleanup.
    config.capabilities = [
      {
        id: 'probe-skill',
        type: 'skill',
        source: 'plugin',
        enabled: false,
        pluginId: 'fixture-plugin',
        skillsSource: source,
      },
    ];
    await writeCapabilitiesConfig(home, config);
    const app = Fastify();
    t.after(() => app.close());
    app.addHook('preHandler', async (request) => {
      request.sessionUserId = 'owner-user';
    });
    await app.register(routes, {
      mainProjectRoot: home,
      ...(method === 'POST' ? { skillsSourceDir: join(source, 'refs') } : {}),
    });
    const response = await app.inject({
      method,
      url,
      headers: { origin: 'http://localhost:3003', host: 'localhost:3003' },
      payload: method === 'PUT' ? { rules } : {},
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(await readdir(privateDir), []);
  });
});
