import assert from 'node:assert/strict';
import fs, { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
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
const { checkProject } = await import('../../dist/skills/drift-detector.js');
const { mountSkillSymlinks } = await import('../../dist/skills/skill-mount-ops.js');
const { syncProject } = await import('../../dist/skills/skill-sync-engine.js');

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';
const EXPLICIT_PATHS = ['.cac', '.relay', '.config/opencode'];
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
  const root = await mkdtemp(join(tmpdir(), 'mount-boundary-'));
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

it('accepts explicit relative paths on the write boundary and preserves reads', async (t) => {
  const { project } = await fixture(t);
  EXPLICIT_PATHS.concat('.CAC\\skills', './.relay/skills').forEach((path) => {
    const custom = rulesFor({ alias: 'private', path });
    assert.ok(validateMountRules(custom), path);
    const standard = rulesFor();
    standard.mountPoints.codex.path = path;
    assert.ok(validateMountRules(standard), path);
  });
  const oldRules = rulesFor({ alias: 'private', path: '.cac/skills' });
  oldRules.mountPoints.codex.path = '.relay/skills';
  await writeMountRules(project, oldRules);
  assert.deepEqual(await readMountRules(project), oldRules);
  assert.ok(validateMountRules(rulesFor({ alias: 'safe', path: 'x/.cac/skills' })));
});

['home', 'project'].forEach((scope) => {
  it(`honors explicit tool directories inside the temporary ${scope} project`, async (t) => {
    const { home, project, source } = await fixture(t);
    const projectRoot = scope === 'home' ? home : project;
    const rules = rulesFor(
      ...EXPLICIT_PATHS.map((path, index) => ({ alias: `explicit-${index}`, path: `${path}/skills` })),
    );
    const result = await syncProject(projectRoot, source, { mountRules: rules });
    assert.deepEqual(result.conflicts, []);
    for (const path of EXPLICIT_PATHS) {
      assert.equal((await lstat(join(projectRoot, path, 'skills', 'probe-skill'))).isSymbolicLink(), true);
    }
  });
});

['.relay', 'unlisted-tool'].forEach((externalName) => {
  it(`blocks a junction to ${externalName} before mkdir, including missing tail directories`, async (t) => {
    const { home, project, source } = await fixture(t);
    const outside = join(home, externalName);
    await mkdir(outside);
    await symlink(outside, join(project, 'bridge'), LINK_TYPE);
    const rules = rulesFor({ alias: 'blocked', path: 'bridge/new/skills' }, { alias: 'safe', path: '.test-skills' });
    const result = await syncProject(project, source, { mountRules: rules });
    assert.ok(result.conflicts.some((item) => item.mountPointId === 'blocked'));
    assert.deepEqual(
      result.mounted.map((item) => item.mountPointId),
      ['safe'],
    );
    assert.deepEqual(await readdir(outside), []);
  });
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

it('blocks standard mount points redirected outside the project', async (t) => {
  const { home, project, source } = await fixture(t);
  const outside = join(home, 'unlisted-tool');
  await mkdir(outside);
  await symlink(outside, join(project, '.claude'), LINK_TYPE);
  const rules = rulesFor();
  rules.mountPoints.claude.enabled = true;
  const result = await syncProject(project, source, { mountRules: rules });
  assert.ok(result.conflicts.some((item) => item.mountPointId === 'claude'));
  assert.equal(result.mounted.length, 0);
  assert.deepEqual(await readdir(outside), []);
});

it('allows a junction ancestor that stays inside the project', async (t) => {
  const { project, source } = await fixture(t);
  const inside = join(project, 'local-tool');
  await mkdir(inside);
  await symlink(inside, join(project, 'bridge'), LINK_TYPE);
  const result = await syncProject(project, source, {
    mountRules: rulesFor({ alias: 'safe', path: 'bridge/skills' }),
  });
  assert.deepEqual(result.conflicts, []);
  assert.equal((await lstat(join(inside, 'skills', 'probe-skill'))).isSymbolicLink(), true);
});

it('does not convert a legacy directory mount reached through an external ancestor', async (t) => {
  const { home, project, source } = await fixture(t);
  await mkdir(join(home, 'unlisted-tool'));
  await symlink(join(home, 'unlisted-tool'), join(project, 'bridge'), LINK_TYPE);
  const skillsDir = join(home, 'unlisted-tool', 'skills');
  await symlink(source, skillsDir, LINK_TYPE);
  const result = await syncProject(project, source, {
    mountRules: rulesFor({ alias: 'blocked', path: 'bridge/skills' }),
  });
  assert.equal((await lstat(skillsDir)).isSymbolicLink(), true);
  assert.ok(result.conflicts.some((item) => item.mountPointId === 'blocked'));
});

it('converts a local managed legacy directory link even when its source is outside the project', async (t) => {
  const { project, source } = await fixture(t);
  const skillsDir = join(project, '.test-skills');
  await symlink(source, skillsDir, LINK_TYPE);
  const result = await syncProject(project, source, {
    mountRules: rulesFor({ alias: 'safe', path: '.test-skills' }),
  });
  assert.equal((await lstat(skillsDir)).isDirectory(), true);
  assert.equal((await lstat(join(skillsDir, 'probe-skill'))).isSymbolicLink(), true);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual((await readdir(source)).sort(), ['probe-skill', 'refs']);
});

it('does not remove external user content when force sync is requested', async (t) => {
  const { home, project, source } = await fixture(t);
  const outside = join(home, 'unlisted-tool');
  const skillsDir = join(outside, 'skills');
  await mkdir(join(skillsDir, 'probe-skill'), { recursive: true });
  await symlink(outside, join(project, 'bridge'), LINK_TYPE);
  const sentinel = join(skillsDir, 'probe-skill', 'keep.txt');
  await writeFile(sentinel, 'keep');
  const result = await syncProject(project, source, {
    mountRules: rulesFor({ alias: 'blocked', path: 'bridge/skills' }),
    force: true,
  });
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  assert.deepEqual(await readdir(skillsDir), ['probe-skill']);
  assert.ok(result.conflicts.some((item) => item.skillName === 'probe-skill'));
});

it('force replaces a project-local terminal link without changing its external target', async (t) => {
  const { home, project, source } = await fixture(t);
  const outside = join(home, 'unlisted-tool');
  await mkdir(outside);
  await writeFile(join(outside, 'keep.txt'), 'keep');
  const skillsDir = join(project, '.test-skills');
  await symlink(outside, skillsDir, LINK_TYPE);
  const result = await syncProject(project, source, {
    mountRules: rulesFor({ alias: 'safe', path: '.test-skills' }),
    force: true,
  });
  assert.deepEqual(result.conflicts, []);
  assert.equal((await lstat(skillsDir)).isDirectory(), true);
  assert.equal((await lstat(join(skillsDir, 'probe-skill'))).isSymbolicLink(), true);
  assert.deepEqual(await readdir(outside), ['keep.txt']);
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep');
});

it('keeps explicit force and drift override behavior inside the project', async (t) => {
  const { project, source } = await fixture(t);
  const rules = rulesFor({ alias: 'safe', path: '.test-skills' });
  const blocker = join(project, '.test-skills', 'probe-skill');
  await mkdir(blocker, { recursive: true });
  await writeFile(join(blocker, 'keep.txt'), 'replace explicitly');
  await syncProject(project, source, { mountRules: rules, force: true });
  assert.equal((await lstat(blocker)).isSymbolicLink(), true);
  await rm(blocker);
  await mkdir(blocker);
  await writeFile(join(blocker, 'keep.txt'), 'replace explicitly');
  const report = await syncDrift(project, source, rules, {
    newSkills: [],
    conflicts: [{ skill: 'probe-skill', kind: 'directory', mountPointId: 'safe' }],
    stale: [],
    issues: [],
  });
  assert.ok(report.overridden.includes('probe-skill'));
  assert.equal((await lstat(blocker)).isSymbolicLink(), true);
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

it('keeps the existing cleanup of disabled managed links in external directories', async (t) => {
  const { home, project, source } = await fixture(t);
  const skillsDir = join(home, '.cac', 'skills');
  await mkdir(skillsDir, { recursive: true });
  await symlink(join(home, '.cac'), join(project, 'bridge'), LINK_TYPE);
  await symlink(join(source, 'probe-skill'), join(skillsDir, 'probe-skill'), LINK_TYPE);
  const result = await syncProject(project, source, {
    mountRules: rulesFor({ alias: 'blocked', path: 'bridge/skills' }),
    disabledSkills: new Set(['probe-skill']),
  });
  assert.deepEqual(await readdir(skillsDir), []);
  assert.ok(result.unmounted.some((item) => item.skillName === 'probe-skill'));
});

it('drift override preserves an external blocker instead of deleting its backup after sync', async (t) => {
  const { home, project, source } = await fixture(t);
  const outside = join(home, 'unlisted-tool');
  const blocker = join(outside, 'skills', 'probe-skill');
  await mkdir(blocker, { recursive: true });
  await symlink(outside, join(project, 'bridge'), LINK_TYPE);
  await writeFile(join(blocker, 'keep.txt'), 'keep');
  const drift = {
    newSkills: [],
    conflicts: [{ skill: 'probe-skill', kind: 'directory', mountPointId: 'blocked' }],
    stale: [],
    issues: [],
  };
  const report = await syncDrift(project, source, rulesFor({ alias: 'blocked', path: 'bridge/skills' }), drift);
  assert.equal(await readFile(join(blocker, 'keep.txt'), 'utf8'), 'keep');
  assert.ok(report.skipped.includes('probe-skill'));
  assert.equal(report.overridden.includes('probe-skill'), false);
});

it('drift restores an earlier blocker when a later boundary lookup fails', async (t) => {
  const { project, source } = await fixture(t);
  const blocker = join(project, 'first', 'skills', 'probe-skill');
  await mkdir(blocker, { recursive: true });
  await writeFile(join(blocker, 'keep.txt'), 'keep');
  const brokenDir = join(project, 'second', 'skills');
  const nativeRealpath = fs.realpath;
  t.mock.method(fs, 'realpath', (path) => {
    if (path === brokenDir) return Promise.reject(Object.assign(new Error('symlink loop'), { code: 'ELOOP' }));
    return nativeRealpath(path);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(
    syncDrift(
      project,
      source,
      rulesFor({ alias: 'first', path: 'first/skills' }, { alias: 'second', path: 'second/skills' }),
      {
        newSkills: [],
        conflicts: [
          { skill: 'probe-skill', kind: 'directory', mountPointId: 'first' },
          { skill: 'probe-skill', kind: 'directory', mountPointId: 'second' },
        ],
        stale: [],
        issues: [],
      },
    ),
    { code: 'ELOOP' },
  );
  assert.equal(await readFile(join(blocker, 'keep.txt'), 'utf8'), 'keep');
});

it('drift reports a missing mount rejected at the project boundary as skipped', async (t) => {
  const { home, project, source } = await fixture(t);
  const outside = join(home, 'unlisted-tool');
  await mkdir(outside);
  await symlink(outside, join(project, 'bridge'), LINK_TYPE);
  const rules = rulesFor({ alias: 'blocked', path: 'bridge/skills' });
  const drift = await checkProject(project, source, rules, {
    globalConfigSkills: new Set(['probe-skill']),
    projectConfigSkills: new Set(['probe-skill']),
    disabledSkills: [],
    skillMountPaths: { 'probe-skill': ['blocked'] },
  });
  assert.deepEqual(drift.conflicts, []);
  assert.ok(drift.issues.some((item) => item.skill === 'probe-skill' && item.type === 'mount-missing'));
  const report = await syncDrift(project, source, rules, drift, { skillMountPaths: { 'probe-skill': ['blocked'] } });
  assert.ok(report.skipped.includes('probe-skill'));
  assert.deepEqual(report.mounted, []);
  assert.deepEqual(await readdir(outside), []);
});

['project', 'default', 'cascade'].forEach((scope) => {
  it(`PUT ${scope} reports first-party boundary conflicts without plugin metadata`, async (t) => {
    const { home, project } = await fixture(t);
    const target = scope === 'cascade' ? join(project, 'child') : project;
    const outside = join(home, 'unlisted-tool');
    await Promise.all([target, outside].map((dir) => mkdir(dir, { recursive: true })));
    await symlink(outside, join(target, 'bridge'), LINK_TYPE);
    const rules = rulesFor({ alias: 'blocked', path: 'bridge/skills' }, { alias: 'safe', path: '.test-skills' });
    await writeCapabilitiesConfig(project, {
      version: 2,
      capabilities: [
        { id: 'debugging', type: 'skill', source: 'cat-cafe', enabled: true, mountPaths: ['blocked', 'safe'] },
      ],
    });
    if (scope === 'cascade') {
      await writeCapabilitiesConfig(target, {
        version: 2,
        capabilities: [
          { id: 'debugging', type: 'skill', source: 'cat-cafe', enabled: true, mountPaths: ['blocked', 'safe'] },
        ],
      });
    }
    const app = await appFor(t, mountRulesRoutes, { mainProjectRoot: project });
    const response = await app.inject({
      method: 'PUT',
      url: '/api/mount-rules',
      headers: WRITE_HEADERS,
      payload: { rules, ...(scope === 'project' ? {} : { scope: 'default' }) },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(response.json().skipped?.includes('debugging'), response.body);
    assert.equal((await lstat(join(target, '.test-skills', 'debugging'))).isSymbolicLink(), true);
    assert.deepEqual(await readdir(outside), []);
  });
});

it('PUT accepts project-local explicit tool directories and reads the same configuration back', async (t) => {
  const { project } = await fixture(t);
  const app = await appFor(t, mountRulesRoutes, { mainProjectRoot: project });
  const response = await app.inject({
    method: 'PUT',
    url: '/api/mount-rules',
    headers: WRITE_HEADERS,
    payload: { rules: rulesFor({ alias: 'explicit', path: '.cac/skills' }) },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual((await readMountRules(project)).customPaths, [{ alias: 'explicit', path: '.cac/skills' }]);
});

it('POST sync keeps plugin reconciliation running after a rejected historical mount', async (t) => {
  const { home, project, source } = await fixture(t);
  await mkdir(join(home, 'unlisted-tool'));
  await symlink(join(home, 'unlisted-tool'), join(project, 'bridge'), LINK_TYPE);
  const rules = rulesFor({ alias: 'blocked', path: 'bridge/skills' }, { alias: 'safe', path: '.test-skills' });
  await writeMountRules(project, rules);
  const config = await readCapabilitiesConfig(project);
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
  await writeCapabilitiesConfig(project, config);
  const app = await appFor(t, skillsWriteRoutes, { mainProjectRoot: project, skillsSourceDir: source });
  const response = await app.inject({ method: 'POST', url: '/api/skills/sync', headers: WRITE_HEADERS, payload: {} });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await lstat(join(project, '.test-skills', 'probe-skill'))).isSymbolicLink(), true);
  assert.deepEqual(await readdir(join(home, 'unlisted-tool')), []);
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

[
  { method: 'POST', url: '/api/skills/sync', routes: skillsWriteRoutes },
  { method: 'PUT', url: '/api/mount-rules', routes: mountRulesRoutes },
  { method: 'PUT', url: '/api/mount-rules', routes: mountRulesRoutes, scope: 'default' },
].forEach(({ method, url, routes, scope }) => {
  it(`${method} ${url} ${scope ?? 'project'} reports a blocked plugin-only skill and mounts legal targets`, async (t) => {
    const { home, project, source, warnings } = await fixture(t);
    await mkdir(join(home, 'unlisted-tool'));
    await symlink(join(home, 'unlisted-tool'), join(project, 'bridge'), LINK_TYPE);
    const rules = rulesFor({ alias: 'blocked', path: 'bridge/skills' }, { alias: 'safe', path: '.test-skills' });
    await writeCapabilitiesConfig(project, {
      version: 2,
      capabilities: [
        {
          id: 'probe-skill',
          type: 'skill',
          source: 'plugin',
          enabled: true,
          pluginId: 'fixture-plugin',
          skillsSource: source,
          mountPaths: ['blocked', 'safe'],
        },
      ],
    });
    await writeMountRules(project, rules);
    const app = await appFor(t, routes, {
      mainProjectRoot: project,
      ...(method === 'POST' ? { skillsSourceDir: join(source, 'refs') } : {}),
    });
    const response = await app.inject({
      method,
      url,
      headers: WRITE_HEADERS,
      payload: method === 'PUT' ? { rules, ...(scope ? { scope } : {}) } : {},
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(response.json().skipped?.includes('probe-skill'), response.body);
    assert.equal((await lstat(join(project, '.test-skills', 'probe-skill'))).isSymbolicLink(), true);
    assert.deepEqual(await readdir(join(home, 'unlisted-tool')), []);
    assert.ok(
      warnings.mock.calls.some(({ arguments: args }) => args.some((arg) => String(arg).includes('probe-skill'))),
    );
  });
});
