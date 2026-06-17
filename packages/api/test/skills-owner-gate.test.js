/**
 * Skills write-route owner gate tests (AC-E4)
 * POST /api/skills/sync must require DEFAULT_OWNER_USER_ID match (fail-closed).
 */

import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_MOUNT_RULES } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { writeCapabilitiesConfig } from '../dist/config/capabilities/capability-orchestrator.js';
import { writeMountRules } from '../dist/config/mount/mount-rules-store.js';
import { skillsRoutes } from '../dist/routes/skills.js';
import { skillsWriteRoutes } from '../dist/routes/skills-write.js';

const OWNER_ID = 'owner-user';
const NON_OWNER_ID = 'random-visitor';
const LOCAL_WRITE_HEADERS = {
  'x-test-session-user': OWNER_ID,
  origin: 'http://localhost:3003',
  host: 'localhost:3003',
};

async function buildSkillsApp(opts = {}) {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    const sessionUser = request.headers['x-test-session-user'];
    if (typeof sessionUser === 'string' && sessionUser.trim()) {
      request.sessionUserId = sessionUser.trim();
    }
  });
  await app.register(skillsRoutes);
  await app.register(skillsWriteRoutes, opts);
  await app.ready();
  return app;
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
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
        headers: { ...LOCAL_WRITE_HEADERS, 'x-test-session-user': NON_OWNER_ID },
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

  it('POST /api/skills/sync allows access in single-user mode when DEFAULT_OWNER_USER_ID is unset (issue #794)', async () => {
    const prev = process.env.DEFAULT_OWNER_USER_ID;
    delete process.env.DEFAULT_OWNER_USER_ID;

    const app = await buildSkillsApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/sync',
        headers: { ...LOCAL_WRITE_HEADERS, 'x-test-session-user': 'any-user' },
        payload: {},
      });

      assert.notEqual(res.statusCode, 403, 'should not 403 in single-user mode');
    } finally {
      if (prev === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prev;
      await app.close();
    }
  });

  it('POST /api/skills/sync rejects owner writes from non-local browser origins before syncing', async () => {
    const prev = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    const projectDir = await mkdtemp(join(tmpdir(), 'skills-sync-route-remote-origin-'));

    const app = await buildSkillsApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/sync',
        headers: {
          'x-test-session-user': OWNER_ID,
          origin: 'https://cafe.example.com',
          host: 'localhost:3003',
        },
        payload: { projectPath: projectDir },
      });

      assert.equal(res.statusCode, 403);
      assert.equal(await pathExists(join(projectDir, '.claude/skills')), false, 'remote write must not sync skills');
    } finally {
      if (prev === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prev;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('POST /api/skills/sync-skill rejects owner writes from non-local browser origins before mounting', async () => {
    const prev = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    const mainRoot = await mkdtemp(join(tmpdir(), 'skills-sync-skill-remote-origin-main-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'skills-sync-skill-remote-origin-'));
    await writeCapabilitiesConfig(mainRoot, {
      version: 2,
      capabilities: [{ id: 'debugging', type: 'skill', enabled: true, source: 'cat-cafe' }],
    });

    const app = await buildSkillsApp({ mainProjectRoot: mainRoot });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/sync-skill',
        headers: {
          'x-test-session-user': OWNER_ID,
          origin: 'https://cafe.example.com',
          host: 'localhost:3003',
        },
        payload: { projectPath: projectDir, skillName: 'debugging' },
      });

      assert.equal(res.statusCode, 403);
      assert.equal(
        await pathExists(join(projectDir, '.claude/skills/debugging')),
        false,
        'remote write must not mount the requested skill',
      );
    } finally {
      if (prev === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prev;
      await app.close();
      await rm(mainRoot, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
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
        headers: {
          origin: LOCAL_WRITE_HEADERS.origin,
          host: LOCAL_WRITE_HEADERS.host,
          'x-cat-cafe-user': OWNER_ID,
        },
        payload: {},
      });
      assert.equal(res.statusCode, 401, 'header-only identity should be rejected');
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
        headers: LOCAL_WRITE_HEADERS,
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

  it('POST /api/skills/sync honors selected project mount rules', async () => {
    const prev = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    const projectDir = await mkdtemp(join(tmpdir(), 'skills-sync-route-rules-'));
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };
    await writeMountRules(projectDir, rules);

    const app = await buildSkillsApp();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/sync',
        headers: LOCAL_WRITE_HEADERS,
        payload: { projectPath: projectDir },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(await pathExists(join(projectDir, '.claude/skills')), true, 'enabled provider should be synced');
      assert.equal(await pathExists(join(projectDir, '.kimi/skills')), false, 'disabled provider must not be synced');
    } finally {
      if (prev === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prev;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('POST /api/skills/sync mounts configured custom paths', async () => {
    const prev = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    const mainRoot = await mkdtemp(join(tmpdir(), 'skills-sync-custom-paths-main-'));
    const projectDir = await mkdtemp(join(tmpdir(), 'skills-sync-route-custom-paths-'));
    const customDir = join('custom-client', 'skills');
    const customDirPath = join(projectDir, customDir);
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: Object.fromEntries(
        Object.entries(DEFAULT_MOUNT_RULES.mountPoints).map(([id, provider]) => [id, { ...provider, enabled: false }]),
      ),
      customPaths: [{ alias: 'acp', path: customDir }],
    };
    await writeMountRules(projectDir, rules);
    // Global config: debugging enabled without per-skill mountPaths restriction
    await writeCapabilitiesConfig(mainRoot, {
      version: 2,
      capabilities: [{ id: 'debugging', type: 'skill', enabled: true, source: 'cat-cafe' }],
    });

    const app = await buildSkillsApp({ mainProjectRoot: mainRoot });
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/skills/sync',
        headers: LOCAL_WRITE_HEADERS,
        payload: { projectPath: projectDir },
      });

      assert.equal(res.statusCode, 200, res.body);
      assert.equal(
        await pathExists(join(customDirPath, 'debugging')),
        true,
        'custom mount path should receive managed skill symlinks during sync',
      );
    } finally {
      if (prev === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prev;
      await app.close();
      await rm(mainRoot, { recursive: true, force: true });
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
