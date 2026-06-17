import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MOUNT_RULES } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { writeCapabilitiesConfig } from '../dist/config/capabilities/capability-orchestrator.js';
import { fillDefaultMountPaths, readCatCafeSkillMountPolicy, skillsDriftRoutes } from '../dist/routes/skills-drift.js';

const OWNER_ID = 'owner-user';
const LOCAL_WRITE_HEADERS = {
  'x-test-session-user': OWNER_ID,
  origin: 'http://localhost:3003',
  host: 'localhost:3003',
};

async function buildSkillsDriftApp(opts = {}) {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    const sessionUser = request.headers['x-test-session-user'];
    if (typeof sessionUser === 'string' && sessionUser.trim()) {
      request.sessionUserId = sessionUser.trim();
    }
  });
  await app.register(skillsDriftRoutes, opts);
  await app.ready();
  return app;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function resolveRepoSkillsDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..', 'cat-cafe-skills');
}

function expectedSymlinkTarget(linkPath, sourcePath) {
  return process.platform === 'win32' ? sourcePath : relative(dirname(linkPath), sourcePath);
}

describe('Skills Drift Route (F228)', () => {
  it('POST /api/skills/drift-check respects per-skill mountPaths provider exclusions', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'skills-drift-route-mount-paths-'));
    const canonicalProjectDir = await realpath(projectDir);
    const skillsSource = resolveRepoSkillsDir();
    const skillName = 'debugging';
    const claudeLink = join(canonicalProjectDir, '.claude/skills', skillName);
    await writeCapabilitiesConfig(canonicalProjectDir, {
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
    await mkdir(dirname(claudeLink), { recursive: true });
    await symlink(expectedSymlinkTarget(claudeLink, join(skillsSource, skillName)), claudeLink);

    const app = await buildSkillsDriftApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/drift-check',
        headers: { 'x-cat-cafe-user': 'default-user' },
        payload: { projectPath: projectDir },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(
        body.result.issues.some((issue) => issue.skill === skillName),
        false,
        'providers excluded by mountPaths should not count as missing mounts',
      );
    } finally {
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('POST /api/skills/drift-check respects global disabled skill policy for external projects', async () => {
    const mainRoot = await mkdtemp(join(tmpdir(), 'skills-drift-route-global-disabled-main-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'skills-drift-route-global-disabled-'));
    await writeCapabilitiesConfig(mainRoot, {
      version: 2,
      capabilities: [{ id: 'debugging', type: 'skill', enabled: false, source: 'cat-cafe', mountPaths: [] }],
    });
    await writeCapabilitiesConfig(projectDir, { version: 2, capabilities: [] });

    const app = await buildSkillsDriftApp({ mainProjectRoot: mainRoot });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/drift-check',
        headers: { 'x-cat-cafe-user': 'default-user' },
        payload: { projectPath: projectDir },
      });

      assert.equal(res.statusCode, 200);
      const body = JSON.parse(res.body);
      assert.equal(
        body.result.issues.some((issue) => issue.skill === 'debugging'),
        false,
        'globally disabled skill must not be reported as mountable drift',
      );
    } finally {
      await app.close();
      await rm(mainRoot, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('POST /api/skills/drift-resolve does not remount globally disabled skills for external projects', async () => {
    const prevOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    const mainRoot = await mkdtemp(join(tmpdir(), 'skills-drift-route-global-disabled-sync-main-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'skills-drift-route-global-disabled-sync-'));
    await writeCapabilitiesConfig(mainRoot, {
      version: 2,
      capabilities: [{ id: 'debugging', type: 'skill', enabled: false, source: 'cat-cafe', mountPaths: [] }],
    });
    await writeCapabilitiesConfig(projectDir, { version: 2, capabilities: [] });

    const app = await buildSkillsDriftApp({ mainProjectRoot: mainRoot });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/drift-resolve',
        headers: LOCAL_WRITE_HEADERS,
        payload: { projectPath: projectDir, action: 'sync' },
      });

      assert.equal(res.statusCode, 200, res.body);
      assert.equal(
        await exists(join(projectDir, '.claude/skills/debugging')),
        false,
        'globally disabled skill must not be mounted by drift sync',
      );
    } finally {
      if (prevOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prevOwner;
      await app.close();
      await rm(mainRoot, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('POST /api/skills/drift-resolve accepts local owner sync requests', async () => {
    const prevOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    const projectDir = await mkdtemp(join(tmpdir(), 'skills-drift-route-local-origin-'));

    const app = await buildSkillsDriftApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/drift-resolve',
        headers: LOCAL_WRITE_HEADERS,
        payload: { projectPath: projectDir, action: 'sync' },
      });

      assert.equal(res.statusCode, 200);
    } finally {
      if (prevOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prevOwner;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('POST /api/skills/drift-resolve accepts local single-user sync requests when no owner is configured', async () => {
    const prevOwner = process.env.DEFAULT_OWNER_USER_ID;
    delete process.env.DEFAULT_OWNER_USER_ID;
    const projectDir = await mkdtemp(join(tmpdir(), 'skills-drift-route-single-user-'));

    const app = await buildSkillsDriftApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/drift-resolve',
        headers: {
          'x-test-session-user': 'single-user',
          origin: 'http://localhost:3003',
          host: 'localhost:3003',
        },
        payload: { projectPath: projectDir, action: 'sync' },
      });

      assert.equal(res.statusCode, 200);
    } finally {
      if (prevOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prevOwner;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('POST /api/skills/drift-resolve rejects owner writes from non-local browser origins', async () => {
    const prevOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    const projectDir = await mkdtemp(join(tmpdir(), 'skills-drift-route-remote-origin-'));

    const app = await buildSkillsDriftApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/drift-resolve',
        headers: {
          'x-test-session-user': OWNER_ID,
          origin: 'https://cafe.example.com',
          host: 'localhost:3003',
        },
        payload: { projectPath: projectDir, action: 'sync' },
      });

      assert.equal(res.statusCode, 403);
    } finally {
      if (prevOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prevOwner;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});

// ── P1-3 regression: fillDefaultMountPaths fills defaults for enabled skills without mountPaths ──

describe('fillDefaultMountPaths (P1-3 regression)', () => {
  it('adds default mount paths for configured+enabled skills without explicit mountPaths', () => {
    const policy = readCatCafeSkillMountPolicy({
      version: 2,
      capabilities: [
        { type: 'skill', source: 'cat-cafe', id: 'tdd', enabled: true },
        { type: 'skill', source: 'cat-cafe', id: 'debugging', enabled: true, mountPaths: ['claude'] },
        { type: 'skill', source: 'cat-cafe', id: 'disabled-skill', enabled: false },
      ],
    });

    // Before fill: tdd has no mountPaths, debugging has explicit, disabled-skill is disabled
    assert.equal(policy.skillMountPaths['tdd'], undefined);
    assert.deepEqual(policy.skillMountPaths['debugging'], ['claude']);

    fillDefaultMountPaths(policy, DEFAULT_MOUNT_RULES);

    // After fill: tdd should have all enabled providers as defaults
    assert.ok(Array.isArray(policy.skillMountPaths['tdd']), 'tdd should have default mount paths');
    assert.ok(policy.skillMountPaths['tdd'].includes('claude'), 'tdd defaults should include claude');
    assert.ok(policy.skillMountPaths['tdd'].includes('codex'), 'tdd defaults should include codex');
    // debugging keeps its explicit mount paths
    assert.deepEqual(policy.skillMountPaths['debugging'], ['claude']);
    // disabled-skill should NOT get defaults
    assert.equal(policy.skillMountPaths['disabled-skill'], undefined);
  });

  it('does not overwrite existing mountPaths', () => {
    const policy = readCatCafeSkillMountPolicy({
      version: 2,
      capabilities: [{ type: 'skill', source: 'cat-cafe', id: 'tdd', enabled: true, mountPaths: ['gemini'] }],
    });

    fillDefaultMountPaths(policy, DEFAULT_MOUNT_RULES);
    assert.deepEqual(policy.skillMountPaths['tdd'], ['gemini']);
  });
});
