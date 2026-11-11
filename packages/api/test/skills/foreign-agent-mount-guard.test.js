import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { it } from 'node:test';

// Fail before importing production code or creating fixtures when run without the sandbox wrapper.
assert.equal(process.env.CAT_CAFE_TEST_SANDBOX, '1', 'Run with packages/api/scripts/with-test-home.mjs');

const { DEFAULT_MOUNT_RULES } = await import('@cat-cafe/shared');
const { default: Fastify } = await import('fastify');
const { readCapabilitiesConfig, writeCapabilitiesConfig } = await import(
  '../../dist/config/capabilities/capability-orchestrator.js'
);
const { readMountRules, validateMountRules, writeMountRules } = await import(
  '../../dist/config/mount/mount-rules-store.js'
);
const { mountRulesRoutes } = await import('../../dist/routes/mount-rules.js');
const { skillsWriteRoutes } = await import('../../dist/routes/skills-write.js');
const { syncDrift } = await import('../../dist/skills/drift-resolver.js');
const { mountSkillSymlinks } = await import('../../dist/skills/skill-mount-ops.js');
const { syncProject } = await import('../../dist/skills/skill-sync-engine.js');
const { createSkillSymlink } = await import('../../dist/utils/skill-mount.js');

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';
const PRIVATE_ROOTS = ['.cac', '.relay', '.config/opencode'];
const WRITE_HEADERS = { 'x-test-session-user': 'owner-user', origin: 'http://localhost:3003', host: 'localhost:3003' };

function rulesFor(...customPaths) {
  return {
    ...structuredClone(DEFAULT_MOUNT_RULES),
    mountPoints: Object.fromEntries(
      Object.entries(DEFAULT_MOUNT_RULES.mountPoints).map(([id, rule]) => [id, { ...rule, enabled: false }]),
    ),
    customPaths,
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'foreign-agent-mount-'));
  const home = join(root, 'home');
  assert.equal(relative(resolve(tmpdir()), home).startsWith('..'), false);
  const project = join(root, 'project');
  const source = join(root, 'source');
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
  const warnings = t.mock.method(console, 'warn', () => {});
  await Promise.all(
    [home, project, join(source, 'probe-skill'), join(source, 'refs')].map((dir) => mkdir(dir, { recursive: true })),
  );
  await writeFile(join(source, 'probe-skill', 'SKILL.md'), '# probe\n');
  return { root, home, project, source, warnings };
}

async function appFor(t, routes, opts) {
  const app = Fastify();
  t.after(() => app.close());
  app.addHook('preHandler', async (request) => {
    request.sessionUserId = request.headers['x-test-session-user'];
  });
  await app.register(routes, opts);
  await app.ready();
  return app;
}

PRIVATE_ROOTS.forEach((privateRoot) => {
  it(`rejects direct creation inside injected home/${privateRoot}`, async (t) => {
    const { root, source } = await fixture(t);
    // The explicit boundary differs from process HOME; removing the guard still writes only to this fixture.
    const home = join(root, 'injected-home');
    const skillsDir = join(home, privateRoot, 'skills');
    await mkdir(skillsDir, { recursive: true });
    await assert.rejects(
      createSkillSymlink(join(source, 'probe-skill'), join(skillsDir, 'probe-skill'), home),
      /foreign agent/i,
    );
    assert.deepEqual(await readdir(skillsDir), []);
  });
});

it('allows project-local names and private-root lookalikes', async (t) => {
  const { home, project, source } = await fixture(t);
  const dirs = [
    join(project, '.cac', 'skills'),
    ...['.cacfoo', '.relay-tools', '.config/opencodeX'].map((path) => join(home, path, 'skills')),
  ];
  await Promise.all(
    dirs.map(async (dir) => {
      await mkdir(dir, { recursive: true });
      await createSkillSymlink(join(source, 'probe-skill'), join(dir, 'probe-skill'), home);
      assert.equal((await lstat(join(dir, 'probe-skill'))).isSymbolicLink(), true);
    }),
  );
});

it('uses process home when the final creation boundary is not explicitly injected', async (t) => {
  const { home, source } = await fixture(t);
  const skillsDir = join(home, '.relay', 'skills');
  await mkdir(skillsDir, { recursive: true });
  await assert.rejects(
    createSkillSymlink(join(source, 'probe-skill'), join(skillsDir, 'probe-skill')),
    /foreign agent/i,
  );
  assert.deepEqual(await readdir(skillsDir), []);
});

it('rejects reserved prefixes on the write boundary while preserving historical reads', async (t) => {
  const { project } = await fixture(t);
  PRIVATE_ROOTS.concat('.CAC\\skills', './.relay/skills').forEach((path) => {
    const custom = rulesFor({ alias: 'private', path });
    assert.equal(validateMountRules(custom), null, path);
    const standard = rulesFor();
    standard.mountPoints.codex.path = path;
    assert.equal(validateMountRules(standard), null, path);
  });
  const oldRules = rulesFor({ alias: 'private', path: '.cac/skills' });
  oldRules.mountPoints.codex.path = '.relay/skills';
  await writeMountRules(project, oldRules);
  assert.deepEqual(await readMountRules(project), oldRules);
  assert.ok(validateMountRules(rulesFor({ alias: 'safe', path: 'x/.cac/skills' })));
});

it('syncs a legal target while reporting a direct private-home target as a conflict', async (t) => {
  const { home, source, warnings } = await fixture(t);
  await mkdir(join(home, '.cac'));
  const rules = rulesFor({ alias: 'blocked', path: '.cac/skills' }, { alias: 'safe', path: '.test-skills' });
  await writeMountRules(home, rules);
  const result = await syncProject(home, source, { mountRules: rules });
  assert.ok(result.conflicts.some((item) => item.skillName === 'probe-skill' && item.mountPointId === 'blocked'));
  assert.deepEqual(
    result.mounted.map((item) => item.mountPointId),
    ['safe'],
  );
  assert.deepEqual(await readdir(join(home, '.cac')), []);
  assert.deepEqual(await readMountRules(home), rules);
  assert.ok(warnings.mock.calls.some((call) => String(call.arguments[0]).includes('foreign agent')));
});

it('blocks a junction ancestor before mkdir, including missing tail directories', async (t) => {
  const { home, project, source } = await fixture(t);
  await mkdir(join(home, '.relay'));
  await symlink(join(home, '.relay'), join(project, 'bridge'), LINK_TYPE);
  const rules = rulesFor({ alias: 'blocked', path: 'bridge/new/skills' }, { alias: 'safe', path: '.test-skills' });
  const result = await syncProject(project, source, { mountRules: rules });
  assert.ok(result.conflicts.some((item) => item.mountPointId === 'blocked'));
  assert.deepEqual(
    result.mounted.map((item) => item.mountPointId),
    ['safe'],
  );
  assert.deepEqual(await readdir(join(home, '.relay')), []);
});

it('recognizes the physical private root when that root is itself a junction', async (t) => {
  const { root, home, project, source } = await fixture(t);
  const relocated = join(root, 'relocated-private');
  await mkdir(relocated);
  await symlink(relocated, join(home, '.cac'), LINK_TYPE);
  await symlink(relocated, join(project, 'bridge'), LINK_TYPE);
  const result = await syncProject(project, source, {
    mountRules: rulesFor({ alias: 'blocked', path: 'bridge/skills' }),
  });
  assert.equal(result.mounted.length, 0);
  assert.ok(result.conflicts.some((item) => item.mountPointId === 'blocked'));
  assert.deepEqual(await readdir(relocated), []);
});

it('does not convert a legacy directory mount reached through a private ancestor', async (t) => {
  const { home, project, source } = await fixture(t);
  await mkdir(join(home, '.relay'));
  await symlink(join(home, '.relay'), join(project, 'bridge'), LINK_TYPE);
  const skillsDir = join(home, '.relay', 'skills');
  await symlink(source, skillsDir, LINK_TYPE);
  const result = await syncProject(project, source, {
    mountRules: rulesFor({ alias: 'blocked', path: 'bridge/skills' }),
  });
  assert.equal((await lstat(skillsDir)).isSymbolicLink(), true);
  assert.ok(result.conflicts.some((item) => item.mountPointId === 'blocked'));
});

it('does not remove private user content when force sync is requested', async (t) => {
  const { home, source } = await fixture(t);
  const skillsDir = join(home, '.cac', 'skills');
  await mkdir(join(skillsDir, 'probe-skill'), { recursive: true });
  const sentinel = join(skillsDir, 'probe-skill', 'keep.txt');
  await writeFile(sentinel, 'keep');
  const result = await syncProject(home, source, {
    mountRules: rulesFor({ alias: 'blocked', path: '.cac/skills' }),
    force: true,
  });
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  assert.deepEqual(await readdir(skillsDir), ['probe-skill']);
  assert.ok(result.conflicts.some((item) => item.skillName === 'probe-skill'));
});

it('mountSkillSymlinks skips the private target and continues legal targets', async (t) => {
  const { home, project, source } = await fixture(t);
  await mkdir(join(home, '.relay'));
  await symlink(join(home, '.relay'), join(project, 'bridge'), LINK_TYPE);
  const rules = rulesFor({ alias: 'blocked', path: 'bridge/skills' }, { alias: 'safe', path: '.test-skills' });
  const result = await mountSkillSymlinks(project, 'probe-skill', source, rules);
  assert.ok(result.conflicts.some((item) => item.mountPointId === 'blocked'));
  assert.deepEqual(
    result.mounted.map((item) => item.mountPointId),
    ['safe'],
  );
  assert.deepEqual(await readdir(join(home, '.relay')), []);
});

it('keeps the existing cleanup of disabled managed links in private directories', async (t) => {
  const { home, source } = await fixture(t);
  const skillsDir = join(home, '.cac', 'skills');
  await mkdir(skillsDir, { recursive: true });
  await symlink(join(source, 'probe-skill'), join(skillsDir, 'probe-skill'), LINK_TYPE);
  const result = await syncProject(home, source, {
    mountRules: rulesFor({ alias: 'blocked', path: '.cac/skills' }),
    disabledSkills: new Set(['probe-skill']),
  });
  assert.deepEqual(await readdir(skillsDir), []);
  assert.ok(result.unmounted.some((item) => item.skillName === 'probe-skill'));
});

it('drift override preserves a private blocker instead of deleting its backup after sync', async (t) => {
  const { home, source } = await fixture(t);
  const blocker = join(home, '.cac', 'skills', 'probe-skill');
  await mkdir(blocker, { recursive: true });
  await writeFile(join(blocker, 'keep.txt'), 'keep');
  const drift = {
    newSkills: [],
    conflicts: [{ skill: 'probe-skill', kind: 'directory', mountPointId: 'blocked' }],
    stale: [],
    issues: [],
  };
  const report = await syncDrift(home, source, rulesFor({ alias: 'blocked', path: '.cac/skills' }), drift);
  assert.equal(await readFile(join(blocker, 'keep.txt'), 'utf8'), 'keep');
  assert.ok(report.skipped.includes('probe-skill'));
  assert.equal(report.overridden.includes('probe-skill'), false);
});

it('PUT rejects a reserved path with the existing 400 response', async (t) => {
  const { project } = await fixture(t);
  const app = await appFor(t, mountRulesRoutes, { mainProjectRoot: project });
  const response = await app.inject({
    method: 'PUT',
    url: '/api/mount-rules',
    headers: WRITE_HEADERS,
    payload: { rules: rulesFor({ alias: 'blocked', path: '.cac/skills' }) },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'Invalid mount rules: schema validation failed');
});

it('POST sync keeps plugin reconciliation running after a rejected historical mount', async (t) => {
  const { home, source } = await fixture(t);
  await mkdir(join(home, '.cac'));
  const rules = rulesFor({ alias: 'blocked', path: '.cac/skills' }, { alias: 'safe', path: '.test-skills' });
  await writeMountRules(home, rules);
  const config = await readCapabilitiesConfig(home);
  config.capabilities = [
    {
      id: 'probe-skill',
      type: 'skill',
      source: 'cat-cafe',
      enabled: true,
      pluginId: 'fixture-plugin',
      skillsSource: source,
      mountPaths: ['blocked', 'safe'],
    },
  ];
  await writeCapabilitiesConfig(home, config);
  const app = await appFor(t, skillsWriteRoutes, { mainProjectRoot: home, skillsSourceDir: source });
  const response = await app.inject({ method: 'POST', url: '/api/skills/sync', headers: WRITE_HEADERS, payload: {} });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await lstat(join(home, '.test-skills', 'probe-skill'))).isSymbolicLink(), true);
  assert.deepEqual(await readdir(join(home, '.cac')), []);
  assert.ok(response.json().skipped.includes('probe-skill'));
});

it('PUT with a junction target also skips the separate plugin reconciliation loop', async (t) => {
  const { home, project, source } = await fixture(t);
  await mkdir(join(home, '.relay'));
  await symlink(join(home, '.relay'), join(project, 'bridge'), LINK_TYPE);
  await writeCapabilitiesConfig(project, {
    version: 2,
    capabilities: [
      {
        id: 'probe-skill',
        type: 'skill',
        source: 'cat-cafe',
        enabled: true,
        pluginId: 'fixture-plugin',
        skillsSource: source,
        mountPaths: ['blocked', 'safe'],
      },
    ],
  });
  const app = await appFor(t, mountRulesRoutes, { mainProjectRoot: project });
  const response = await app.inject({
    method: 'PUT',
    url: '/api/mount-rules',
    headers: WRITE_HEADERS,
    payload: { rules: rulesFor({ alias: 'blocked', path: 'bridge/skills' }, { alias: 'safe', path: '.test-skills' }) },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await lstat(join(project, '.test-skills', 'probe-skill'))).isSymbolicLink(), true);
  assert.deepEqual(await readdir(join(home, '.relay')), []);
});
