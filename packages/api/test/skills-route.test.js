/**
 * Skills route tests
 * GET /api/skills — Clowder AI 共享 Skills 看板数据
 */

import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_MOUNT_RULES } from '@cat-cafe/shared';
import Fastify from 'fastify';
import {
  readCapabilitiesConfig,
  writeCapabilitiesConfig,
} from '../dist/config/capabilities/capability-orchestrator.js';
import { writeDefaultMountRules, writeMountRules } from '../dist/config/mount/mount-rules-store.js';
import { skillsRoutes } from '../dist/routes/skills.js';
import { skillsWriteRoutes } from '../dist/routes/skills-write.js';
import { resolveStartupProjectRoot } from '../dist/utils/startup-root.js';

const AUTH_HEADERS = { 'x-cat-cafe-user': 'test-user' };
const OWNER_SESSION_HEADERS = {
  'x-test-session-user': 'you',
  origin: 'http://localhost:3003',
  host: 'localhost:3003',
};

function resolveRepoSkillsDir() {
  return join(resolveStartupProjectRoot(), 'cat-cafe-skills');
}

async function listSourceSkillNames(sourceSkillsDir) {
  const entries = await readdir(sourceSkillsDir, { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      if ((await stat(join(sourceSkillsDir, entry.name, 'SKILL.md'))).isFile()) names.push(entry.name);
    } catch {
      // not a skill
    }
  }
  return names.sort();
}

async function buildSessionSkillsApp(opts = {}) {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    const raw = request.headers['x-test-session-user'];
    if (typeof raw === 'string' && raw.trim()) {
      request.sessionUserId = raw.trim();
    }
  });
  await app.register(skillsRoutes, opts);
  await app.register(skillsWriteRoutes, opts);
  await app.ready();
  return app;
}

describe('Skills Route', () => {
  it('resolves the source skills directory without requiring cwd to be a git checkout', async () => {
    const previousCwd = process.cwd();
    const nonGitDir = await mkdtemp(join(tmpdir(), 'skills-route-nogit-'));
    try {
      process.chdir(nonGitDir);

      const sourceSkillsDir = resolveRepoSkillsDir();
      assert.equal((await stat(join(sourceSkillsDir, 'manifest.yaml'))).isFile(), true);
    } finally {
      process.chdir(previousCwd);
      await rm(nonGitDir, { recursive: true, force: true });
    }
  });

  it('returns 401 when no identity header is provided', async () => {
    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/skills',
    });

    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('Identity required'));

    await app.close();
  });

  it('GET /api/skills returns skills array and summary', async () => {
    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/skills',
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);

    // Response structure
    assert.ok(Array.isArray(body.skills), 'skills should be an array');
    assert.ok(body.summary, 'should have summary');
    assert.equal(typeof body.summary.total, 'number');
    assert.equal(typeof body.summary.allMounted, 'boolean');
    assert.equal(typeof body.summary.registrationConsistent, 'boolean');

    await app.close();
  });

  it('GET /api/skills excludes plugin-owned skills from source-tree registration consistency', async () => {
    const rawProjectDir = join('/tmp', `skills-route-test-plugin-registration-${Date.now()}`);
    await mkdir(rawProjectDir, { recursive: true });
    const projectDir = await realpath(rawProjectDir);
    const sourceSkillsDir = resolveRepoSkillsDir();
    const sourceSkillNames = await listSourceSkillNames(sourceSkillsDir);
    assert.ok(sourceSkillNames.length > 0, 'expected source cat-cafe skills');
    const pluginSkillName = `plugin-owned-registration-${Date.now()}`;

    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [
        ...sourceSkillNames.map((id) => ({
          id,
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          mountPaths: [],
        })),
        {
          id: pluginSkillName,
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'test-registration-plugin',
          skillsSource: join(projectDir, 'plugins', 'test-registration-plugin', 'skills'),
          mountPaths: [],
        },
      ],
    });

    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/skills?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.summary.registrationConsistent, true);
      assert.deepEqual(body.summary.registrationIssues.phantom, []);
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('each skill entry has required fields', async () => {
    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/skills',
      headers: AUTH_HEADERS,
    });

    const body = JSON.parse(res.body);
    if (body.skills.length === 0) {
      // No skills found (possible in CI), skip field checks
      await app.close();
      return;
    }

    for (const skill of body.skills) {
      assert.equal(typeof skill.name, 'string', 'name should be string');
      assert.equal(typeof skill.category, 'string', 'category should be string');
      assert.equal(typeof skill.trigger, 'string', 'trigger should be string');
      assert.ok(skill.mounts, 'should have mounts');
      assert.equal(typeof skill.mounts.claude, 'boolean');
      assert.equal(typeof skill.mounts.codex, 'boolean');
      assert.equal(typeof skill.mounts.gemini, 'boolean');
      assert.equal(typeof skill.mounts.kimi, 'boolean');
    }

    await app.close();
  });

  it('skills follow manifest ordering (manifest-listed before source-only)', async () => {
    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/skills',
      headers: AUTH_HEADERS,
    });

    const body = JSON.parse(res.body);
    if (body.skills.length === 0) {
      await app.close();
      return;
    }

    // Read manifest to determine which skills are registered (category alone is
    // not reliable — manifest skills without an explicit category get '未分類').
    const { parse: parseYaml } = await import('yaml');
    const { readFile } = await import('node:fs/promises');
    const manifestRaw = await readFile(join(resolveRepoSkillsDir(), 'manifest.yaml'), 'utf-8');
    const manifestNames = new Set(Object.keys(parseYaml(manifestRaw).skills ?? {}));

    let seenSourceOnly = false;
    for (const skill of body.skills) {
      if (!manifestNames.has(skill.name)) {
        seenSourceOnly = true;
      } else if (seenSourceOnly) {
        assert.fail(`Manifest skill "${skill.name}" appeared after source-only skill — ordering violated`);
      }
    }

    await app.close();
  });

  it('summary.total matches skills array length', async () => {
    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/skills',
      headers: AUTH_HEADERS,
    });

    const body = JSON.parse(res.body);
    assert.equal(body.summary.total, body.skills.length);

    await app.close();
  });

  it('treats directory-level project skills symlinks as mounted for all providers', async () => {
    const projectDir = join('/tmp', `skills-route-test-dir-symlink-${Date.now()}`);
    const homeDir = join('/tmp', `skills-route-test-home-${Date.now()}`);
    const sourceSkillsDir = resolveRepoSkillsDir();
    const prevHome = process.env.HOME;

    await Promise.all([
      mkdir(join(projectDir, '.claude'), { recursive: true }),
      mkdir(join(projectDir, '.codex'), { recursive: true }),
      mkdir(join(projectDir, '.gemini'), { recursive: true }),
      mkdir(join(projectDir, '.kimi'), { recursive: true }),
      mkdir(homeDir, { recursive: true }),
    ]);
    await Promise.all([
      symlink(sourceSkillsDir, join(projectDir, '.claude', 'skills')),
      symlink(sourceSkillsDir, join(projectDir, '.codex', 'skills')),
      symlink(sourceSkillsDir, join(projectDir, '.gemini', 'skills')),
      symlink(sourceSkillsDir, join(projectDir, '.kimi', 'skills')),
    ]);

    process.env.HOME = homeDir;

    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/skills?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.summary.allMounted, true, 'project-level directory symlinks should count as mounted');

      const debugging = body.skills.find((skill) => skill.name === 'debugging');
      assert.ok(debugging, 'debugging skill should be present');
      assert.deepEqual(debugging.mounts, { claude: true, codex: true, gemini: true, kimi: true });
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('accepts HOME-level fallback symlinks that still point to the main repo skills tree', async () => {
    const projectDir = join('/tmp', `skills-route-test-fallback-project-${Date.now()}`);
    const homeDir = join('/tmp', `skills-route-test-fallback-home-${Date.now()}`);
    const prevHome = process.env.HOME;
    const mainRepo = resolveStartupProjectRoot();
    const mainSkillsDir = join(mainRepo, 'cat-cafe-skills');

    await Promise.all([
      mkdir(projectDir, { recursive: true }),
      mkdir(join(homeDir, '.claude'), { recursive: true }),
      mkdir(join(homeDir, '.codex'), { recursive: true }),
      mkdir(join(homeDir, '.gemini'), { recursive: true }),
      mkdir(join(homeDir, '.kimi'), { recursive: true }),
    ]);
    await Promise.all([
      symlink(mainSkillsDir, join(homeDir, '.claude', 'skills')),
      symlink(mainSkillsDir, join(homeDir, '.codex', 'skills')),
      symlink(mainSkillsDir, join(homeDir, '.gemini', 'skills')),
      symlink(mainSkillsDir, join(homeDir, '.kimi', 'skills')),
    ]);

    process.env.HOME = homeDir;

    const app = Fastify();
    // The test's HOME symlinks point to the git main worktree. Pass it as
    // mainProjectRoot so the route recognizes those symlinks as managed.
    await app.register(skillsRoutes, { mainProjectRoot: mainRepo });
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/skills?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.summary.allMounted, true, 'main-repo fallback skills symlink should still count as mounted');
      const debugging = body.skills.find((skill) => skill.name === 'debugging');
      assert.ok(debugging, 'debugging skill should be present');
      assert.deepEqual(debugging.mounts, { claude: true, codex: true, gemini: true, kimi: true });
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('counts canonical HOME mounts when standard project mount path is customized', async () => {
    const projectDir = join('/tmp', `skills-route-test-custom-project-path-${Date.now()}`);
    const homeDir = join('/tmp', `skills-route-test-custom-project-path-home-${Date.now()}`);
    const sourceSkillsDir = resolveRepoSkillsDir();
    const prevHome = process.env.HOME;
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        claude: { enabled: true, path: '.project-claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };

    await Promise.all([mkdir(projectDir, { recursive: true }), mkdir(join(homeDir, '.claude'), { recursive: true })]);
    await Promise.all([
      writeMountRules(projectDir, rules),
      symlink(sourceSkillsDir, join(homeDir, '.claude', 'skills')),
    ]);

    process.env.HOME = homeDir;

    const app = Fastify();
    await app.register(skillsRoutes, { mainProjectRoot: projectDir });
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/skills?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      const debugging = body.skills.find((skill) => skill.name === 'debugging');
      assert.ok(debugging, 'debugging skill should be present');
      assert.equal(debugging.mounts.claude, true, 'canonical HOME .claude/skills should satisfy Claude mount health');
      assert.deepEqual(debugging.mountHealth, {
        enabledMountPoints: ['claude'],
        mountedCount: 1,
        requiredCount: 1,
        allMounted: true,
      });
      assert.equal(body.summary.allMounted, true);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('summary and per-skill mount health ignore intentionally disabled standard providers', async () => {
    const projectDir = join('/tmp', `skills-route-test-disabled-provider-${Date.now()}`);
    const homeDir = join('/tmp', `skills-route-test-disabled-provider-home-${Date.now()}`);
    const sourceSkillsDir = resolveRepoSkillsDir();
    const prevHome = process.env.HOME;
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };

    await Promise.all([
      mkdir(join(projectDir, '.claude'), { recursive: true }),
      mkdir(join(projectDir, '.codex'), { recursive: true }),
      mkdir(join(projectDir, '.gemini'), { recursive: true }),
      mkdir(homeDir, { recursive: true }),
    ]);
    await writeMountRules(projectDir, rules);
    await Promise.all([
      symlink(sourceSkillsDir, join(projectDir, '.claude', 'skills')),
      symlink(sourceSkillsDir, join(projectDir, '.codex', 'skills')),
      symlink(sourceSkillsDir, join(projectDir, '.gemini', 'skills')),
    ]);
    process.env.HOME = homeDir;

    const app = Fastify();
    await app.register(skillsRoutes, { mainProjectRoot: projectDir });
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/skills?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.summary.allMounted, true, 'disabled kimi provider should not keep health red');
      const debugging = body.skills.find((skill) => skill.name === 'debugging');
      assert.ok(debugging, 'debugging skill should be present');
      assert.deepEqual(debugging.mounts, { claude: true, codex: true, gemini: true, kimi: false });
      assert.deepEqual(debugging.mountHealth, {
        enabledMountPoints: ['claude', 'codex', 'gemini'],
        mountedCount: 3,
        requiredCount: 3,
        allMounted: true,
      });
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('summary and per-skill mount health use capability mountPaths as the required provider set', async () => {
    const projectDir = join('/tmp', `skills-route-test-mountpaths-health-${Date.now()}`);
    const homeDir = join('/tmp', `skills-route-test-mountpaths-health-home-${Date.now()}`);
    const sourceSkillsDir = resolveRepoSkillsDir();
    const sourceSkillNames = await listSourceSkillNames(sourceSkillsDir);
    const prevHome = process.env.HOME;

    await Promise.all([
      mkdir(join(projectDir, '.claude/skills'), { recursive: true }),
      mkdir(join(projectDir, '.codex/skills'), { recursive: true }),
      mkdir(join(projectDir, '.gemini/skills'), { recursive: true }),
      mkdir(join(projectDir, '.kimi/skills'), { recursive: true }),
      mkdir(homeDir, { recursive: true }),
      writeCapabilitiesConfig(projectDir, {
        version: 2,
        capabilities: sourceSkillNames.map((id) => ({
          id,
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          mountPaths: ['claude', 'codex', 'gemini'],
        })),
      }),
    ]);
    for (const provider of ['claude', 'codex', 'gemini']) {
      for (const skillName of sourceSkillNames) {
        await symlink(join(sourceSkillsDir, skillName), join(projectDir, `.${provider}/skills`, skillName));
      }
    }
    process.env.HOME = homeDir;

    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/skills?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.summary.allMounted, true, 'unlisted kimi mount should not keep health red');
      const debugging = body.skills.find((skill) => skill.name === 'debugging');
      assert.ok(debugging, 'debugging skill should be present');
      assert.deepEqual(debugging.mounts, { claude: true, codex: true, gemini: true, kimi: false });
      assert.deepEqual(debugging.mountHealth, {
        enabledMountPoints: ['claude', 'codex', 'gemini', 'kimi'],
        mountedCount: 3,
        requiredCount: 3,
        allMounted: true,
      });
      assert.deepEqual(debugging.mountPaths, ['claude', 'codex', 'gemini']);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('mountPaths containing a disabled provider does not inflate required count', async () => {
    const projectDir = join('/tmp', `skills-route-test-disabled-in-mountpaths-${Date.now()}`);
    const homeDir = join('/tmp', `skills-route-test-disabled-in-mountpaths-home-${Date.now()}`);
    const sourceSkillsDir = resolveRepoSkillsDir();
    const sourceSkillNames = await listSourceSkillNames(sourceSkillsDir);
    const prevHome = process.env.HOME;

    // mountPaths declares kimi, but kimi is disabled in mount rules
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };

    await Promise.all([
      mkdir(join(projectDir, '.claude/skills'), { recursive: true }),
      mkdir(join(projectDir, '.codex/skills'), { recursive: true }),
      mkdir(join(projectDir, '.gemini/skills'), { recursive: true }),
      mkdir(homeDir, { recursive: true }),
    ]);
    // Sequential: both write to the same capabilities.json.  Write capabilities
    // first (full overwrite), then writeMountRules (read-modify-write adds mountRules).
    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: sourceSkillNames.map((id) => ({
        id,
        type: 'skill',
        enabled: true,
        source: 'cat-cafe',
        mountPaths: ['claude', 'codex', 'gemini', 'kimi'],
      })),
    });
    await writeMountRules(projectDir, rules);
    for (const provider of ['claude', 'codex', 'gemini']) {
      for (const skillName of sourceSkillNames) {
        await symlink(join(sourceSkillsDir, skillName), join(projectDir, `.${provider}/skills`, skillName));
      }
    }
    process.env.HOME = homeDir;

    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/skills?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.summary.allMounted, true, 'disabled kimi in stale mountPaths should not keep health red');
      const debugging = body.skills.find((skill) => skill.name === 'debugging');
      assert.ok(debugging, 'debugging skill should be present');
      assert.deepEqual(debugging.mountHealth.enabledMountPoints, ['claude', 'codex', 'gemini']);
      assert.equal(debugging.mountHealth.requiredCount, 3, 'disabled kimi should be excluded from required count');
      assert.equal(debugging.mountHealth.mountedCount, 3);
      assert.equal(debugging.mountHealth.allMounted, true);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('GET /api/skills counts custom mount targets in summary and per-skill health', async () => {
    const projectDir = join('/tmp', `skills-route-test-custom-health-${Date.now()}`);
    const homeDir = join('/tmp', `skills-route-test-custom-health-home-${Date.now()}`);
    const customSkillsDir = 'custom-client-skills';
    const customSkillsDirPath = join(projectDir, customSkillsDir);
    const sourceSkillsDir = resolveRepoSkillsDir();
    const prevHome = process.env.HOME;
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        claude: { enabled: false, path: '.claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
      customPaths: [{ alias: 'opencode', path: customSkillsDir }],
    };

    await Promise.all([mkdir(projectDir, { recursive: true }), mkdir(homeDir, { recursive: true })]);
    await writeMountRules(projectDir, rules);
    process.env.HOME = homeDir;

    const app = Fastify();
    // Isolate from the developer's actual capabilities config — without
    // mainProjectRoot the test inherits global skill policy from the running
    // worktree (which may have most skills disabled).
    await app.register(skillsRoutes, { mainProjectRoot: projectDir });
    await app.ready();

    try {
      const missingRes = await app.inject({
        method: 'GET',
        url: `/api/skills?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(missingRes.statusCode, 200);
      const missingBody = JSON.parse(missingRes.body);
      assert.equal(missingBody.summary.allMounted, false, 'missing custom mount should keep health red');
      const missingDebugging = missingBody.skills.find((skill) => skill.name === 'debugging');
      assert.ok(missingDebugging, 'debugging skill should be present');
      assert.deepEqual(missingDebugging.mountHealth, {
        enabledMountPoints: ['opencode'],
        mountedCount: 0,
        requiredCount: 1,
        allMounted: false,
      });
      assert.equal(missingDebugging.mounts.opencode, false, 'custom mount status should be returned per skill');

      await symlink(sourceSkillsDir, customSkillsDirPath);

      const mountedRes = await app.inject({
        method: 'GET',
        url: `/api/skills?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(mountedRes.statusCode, 200);
      const mountedBody = JSON.parse(mountedRes.body);
      assert.equal(mountedBody.summary.allMounted, true, 'directory-level custom mount should satisfy health');
      const mountedDebugging = mountedBody.skills.find((skill) => skill.name === 'debugging');
      assert.ok(mountedDebugging, 'debugging skill should be present after custom mount');
      assert.deepEqual(mountedDebugging.mountHealth, {
        enabledMountPoints: ['opencode'],
        mountedCount: 1,
        requiredCount: 1,
        allMounted: true,
      });
      assert.equal(mountedDebugging.mounts.opencode, true, 'custom mount status should be returned per skill');
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('GET /api/skills treats globally disabled cat-cafe skills as not required mounts', async () => {
    const projectDir = join('/tmp', `skills-route-test-disabled-skill-health-${Date.now()}`);
    const homeDir = join('/tmp', `skills-route-test-disabled-skill-health-home-${Date.now()}`);
    const sourceSkillsDir = resolveRepoSkillsDir();
    const sourceSkillNames = await listSourceSkillNames(sourceSkillsDir);
    const prevHome = process.env.HOME;

    await Promise.all([
      mkdir(join(projectDir, '.claude/skills'), { recursive: true }),
      mkdir(join(projectDir, '.codex/skills'), { recursive: true }),
      mkdir(join(projectDir, '.gemini/skills'), { recursive: true }),
      mkdir(join(projectDir, '.kimi/skills'), { recursive: true }),
      mkdir(homeDir, { recursive: true }),
    ]);
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [{ id: 'debugging', type: 'skill', enabled: false, source: 'cat-cafe' }],
    });
    for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
      for (const skillName of sourceSkillNames) {
        if (skillName === 'debugging') continue;
        await symlink(join(sourceSkillsDir, skillName), join(projectDir, `.${provider}/skills`, skillName));
      }
    }
    process.env.HOME = homeDir;

    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/skills?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.summary.allMounted, true, 'disabled skill should not keep project health red');
      const debugging = body.skills.find((skill) => skill.name === 'debugging');
      assert.ok(debugging, 'debugging skill should still be listed');
      assert.deepEqual(debugging.mountHealth, {
        enabledMountPoints: ['claude', 'codex', 'gemini', 'kimi'],
        mountedCount: 0,
        requiredCount: 0,
        allMounted: true,
      });
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('GET /api/skills merges global disabled policy when external project has no local skill entry', async () => {
    const mainRoot = join('/tmp', `skills-route-test-global-disabled-main-${Date.now()}`);
    const projectDir = join('/tmp', `skills-route-test-global-disabled-external-${Date.now()}`);
    const homeDir = join('/tmp', `skills-route-test-global-disabled-home-${Date.now()}`);
    const prevHome = process.env.HOME;

    await Promise.all([mkdir(mainRoot, { recursive: true }), mkdir(projectDir, { recursive: true }), mkdir(homeDir)]);
    await writeCapabilitiesConfig(mainRoot, {
      version: 2,
      capabilities: [{ id: 'debugging', type: 'skill', enabled: false, source: 'cat-cafe', mountPaths: [] }],
    });
    await writeCapabilitiesConfig(projectDir, { version: 2, capabilities: [] });
    process.env.HOME = homeDir;

    const app = await buildSessionSkillsApp({ mainProjectRoot: mainRoot });
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/skills?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      const body = JSON.parse(res.body);
      const debugging = body.skills.find((skill) => skill.name === 'debugging');
      assert.ok(debugging, 'debugging skill should still be listed from source');
      assert.equal(debugging.globalEnabled, false, 'global disable should be visible in external skill summary');
      assert.deepEqual(debugging.mountPaths, [], 'global disabled policy should be inherited without a local row');
      assert.deepEqual(debugging.mountHealth, {
        enabledMountPoints: ['claude', 'codex', 'gemini', 'kimi'],
        mountedCount: 0,
        requiredCount: 0,
        allMounted: true,
      });
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await app.close();
      await rm(mainRoot, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('GET /api/skills treats non-empty mountPaths as project-enabled even when cap.enabled is stale false', async () => {
    const projectDir = join('/tmp', `skills-route-test-mountpaths-stale-enabled-${Date.now()}`);
    const homeDir = join('/tmp', `skills-route-test-mountpaths-stale-enabled-home-${Date.now()}`);
    const sourceSkillsDir = resolveRepoSkillsDir();
    const sourceSkillNames = await listSourceSkillNames(sourceSkillsDir);
    const prevHome = process.env.HOME;

    await Promise.all([
      mkdir(join(projectDir, '.claude/skills'), { recursive: true }),
      mkdir(join(projectDir, '.codex/skills'), { recursive: true }),
      mkdir(join(projectDir, '.gemini/skills'), { recursive: true }),
      mkdir(join(projectDir, '.kimi/skills'), { recursive: true }),
      mkdir(homeDir, { recursive: true }),
    ]);
    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: sourceSkillNames.map((id) => ({
        id,
        type: 'skill',
        enabled: false,
        source: 'cat-cafe',
        mountPaths: id === 'debugging' ? ['claude'] : [],
      })),
    });
    process.env.HOME = homeDir;

    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/skills?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.summary.allMounted, false, 'declared mountPaths without real symlink should be unhealthy');
      const debugging = body.skills.find((skill) => skill.name === 'debugging');
      assert.ok(debugging, 'debugging skill should still be listed');
      assert.deepEqual(debugging.mountPaths, ['claude']);
      assert.deepEqual(debugging.mountHealth, {
        enabledMountPoints: ['claude', 'codex', 'gemini', 'kimi'],
        mountedCount: 0,
        requiredCount: 1,
        allMounted: false,
      });
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('GET /api/skills ignores same-id plugin capabilities for Clowder AI source skill policy', async () => {
    const sourceSkillsDir = resolveRepoSkillsDir();
    const sourceSkillNames = await listSourceSkillNames(sourceSkillsDir);
    const skillName = sourceSkillNames[0];
    assert.ok(skillName, 'expected at least one source skill for same-id plugin policy regression');
    const mainRoot = join('/tmp', `skills-route-test-plugin-same-id-policy-main-${Date.now()}`);
    const projectDir = join('/tmp', `skills-route-test-plugin-same-id-policy-${Date.now()}`);
    const homeDir = join('/tmp', `skills-route-test-plugin-same-id-policy-home-${Date.now()}`);
    const prevHome = process.env.HOME;

    await Promise.all([
      mkdir(mainRoot, { recursive: true }),
      mkdir(projectDir, { recursive: true }),
      mkdir(homeDir, { recursive: true }),
    ]);
    await writeCapabilitiesConfig(mainRoot, {
      version: 2,
      capabilities: [
        {
          id: skillName,
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          mountPaths: ['claude', 'codex', 'gemini', 'kimi'],
        },
      ],
    });
    // Seed project config with a disabled same-id plugin entry.
    // The test verifies the plugin disable doesn't leak into the Clowder AI source skill.
    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [
        {
          id: skillName,
          type: 'skill',
          enabled: false,
          source: 'plugin',
          pluginId: 'same-id-plugin',
          mountPaths: [],
        },
      ],
    });
    process.env.HOME = homeDir;

    const app = Fastify();
    await app.register(skillsRoutes, { mainProjectRoot: mainRoot });
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/skills?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      const target = body.skills.find((skill) => skill.name === skillName && skill.source === 'cat-cafe');
      assert.ok(target, `${skillName} Clowder AI source skill should still be listed`);
      assert.equal(target.source, 'cat-cafe');
      assert.equal(target.globalEnabled, true, 'same-id plugin disable must not disable Clowder AI skill');
      assert.deepEqual(target.mountPaths, [], 'unmounted Clowder AI skill should report actual mounted providers');
      assert.deepEqual(target.mountHealth, {
        enabledMountPoints: ['claude', 'codex', 'gemini', 'kimi'],
        mountedCount: 0,
        requiredCount: 4,
        allMounted: false,
      });
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      await app.close();
      await rm(mainRoot, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('GET /api/skills resolves project-local plugin skillsSource against selected project', async () => {
    const rawProjectDir = join('/tmp', `skills-route-test-project-plugin-source-${Date.now()}`);
    await mkdir(rawProjectDir, { recursive: true });
    const projectDir = await realpath(rawProjectDir);
    const pluginId = 'test-project-local-source-plugin';
    const skillName = 'project-local-source-skill';
    const skillsSource = join(projectDir, 'plugins', pluginId, 'skills');
    const skillSourceDir = join(skillsSource, skillName);

    await mkdir(skillSourceDir, { recursive: true });
    await writeFile(join(skillSourceDir, 'SKILL.md'), '# Project Local Source Skill\n');
    for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
      const skillsDir = join(projectDir, `.${provider}`, 'skills');
      const linkPath = join(skillsDir, skillName);
      await mkdir(skillsDir, { recursive: true });
      await symlink(relative(dirname(linkPath), skillSourceDir), linkPath);
    }
    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [
        {
          id: skillName,
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          pluginId,
          skillsSource: relative(projectDir, skillsSource),
          mountPaths: ['claude', 'codex', 'gemini', 'kimi'],
        },
      ],
    });

    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/skills?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200, res.payload);
      const body = JSON.parse(res.body);
      const target = body.skills.find((skill) => skill.name === skillName);
      assert.ok(target, 'project-local plugin skill should be listed');
      assert.equal(target.pluginId, pluginId);
      assert.deepEqual(target.mounts, { claude: true, codex: true, gemini: true, kimi: true });
      assert.deepEqual(target.mountHealth, {
        enabledMountPoints: ['claude', 'codex', 'gemini', 'kimi'],
        mountedCount: 4,
        requiredCount: 4,
        allMounted: true,
      });
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('POST /api/skills/sync does not remount globally disabled cat-cafe skills', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const mainRoot = join('/tmp', `skills-route-test-disabled-skill-sync-main-${Date.now()}`);
    const projectDir = join('/tmp', `skills-route-test-disabled-skill-sync-${Date.now()}`);
    const sourceSkillsDir = resolveRepoSkillsDir();
    const staleDisabledLink = join(projectDir, '.claude/skills/debugging');
    await mkdir(mainRoot, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    await mkdir(join(projectDir, '.claude/skills'), { recursive: true });
    await symlink(join(sourceSkillsDir, 'debugging'), staleDisabledLink);
    await writeCapabilitiesConfig(mainRoot, {
      version: 2,
      capabilities: [{ id: 'debugging', type: 'skill', enabled: false, source: 'cat-cafe', mountPaths: [] }],
    });
    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [],
    });

    const app = await buildSessionSkillsApp({ mainProjectRoot: mainRoot });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/sync',
        headers: OWNER_SESSION_HEADERS,
        payload: { projectPath: projectDir },
      });

      assert.equal(res.statusCode, 200, res.payload);
      const body = JSON.parse(res.body);
      assert.equal(body.mounted.includes('debugging'), false, 'disabled skill must not be reported as mounted');
      await assert.rejects(() => lstat(staleDisabledLink), /ENOENT/, 'disabled skill must not remain mounted');
      const projectConfig = await readCapabilitiesConfig(projectDir);
      const disabledDebugging = projectConfig?.capabilities.find(
        (cap) => cap.type === 'skill' && cap.source === 'cat-cafe' && cap.id === 'debugging',
      );
      assert.ok(disabledDebugging, 'sync should persist globally disabled source skill policy');
      assert.equal(disabledDebugging.enabled, false);
      assert.deepEqual(disabledDebugging.mountPaths, []);
      assert.equal(
        (await lstat(join(projectDir, '.claude/skills/tdd'))).isSymbolicLink(),
        true,
        'enabled skills should still be mounted',
      );
    } finally {
      await app.close();
      await rm(mainRoot, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('skill sync routes inherit default mount rules from the remapped persistent root', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    const previousRuntimeRoot = process.env.CAT_CAFE_RUNTIME_ROOT;
    const previousWorkspaceRoot = process.env.CAT_CAFE_WORKSPACE_ROOT;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const runtimeRoot = await mkdtemp(join(tmpdir(), 'skills-route-runtime-defaults-'));
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'skills-route-workspace-defaults-'));
    process.env.CAT_CAFE_RUNTIME_ROOT = runtimeRoot;
    process.env.CAT_CAFE_WORKSPACE_ROOT = workspaceRoot;
    await writeCapabilitiesConfig(workspaceRoot, { version: 2, capabilities: [] });
    await writeDefaultMountRules(workspaceRoot, {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        claude: { enabled: true, path: '.persistent-claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    });
    const sourceSkillsDir = resolveRepoSkillsDir();
    const skillName = (await listSourceSkillNames(sourceSkillsDir))[0];
    assert.ok(skillName, 'expected at least one source skill');

    const app = await buildSessionSkillsApp({ mainProjectRoot: runtimeRoot });
    const projectRoots = [];
    try {
      const getRes = await app.inject({
        method: 'GET',
        url: `/api/skills?projectPath=${encodeURIComponent(workspaceRoot)}`,
        headers: AUTH_HEADERS,
      });
      assert.equal(getRes.statusCode, 200, getRes.payload);
      const listedSkill = JSON.parse(getRes.body).skills.find((skill) => skill.name === skillName);
      assert.deepEqual(
        listedSkill.mountHealth.enabledMountPoints,
        ['claude'],
        'GET /api/skills must read defaultMountRules from the persistent workspace',
      );

      for (const route of ['/api/skills/sync', '/api/skills/sync-skill']) {
        const projectRoot = await mkdtemp(join(tmpdir(), 'skills-route-persistent-default-project-'));
        projectRoots.push(projectRoot);
        const payload = route.endsWith('sync-skill')
          ? { projectPath: projectRoot, skillName }
          : { projectPath: projectRoot };
        const res = await app.inject({
          method: 'POST',
          url: route,
          headers: OWNER_SESSION_HEADERS,
          payload,
        });

        assert.equal(res.statusCode, 200, res.payload);
        assert.equal(
          (await lstat(join(projectRoot, '.persistent-claude/skills', skillName))).isSymbolicLink(),
          true,
          `${route} must read defaultMountRules from the persistent workspace`,
        );
        await assert.rejects(() => lstat(join(projectRoot, '.claude/skills', skillName)), /ENOENT/);
      }
    } finally {
      await app.close();
      await Promise.all(projectRoots.map((root) => rm(root, { recursive: true, force: true })));
      await rm(runtimeRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
      if (previousRuntimeRoot === undefined) delete process.env.CAT_CAFE_RUNTIME_ROOT;
      else process.env.CAT_CAFE_RUNTIME_ROOT = previousRuntimeRoot;
      if (previousWorkspaceRoot === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
      else process.env.CAT_CAFE_WORKSPACE_ROOT = previousWorkspaceRoot;
    }
  });

  it('POST /api/skills/sync clears project-local mountPaths:[] disable when global skill is enabled (F228 KD-6 Path A affirmative)', async () => {
    // Affirmative regression test for KD-6 unconditional cascade.
    //
    // Scenario: external project has skill X locally disabled (mountPaths:[]),
    // global state has skill X enabled. Per KD-6 (operator/mindfn IM sync 2026-06-17 +
    // F228 spec scenarios 6/7), ANY caller passing authoritative disabledSkills
    // must clear the local mountPaths:[] — including plain reconciliation paths
    // (POST /api/skills/sync, /api/skills/sync-skill, mount-rule edits), not just
    // explicit global toggle.
    //
    // This locks the behavior as test-enforced contract so future reviewers don't
    // re-raise the same P1 frame about "plain reconciliation re-enabling local disable"
    // (cloud codex 8 rounds on clowder-ai#962; @gpt52 砚砚 on cat-cafe#2391, both
    // withdrew after KD-6 design context).
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const mainRoot = join('/tmp', `skills-route-kd6-affirmative-main-${Date.now()}`);
    const projectDir = join('/tmp', `skills-route-kd6-affirmative-${Date.now()}`);
    await mkdir(mainRoot, { recursive: true });
    await mkdir(projectDir, { recursive: true });
    // global state: tdd enabled with default mount paths
    await writeCapabilitiesConfig(mainRoot, {
      version: 2,
      capabilities: [
        {
          id: 'tdd',
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          mountPaths: ['claude', 'codex', 'gemini', 'kimi'],
        },
      ],
    });
    // external project state: tdd locally disabled via mountPaths:[]
    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [
        {
          id: 'tdd',
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          mountPaths: [],
        },
      ],
    });

    const app = await buildSessionSkillsApp({ mainProjectRoot: mainRoot });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/sync',
        headers: OWNER_SESSION_HEADERS,
        payload: { projectPath: projectDir },
      });

      assert.equal(res.statusCode, 200, res.payload);

      // KD-6 Path A: plain sync clears local mountPaths:[] disable, mounts skill
      const projectConfig = await readCapabilitiesConfig(projectDir);
      const tdd = projectConfig?.capabilities.find(
        (cap) => cap.type === 'skill' && cap.source === 'cat-cafe' && cap.id === 'tdd',
      );
      assert.ok(tdd, 'tdd capability must be present in project config after sync');
      assert.ok(
        Array.isArray(tdd.mountPaths) && tdd.mountPaths.length > 0,
        `KD-6: local mountPaths:[] must be cleared on plain sync; got ${JSON.stringify(tdd.mountPaths)}`,
      );

      // Filesystem symlinks must exist for all default mount points
      for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
        const link = join(projectDir, `.${provider}/skills/tdd`);
        assert.equal(
          (await lstat(link)).isSymbolicLink(),
          true,
          `KD-6: ${provider} symlink must exist after unconditional cascade clears local disable`,
        );
      }
    } finally {
      await app.close();
      await rm(mainRoot, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('POST /api/skills/sync-skill rejects unknown skills before mounting', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const rawProjectDir = join('/tmp', `skills-route-test-sync-skill-unknown-${Date.now()}`);
    await mkdir(rawProjectDir, { recursive: true });
    const projectDir = await realpath(rawProjectDir);
    const sourceSkillsDir = resolveRepoSkillsDir();
    const unknownSkillName = `unknown-skill-${Date.now()}`;
    await assert.rejects(() => lstat(join(sourceSkillsDir, unknownSkillName)), /ENOENT/);
    await writeCapabilitiesConfig(projectDir, { version: 2, capabilities: [] });

    const app = await buildSessionSkillsApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/sync-skill',
        headers: OWNER_SESSION_HEADERS,
        payload: { projectPath: projectDir, skillName: unknownSkillName },
      });

      assert.equal(res.statusCode, 404, res.payload);
      assert.match(JSON.parse(res.body).error, /not found/i);
      for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
        await assert.rejects(
          () => lstat(join(projectDir, `.${provider}/skills`, unknownSkillName)),
          /ENOENT/,
          `${provider} must not receive a dangling symlink for an unknown skill`,
        );
      }
      const config = await readCapabilitiesConfig(projectDir);
      assert.equal(
        config?.capabilities.some((cap) => cap.type === 'skill' && cap.id === unknownSkillName),
        false,
        'unknown skill must not be persisted in capabilities.json',
      );
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('POST /api/skills/sync-skill ignores same-id disabled plugin skill in global guard', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const mainRoot = join('/tmp', `skills-route-test-sync-skill-plugin-same-id-main-${Date.now()}`);
    const rawProjectDir = join('/tmp', `skills-route-test-sync-skill-plugin-same-id-${Date.now()}`);
    await mkdir(mainRoot, { recursive: true });
    await mkdir(rawProjectDir, { recursive: true });
    const projectDir = await realpath(rawProjectDir);
    const sourceSkillsDir = resolveRepoSkillsDir();
    const sourceSkillNames = await listSourceSkillNames(sourceSkillsDir);
    const skillName = sourceSkillNames[0];
    assert.ok(skillName, 'expected at least one globally enabled source skill for sync-skill regression');
    await writeCapabilitiesConfig(mainRoot, {
      version: 2,
      capabilities: [
        {
          id: skillName,
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          mountPaths: ['claude', 'codex', 'gemini', 'kimi'],
        },
      ],
    });
    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [
        {
          id: skillName,
          type: 'skill',
          enabled: false,
          source: 'plugin',
          pluginId: 'same-id-plugin',
          mountPaths: [],
        },
      ],
    });

    const app = await buildSessionSkillsApp({ mainProjectRoot: mainRoot });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/sync-skill',
        headers: OWNER_SESSION_HEADERS,
        payload: { projectPath: projectDir, skillName },
      });

      assert.equal(res.statusCode, 200, res.payload);
      assert.equal((await lstat(join(projectDir, '.claude/skills', skillName))).isSymbolicLink(), true);
      const config = await readCapabilitiesConfig(projectDir);
      const pluginCap = config?.capabilities.find((cap) => cap.id === skillName && cap.source === 'plugin');
      assert.ok(pluginCap, 'same-id plugin skill capability should remain persisted');
      assert.equal(pluginCap.enabled, false);
    } finally {
      await app.close();
      await rm(mainRoot, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('POST /api/skills/sync-skill preserves narrowed mountPaths policy', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const mainRoot = join('/tmp', `skills-route-test-sync-skill-mountpaths-main-${Date.now()}`);
    const rawProjectDir = join('/tmp', `skills-route-test-sync-skill-mountpaths-${Date.now()}`);
    await mkdir(mainRoot, { recursive: true });
    await mkdir(rawProjectDir, { recursive: true });
    const projectDir = await realpath(rawProjectDir);
    const sourceSkillsDir = resolveRepoSkillsDir();
    const sourceSkillNames = await listSourceSkillNames(sourceSkillsDir);
    const skillName = sourceSkillNames[0];
    assert.ok(skillName, 'expected at least one globally enabled source skill for sync-skill regression');
    await writeCapabilitiesConfig(mainRoot, {
      version: 2,
      capabilities: [
        {
          id: skillName,
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          mountPaths: ['claude', 'codex', 'gemini', 'kimi'],
        },
      ],
    });
    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [
        {
          id: skillName,
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          mountPaths: ['claude'],
        },
      ],
    });

    const app = await buildSessionSkillsApp({ mainProjectRoot: mainRoot });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/sync-skill',
        headers: OWNER_SESSION_HEADERS,
        payload: { projectPath: projectDir, skillName },
      });

      assert.equal(res.statusCode, 200, res.payload);
      const body = JSON.parse(res.body);
      assert.deepEqual(body.mountPaths, ['claude']);
      assert.equal((await lstat(join(projectDir, '.claude/skills', skillName))).isSymbolicLink(), true);
      for (const provider of ['codex', 'gemini', 'kimi']) {
        await assert.rejects(
          () => lstat(join(projectDir, `.${provider}/skills`, skillName)),
          /ENOENT/,
          `${provider} must not be remounted outside the existing skill mountPaths`,
        );
      }
      const config = await readCapabilitiesConfig(projectDir);
      const cap = config?.capabilities.find(
        (entry) => entry.type === 'skill' && entry.id === skillName && entry.source === 'cat-cafe' && !entry.pluginId,
      );
      assert.deepEqual(cap?.mountPaths, ['claude']);
      assert.equal(cap?.enabled, true);
    } finally {
      await app.close();
      await rm(mainRoot, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('POST /api/skills/sync-skill caps mountPaths to enabled project providers', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const mainRoot = join('/tmp', `skills-route-test-sync-skill-enabled-cap-main-${Date.now()}`);
    const rawProjectDir = join('/tmp', `skills-route-test-sync-skill-enabled-cap-${Date.now()}`);
    await mkdir(mainRoot, { recursive: true });
    await mkdir(rawProjectDir, { recursive: true });
    const projectDir = await realpath(rawProjectDir);
    const skillName = 'debugging';
    await writeCapabilitiesConfig(mainRoot, {
      version: 2,
      capabilities: [
        {
          id: skillName,
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          mountPaths: ['claude', 'kimi'],
        },
      ],
    });
    await writeCapabilitiesConfig(projectDir, { version: 2, capabilities: [] });
    await writeMountRules(projectDir, {
      version: 1,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        kimi: { enabled: false, path: '.kimi/skills' },
      },
      customPaths: [],
    });

    const app = await buildSessionSkillsApp({ mainProjectRoot: mainRoot });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/sync-skill',
        headers: OWNER_SESSION_HEADERS,
        payload: { projectPath: projectDir, skillName },
      });

      assert.equal(res.statusCode, 200, res.payload);
      const body = JSON.parse(res.body);
      assert.deepEqual(body.mountPaths, ['claude']);
      assert.equal((await lstat(join(projectDir, '.claude/skills', skillName))).isSymbolicLink(), true);
      await assert.rejects(
        () => lstat(join(projectDir, '.kimi/skills', skillName)),
        /ENOENT/,
        'disabled provider must not be reported or persisted as mounted',
      );
      const config = await readCapabilitiesConfig(projectDir);
      const cap = config?.capabilities.find(
        (entry) => entry.type === 'skill' && entry.id === skillName && entry.source === 'cat-cafe' && !entry.pluginId,
      );
      assert.deepEqual(cap?.mountPaths, ['claude']);
      assert.equal(cap?.enabled, true);
    } finally {
      await app.close();
      await rm(mainRoot, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('POST /api/skills/sync-skill restores old provider links when a new target mount fails', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const mainRoot = join('/tmp', `skills-route-test-sync-skill-rollback-main-${Date.now()}`);
    const rawProjectDir = join('/tmp', `skills-route-test-sync-skill-rollback-${Date.now()}`);
    await mkdir(mainRoot, { recursive: true });
    await mkdir(rawProjectDir, { recursive: true });
    const projectDir = await realpath(rawProjectDir);
    const sourceSkillsDir = resolveRepoSkillsDir();
    const skillName = 'debugging';
    await writeCapabilitiesConfig(mainRoot, {
      version: 2,
      capabilities: [
        {
          id: skillName,
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          mountPaths: ['codex'],
        },
      ],
    });
    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [
        {
          id: skillName,
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          mountPaths: ['claude', 'codex'],
        },
      ],
    });
    const claudeLink = join(projectDir, '.claude/skills', skillName);
    const codexConflict = join(projectDir, '.codex/skills', skillName);
    await mkdir(dirname(claudeLink), { recursive: true });
    await mkdir(codexConflict, { recursive: true });
    await symlink(join(sourceSkillsDir, skillName), claudeLink);

    const app = await buildSessionSkillsApp({ mainProjectRoot: mainRoot });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/sync-skill',
        headers: OWNER_SESSION_HEADERS,
        payload: { projectPath: projectDir, skillName },
      });

      // Conflicts are skip+record — user data preserved, successful mounts work
      assert.equal(res.statusCode, 200, res.payload);
      assert.equal((await lstat(claudeLink)).isSymbolicLink(), true);
      assert.equal(resolve(dirname(claudeLink), await readlink(claudeLink)), join(sourceSkillsDir, skillName));
      assert.equal((await lstat(codexConflict)).isDirectory(), true, 'user-owned directory should be preserved');
      const body = JSON.parse(res.body);
      assert.ok(body.conflicts?.length > 0, 'conflicts should be reported');
      const config = await readCapabilitiesConfig(projectDir);
      const cap = config?.capabilities.find(
        (entry) => entry.type === 'skill' && entry.id === skillName && entry.source === 'cat-cafe' && !entry.pluginId,
      );
      assert.deepEqual(cap?.mountPaths, ['claude', 'codex']);
      assert.equal(cap?.enabled, true);
    } finally {
      await app.close();
      await rm(mainRoot, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('resolves required MCP status from the selected project capabilities config', async () => {
    const projectDir = join('/tmp', `skills-route-test-project-mcp-${Date.now()}`);
    await mkdir(projectDir, { recursive: true });
    await writeCapabilitiesConfig(projectDir, {
      version: 1,
      capabilities: [
        {
          id: 'pencil',
          type: 'mcp',
          enabled: false,
          source: 'external',
          mcpServer: { resolver: 'pencil', command: '', args: [] },
        },
      ],
    });

    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/skills?projectPath=${encodeURIComponent(projectDir)}`,
        headers: AUTH_HEADERS,
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      const pencilDesign = body.skills.find((skill) => skill.name === 'pencil-design');
      assert.ok(pencilDesign, 'pencil-design should be present');
      assert.deepEqual(pencilDesign.requiresMcp, [
        {
          id: 'pencil',
          status: 'missing',
        },
      ]);
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('exposes required MCP dependency status for routed skills', async () => {
    const app = Fastify();
    await app.register(skillsRoutes);
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: '/api/skills',
      headers: AUTH_HEADERS,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const browserAutomation = body.skills.find((skill) => skill.name === 'browser-automation');
    const pencilDesign = body.skills.find((skill) => skill.name === 'pencil-design');

    assert.ok(browserAutomation, 'browser-automation should be present in skills board');
    assert.ok(pencilDesign, 'pencil-design should be present in skills board');
    assert.deepEqual(
      browserAutomation.requiresMcp?.map((dep) => dep.id),
      ['playwright', 'claude-in-chrome', 'agent-browser', 'pinchtab'],
      'browser-automation should declare all browser backend dependencies',
    );
    assert.deepEqual(
      pencilDesign.requiresMcp?.map((dep) => dep.id),
      ['pencil'],
      'pencil-design should declare pencil dependency',
    );

    for (const dep of [...browserAutomation.requiresMcp, ...pencilDesign.requiresMcp]) {
      assert.match(dep.status, /^(ready|missing|unresolved)$/);
    }

    await app.close();
  });

  it('POST /api/skills/sync mounts enabled plugin skill and unmounts disabled plugin skill', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const rawProjectDir = join('/tmp', `skills-route-test-plugin-sync-${Date.now()}`);
    await mkdir(rawProjectDir, { recursive: true });
    // Canonicalize to avoid macOS /tmp → /private/tmp mismatch with route's realpath()
    const projectDir = await realpath(rawProjectDir);
    // pluginsDir must match the route's resolution: join(repoRoot, 'plugins')
    const repoRoot = resolveRepoSkillsDir().replace(/\/cat-cafe-skills$/, '');
    const pluginsDir = join(repoRoot, 'plugins');
    const pluginId = 'test-sync-plugin-regr';
    const skillName = 'test-plugin-skill';
    const disabledSkillName = 'test-disabled-plugin-skill';

    // Create plugin directory with two skills
    const skillSourceDir = join(pluginsDir, pluginId, 'skills', skillName);
    const disabledSkillSourceDir = join(pluginsDir, pluginId, 'skills', disabledSkillName);
    await mkdir(skillSourceDir, { recursive: true });
    await mkdir(disabledSkillSourceDir, { recursive: true });
    await writeFile(join(skillSourceDir, 'SKILL.md'), '# Test Plugin Skill\n');
    await writeFile(join(disabledSkillSourceDir, 'SKILL.md'), '# Disabled Plugin Skill\n');
    await writeFile(
      join(pluginsDir, pluginId, 'plugin.yaml'),
      [
        `id: ${pluginId}`,
        'name: Test Sync Plugin',
        'version: 1.0.0',
        'resources:',
        `  - type: skill`,
        `    path: skills/${skillName}`,
        `  - type: skill`,
        `    path: skills/${disabledSkillName}`,
      ].join('\n'),
    );

    // Set up capabilities with one enabled and one disabled plugin skill.
    // F228: plugin skills must include skillsSource — it's the sole architectural
    // discriminator between built-in and plugin skills.
    const pluginSkillsSource = join(pluginsDir, pluginId, 'skills');
    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [
        { id: skillName, type: 'skill', enabled: true, source: 'cat-cafe', pluginId, skillsSource: pluginSkillsSource },
        {
          id: disabledSkillName,
          type: 'skill',
          enabled: false,
          source: 'cat-cafe',
          pluginId,
          skillsSource: pluginSkillsSource,
        },
      ],
    });

    // Pre-mount the disabled skill to verify sync removes it
    const disabledMountDir = join(projectDir, '.claude/skills');
    await mkdir(disabledMountDir, { recursive: true });
    const disabledLinkPath = join(disabledMountDir, disabledSkillName);
    const disabledLinkTarget = relative(dirname(disabledLinkPath), disabledSkillSourceDir);
    await symlink(disabledLinkTarget, disabledLinkPath);

    const app = await buildSessionSkillsApp({ mainProjectRoot: projectDir });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/sync',
        headers: OWNER_SESSION_HEADERS,
        payload: { projectPath: projectDir },
      });

      assert.equal(res.statusCode, 200, res.payload);
      const body = JSON.parse(res.body);
      assert.ok(body.mounted.includes(skillName), 'enabled plugin skill should be reported as mounted');
      assert.ok(!body.mounted.includes(disabledSkillName), 'disabled plugin skill should not be in mounted list');

      // Enabled plugin skill should be symlinked
      const enabledLink = join(projectDir, '.claude/skills', skillName);
      assert.equal((await lstat(enabledLink)).isSymbolicLink(), true, 'enabled plugin skill should be mounted');
      const target = await readlink(enabledLink);
      assert.equal(
        resolve(dirname(enabledLink), target),
        resolve(skillSourceDir),
        'symlink should point to plugin skill source',
      );

      // Disabled plugin skill should be removed
      await assert.rejects(
        () => lstat(disabledLinkPath),
        /ENOENT/,
        'disabled plugin skill mount should be removed after sync',
      );
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(join(pluginsDir, pluginId), { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('POST /api/skills/sync mounts enabled project-local plugin skill', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const rawProjectDir = join('/tmp', `skills-route-test-project-plugin-sync-${Date.now()}`);
    await mkdir(rawProjectDir, { recursive: true });
    const projectDir = await realpath(rawProjectDir);
    const pluginsDir = join(projectDir, 'plugins');
    const pluginId = 'test-project-local-sync-plugin';
    const skillName = 'project-local-sync-skill';
    const skillSourceDir = join(pluginsDir, pluginId, 'skills', skillName);

    await mkdir(skillSourceDir, { recursive: true });
    await writeFile(join(skillSourceDir, 'SKILL.md'), '# Project Local Sync Skill\n');
    await writeFile(
      join(pluginsDir, pluginId, 'plugin.yaml'),
      [
        `id: ${pluginId}`,
        'name: Test Project Local Sync Plugin',
        'version: 1.0.0',
        'resources:',
        `  - type: skill`,
        `    path: skills/${skillName}`,
      ].join('\n'),
    );
    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [
        {
          id: skillName,
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          pluginId,
          skillsSource: join(pluginsDir, pluginId, 'skills'),
        },
      ],
    });

    const app = await buildSessionSkillsApp({ mainProjectRoot: projectDir });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/sync',
        headers: OWNER_SESSION_HEADERS,
        payload: { projectPath: projectDir },
      });

      assert.equal(res.statusCode, 200, res.payload);
      const body = JSON.parse(res.body);
      assert.ok(body.mounted.includes(skillName), 'project-local plugin skill should be reported as mounted');

      const enabledLink = join(projectDir, '.claude/skills', skillName);
      assert.equal((await lstat(enabledLink)).isSymbolicLink(), true, 'project-local plugin skill should mount');
      assert.equal(
        resolve(dirname(enabledLink), await readlink(enabledLink)),
        resolve(skillSourceDir),
        'symlink should point to project-local plugin skill source',
      );
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('POST /api/skills/sync converts legacy Clowder AI directory mounts before plugin sync', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const mainRoot = join('/tmp', `skills-route-test-plugin-sync-legacy-root-main-${Date.now()}`);
    const rawProjectDir = join('/tmp', `skills-route-test-plugin-sync-legacy-root-${Date.now()}`);
    await mkdir(mainRoot, { recursive: true });
    await mkdir(rawProjectDir, { recursive: true });
    const projectDir = await realpath(rawProjectDir);
    const sourceSkillsDir = resolveRepoSkillsDir();
    const repoRoot = dirname(sourceSkillsDir);
    const pluginsDir = join(repoRoot, 'plugins');
    const pluginId = 'test-sync-plugin-legacy-root-regr';
    const skillName = 'test-plugin-legacy-root-skill';
    const providerRoot = join(projectDir, '.claude', 'skills');
    const skillSourceDir = join(pluginsDir, pluginId, 'skills', skillName);

    await mkdir(join(projectDir, '.claude'), { recursive: true });
    await symlink(sourceSkillsDir, providerRoot);
    await mkdir(skillSourceDir, { recursive: true });
    await writeFile(join(skillSourceDir, 'SKILL.md'), '# Test Plugin Legacy Root Skill\n');
    await writeFile(
      join(pluginsDir, pluginId, 'plugin.yaml'),
      [
        `id: ${pluginId}`,
        'name: Test Sync Plugin Legacy Root',
        'version: 1.0.0',
        'resources:',
        `  - type: skill`,
        `    path: skills/${skillName}`,
      ].join('\n'),
    );
    const pluginSkillsSource = join(pluginsDir, pluginId, 'skills');
    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [
        { id: skillName, type: 'skill', enabled: true, source: 'cat-cafe', pluginId, skillsSource: pluginSkillsSource },
      ],
    });
    await writeCapabilitiesConfig(mainRoot, {
      version: 2,
      capabilities: [
        { id: 'debugging', type: 'skill', enabled: true, source: 'cat-cafe' },
        { id: skillName, type: 'skill', enabled: true, source: 'cat-cafe', pluginId, skillsSource: pluginSkillsSource },
      ],
    });

    const app = await buildSessionSkillsApp({ mainProjectRoot: mainRoot });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/sync',
        headers: OWNER_SESSION_HEADERS,
        payload: { projectPath: projectDir },
      });

      assert.equal(res.statusCode, 200, res.payload);
      const rootStat = await lstat(providerRoot);
      assert.equal(rootStat.isDirectory(), true, 'legacy Clowder AI root should become a real provider directory');
      assert.equal(rootStat.isSymbolicLink(), false, 'legacy Clowder AI directory symlink should be converted');

      const catCafeSkillLink = join(providerRoot, 'debugging');
      assert.equal((await lstat(catCafeSkillLink)).isSymbolicLink(), true, 'Clowder AI skills should remain mounted');
      assert.equal(
        resolve(dirname(catCafeSkillLink), await readlink(catCafeSkillLink)),
        resolve(sourceSkillsDir, 'debugging'),
      );

      const pluginLink = join(providerRoot, skillName);
      assert.equal((await lstat(pluginLink)).isSymbolicLink(), true, 'plugin skill should mount after conversion');
      assert.equal(resolve(dirname(pluginLink), await readlink(pluginLink)), resolve(skillSourceDir));
    } finally {
      await app.close();
      await rm(mainRoot, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
      await rm(join(pluginsDir, pluginId), { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('POST /api/skills/sync preserves plugin skill mountPaths policy', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const rawProjectDir = join('/tmp', `skills-route-test-plugin-sync-policy-${Date.now()}`);
    await mkdir(rawProjectDir, { recursive: true });
    const projectDir = await realpath(rawProjectDir);
    const repoRoot = resolveRepoSkillsDir().replace(/\/cat-cafe-skills$/, '');
    const pluginsDir = join(repoRoot, 'plugins');
    const pluginId = 'test-sync-plugin-policy-regr';
    const skillName = 'test-plugin-policy-skill';

    const skillSourceDir = join(pluginsDir, pluginId, 'skills', skillName);
    await mkdir(skillSourceDir, { recursive: true });
    await writeFile(join(skillSourceDir, 'SKILL.md'), '# Test Plugin Policy Skill\n');
    await writeFile(
      join(pluginsDir, pluginId, 'plugin.yaml'),
      [
        `id: ${pluginId}`,
        'name: Test Sync Plugin Policy',
        'version: 1.0.0',
        'resources:',
        `  - type: skill`,
        `    path: skills/${skillName}`,
      ].join('\n'),
    );

    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [
        {
          id: skillName,
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          pluginId,
          mountPaths: ['claude'],
          skillsSource: join(pluginsDir, pluginId, 'skills'),
        },
      ],
    });
    for (const provider of ['codex', 'gemini', 'kimi']) {
      const staleDir = join(projectDir, `.${provider}/skills`);
      const staleLink = join(staleDir, skillName);
      await mkdir(staleDir, { recursive: true });
      await symlink(relative(dirname(staleLink), skillSourceDir), staleLink);
    }

    const app = await buildSessionSkillsApp({ mainProjectRoot: projectDir });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/sync',
        headers: OWNER_SESSION_HEADERS,
        payload: { projectPath: projectDir },
      });

      assert.equal(res.statusCode, 200, res.payload);
      const claudeLink = join(projectDir, '.claude/skills', skillName);
      assert.equal((await lstat(claudeLink)).isSymbolicLink(), true, 'allowed plugin provider should be mounted');
      assert.equal(resolve(dirname(claudeLink), await readlink(claudeLink)), resolve(skillSourceDir));

      for (const provider of ['codex', 'gemini', 'kimi']) {
        await assert.rejects(
          () => lstat(join(projectDir, `.${provider}/skills`, skillName)),
          /ENOENT/,
          `${provider} must not be remounted outside plugin mountPaths`,
        );
      }
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(join(pluginsDir, pluginId), { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });

  it('POST /api/skills/sync preserves empty plugin skill mountPaths policy', async () => {
    const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = 'you';
    const rawProjectDir = join('/tmp', `skills-route-test-plugin-sync-empty-policy-${Date.now()}`);
    await mkdir(rawProjectDir, { recursive: true });
    const projectDir = await realpath(rawProjectDir);
    const repoRoot = resolveRepoSkillsDir().replace(/\/cat-cafe-skills$/, '');
    const pluginsDir = join(repoRoot, 'plugins');
    const pluginId = 'test-sync-plugin-empty-policy-regr';
    const skillName = 'test-plugin-empty-policy-skill';

    const skillSourceDir = join(pluginsDir, pluginId, 'skills', skillName);
    await mkdir(skillSourceDir, { recursive: true });
    await writeFile(join(skillSourceDir, 'SKILL.md'), '# Test Plugin Empty Policy Skill\n');
    await writeFile(
      join(pluginsDir, pluginId, 'plugin.yaml'),
      [
        `id: ${pluginId}`,
        'name: Test Sync Plugin Empty Policy',
        'version: 1.0.0',
        'resources:',
        `  - type: skill`,
        `    path: skills/${skillName}`,
      ].join('\n'),
    );

    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [
        {
          id: skillName,
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          pluginId,
          mountPaths: [],
          skillsSource: join(pluginsDir, pluginId, 'skills'),
        },
      ],
    });
    for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
      const staleDir = join(projectDir, `.${provider}/skills`);
      const staleLink = join(staleDir, skillName);
      await mkdir(staleDir, { recursive: true });
      await symlink(relative(dirname(staleLink), skillSourceDir), staleLink);
    }

    const app = await buildSessionSkillsApp({ mainProjectRoot: projectDir });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/sync',
        headers: OWNER_SESSION_HEADERS,
        payload: { projectPath: projectDir },
      });

      assert.equal(res.statusCode, 200, res.payload);
      const body = JSON.parse(res.body);
      assert.equal(body.mounted.includes(skillName), false, 'empty plugin mount policy should not mount the skill');

      for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
        await assert.rejects(
          () => lstat(join(projectDir, `.${provider}/skills`, skillName)),
          /ENOENT/,
          `${provider} must not be mounted when plugin mountPaths is empty`,
        );
      }
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(join(pluginsDir, pluginId), { recursive: true, force: true });
      if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
    }
  });
});
