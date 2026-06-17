import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { DEFAULT_MOUNT_RULES } from '@cat-cafe/shared';
import Fastify from 'fastify';
import {
  readCapabilitiesConfig,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from '../dist/config/capabilities/capability-orchestrator.js';
import { readMountRules, writeDefaultMountRules, writeMountRules } from '../dist/config/mount/mount-rules-store.js';
import { mountRulesRoutes } from '../dist/routes/mount-rules.js';
import { mountSkillSymlinks } from '../dist/skills/skill-manage.js';
import { syncAll } from '../dist/skills/skill-sync-all.js';
import { syncProject } from '../dist/skills/skill-sync-engine.js';
import { resolveCatCafeSkillsSource } from '../dist/utils/skill-source.js';

function resolveRepoRoot() {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim();
}

const OWNER_ID = 'owner-user';
const LOCAL_WRITE_HEADERS = {
  'x-test-session-user': OWNER_ID,
  origin: 'http://localhost:3003',
  host: 'localhost:3003',
};

async function buildMountRulesApp(opts = {}) {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    const sessionUser = request.headers['x-test-session-user'];
    if (typeof sessionUser === 'string' && sessionUser.trim()) {
      request.sessionUserId = sessionUser.trim();
    }
  });
  await app.register(mountRulesRoutes, opts);
  await app.ready();
  return app;
}

async function exists(p) {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveRepoSkillsDir() {
  return resolveCatCafeSkillsSource();
}

function expectedSymlinkTarget(linkPath, sourcePath) {
  return process.platform === 'win32' ? sourcePath : relative(dirname(linkPath), sourcePath);
}

describe('Mount Rules Route (F228)', () => {
  it('PUT /api/mount-rules waits for capability lock before writing project rules', async () => {
    const prevOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    const projectDir = await mkdtemp(join(tmpdir(), 'mount-rules-route-lock-'));
    const canonicalProjectDir = await realpath(projectDir);
    const previousRules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        claude: { enabled: true, path: '.old-claude/skills' },
      },
    };
    const nextRules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        claude: { enabled: true, path: '.new-claude/skills' },
      },
    };
    await writeMountRules(canonicalProjectDir, previousRules);

    const app = await buildMountRulesApp({ mainProjectRoot: canonicalProjectDir });
    let releaseLock = () => {};
    let enteredLock = () => {};
    const releasePromise = new Promise((resolve) => {
      releaseLock = resolve;
    });
    const enteredPromise = new Promise((resolve) => {
      enteredLock = resolve;
    });
    const lockPromise = withCapabilityLock(canonicalProjectDir, async () => {
      enteredLock();
      await releasePromise;
    });

    await enteredPromise;
    const putPromise = app.inject({
      method: 'PUT',
      url: '/api/mount-rules',
      headers: LOCAL_WRITE_HEADERS,
      payload: { projectPath: projectDir, rules: nextRules },
    });

    try {
      await sleep(50);
      const duringLock = await readMountRules(canonicalProjectDir, canonicalProjectDir);
      assert.equal(
        duringLock.mountPoints.claude.path,
        '.old-claude/skills',
        'route must not write mount rules while capability lock is held',
      );

      releaseLock();
      const res = await putPromise;
      await lockPromise;
      assert.equal(res.statusCode, 200);
      const after = await readMountRules(canonicalProjectDir, canonicalProjectDir);
      assert.equal(after.mountPoints.claude.path, '.new-claude/skills');
    } finally {
      releaseLock();
      await Promise.allSettled([lockPromise, putPromise]);
      if (prevOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prevOwner;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('PUT /api/mount-rules reconciles existing skill symlinks before returning', async () => {
    const prevOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    const projectDir = await mkdtemp(join(tmpdir(), 'mount-rules-route-project-'));
    const canonicalProjectDir = await realpath(projectDir);
    const skillsSource = await resolveRepoSkillsDir();
    const skillName = 'debugging';
    const oldClaudeLink = join(canonicalProjectDir, '.claude/skills', skillName);
    const oldCodexLink = join(canonicalProjectDir, '.codex/skills', skillName);
    const newClaudeLink = join(canonicalProjectDir, '.project-claude/skills', skillName);
    const oldClaudeTarget = expectedSymlinkTarget(oldClaudeLink, join(skillsSource, skillName));
    const oldCodexTarget = expectedSymlinkTarget(oldCodexLink, join(skillsSource, skillName));
    const newClaudeTarget = expectedSymlinkTarget(newClaudeLink, join(skillsSource, skillName));
    const newRules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        claude: { enabled: true, path: '.project-claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };

    await Promise.all([
      mkdir(dirname(oldClaudeLink), { recursive: true }),
      mkdir(dirname(oldCodexLink), { recursive: true }),
    ]);
    await Promise.all([symlink(oldClaudeTarget, oldClaudeLink), symlink(oldCodexTarget, oldCodexLink)]);

    const app = await buildMountRulesApp({ mainProjectRoot: canonicalProjectDir });
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/mount-rules',
        headers: LOCAL_WRITE_HEADERS,
        payload: { projectPath: projectDir, rules: newRules },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(await exists(oldClaudeLink), false, 'old customized-away provider path should be cleaned');
      assert.equal(await exists(oldCodexLink), false, 'disabled provider path should be cleaned');
      assert.equal(
        resolve(dirname(newClaudeLink), await readlink(newClaudeLink)),
        resolve(dirname(newClaudeLink), newClaudeTarget),
        'new enabled provider path should be mounted',
      );
    } finally {
      if (prevOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prevOwner;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('PUT /api/mount-rules preserves same-name user symlinks when reconciling rules', async () => {
    const prevOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    const projectDir = await mkdtemp(join(tmpdir(), 'mount-rules-route-user-link-'));
    const canonicalProjectDir = await realpath(projectDir);
    const skillsSource = await resolveRepoSkillsDir();
    const skillName = 'debugging';
    const userSource = join(canonicalProjectDir, 'user-skills');
    const oldClaudeLink = join(canonicalProjectDir, '.claude/skills', skillName);
    const newClaudeLink = join(canonicalProjectDir, '.project-claude/skills', skillName);
    const userTarget = expectedSymlinkTarget(oldClaudeLink, join(userSource, skillName));
    const newClaudeTarget = expectedSymlinkTarget(newClaudeLink, join(skillsSource, skillName));
    const newRules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        claude: { enabled: true, path: '.project-claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };

    await Promise.all([
      mkdir(dirname(oldClaudeLink), { recursive: true }),
      mkdir(join(userSource, skillName), { recursive: true }),
    ]);
    await symlink(userTarget, oldClaudeLink);

    const app = await buildMountRulesApp({ mainProjectRoot: canonicalProjectDir });
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/mount-rules',
        headers: LOCAL_WRITE_HEADERS,
        payload: { projectPath: projectDir, rules: newRules },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(await readlink(oldClaudeLink), userTarget, 'user-owned old-path symlink should be preserved');
      assert.equal(
        resolve(dirname(newClaudeLink), await readlink(newClaudeLink)),
        resolve(dirname(newClaudeLink), newClaudeTarget),
        'new enabled provider path should still receive the managed mount',
      );
    } finally {
      if (prevOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prevOwner;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('PUT /api/mount-rules removes legacy directory-level provider symlinks', async () => {
    const prevOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    const projectDir = await mkdtemp(join(tmpdir(), 'mount-rules-route-legacy-root-'));
    const canonicalProjectDir = await realpath(projectDir);
    const skillsSource = await resolveRepoSkillsDir();
    const skillName = 'debugging';
    const oldClaudeRoot = join(canonicalProjectDir, '.claude/skills');
    const newClaudeLink = join(canonicalProjectDir, '.project-claude/skills', skillName);
    const oldClaudeTarget = expectedSymlinkTarget(oldClaudeRoot, skillsSource);
    const newClaudeTarget = expectedSymlinkTarget(newClaudeLink, join(skillsSource, skillName));
    const newRules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        claude: { enabled: true, path: '.project-claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };

    await mkdir(dirname(oldClaudeRoot), { recursive: true });
    await symlink(oldClaudeTarget, oldClaudeRoot);

    const app = await buildMountRulesApp({ mainProjectRoot: canonicalProjectDir });
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/mount-rules',
        headers: LOCAL_WRITE_HEADERS,
        payload: { projectPath: projectDir, rules: newRules },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(await exists(oldClaudeRoot), false, 'legacy provider root symlink should be removed');
      assert.equal(
        resolve(dirname(newClaudeLink), await readlink(newClaudeLink)),
        resolve(dirname(newClaudeLink), newClaudeTarget),
        'new enabled provider path should receive per-skill mount',
      );
    } finally {
      if (prevOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prevOwner;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('PUT /api/mount-rules reconciles custom skill mount paths', async () => {
    const prevOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    const projectDir = await mkdtemp(join(tmpdir(), 'mount-rules-route-custom-path-'));
    const canonicalProjectDir = await realpath(projectDir);
    const skillsSource = await resolveRepoSkillsDir();
    const skillName = 'debugging';
    const oldCustomPath = 'old-custom-skills';
    const nextCustomPath = 'next-custom-skills';
    const oldCustomDir = join(canonicalProjectDir, oldCustomPath);
    const nextCustomDir = join(canonicalProjectDir, nextCustomPath);
    const oldCustomLink = join(oldCustomDir, skillName);
    const nextCustomLink = join(nextCustomDir, skillName);
    const oldCustomTarget = expectedSymlinkTarget(oldCustomLink, join(skillsSource, skillName));
    const nextCustomTarget = expectedSymlinkTarget(nextCustomLink, join(skillsSource, skillName));
    const previousRules = {
      version: 1,
      mountPoints: {
        claude: { enabled: false, path: '.claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
      customPaths: [{ alias: 'old-acp', path: oldCustomPath }],
    };
    const nextRules = {
      ...previousRules,
      customPaths: [{ alias: 'next-acp', path: nextCustomPath }],
    };

    await writeMountRules(canonicalProjectDir, previousRules);
    await mkdir(oldCustomDir, { recursive: true });
    await symlink(oldCustomTarget, oldCustomLink);

    const app = await buildMountRulesApp({ mainProjectRoot: canonicalProjectDir });
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/mount-rules',
        headers: LOCAL_WRITE_HEADERS,
        payload: { projectPath: projectDir, rules: nextRules },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(await exists(oldCustomLink), false, 'old custom managed link should be cleaned');
      assert.equal(
        resolve(dirname(nextCustomLink), await readlink(nextCustomLink)),
        resolve(dirname(nextCustomLink), nextCustomTarget),
        'new custom path should receive the managed skill mount',
      );
    } finally {
      if (prevOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prevOwner;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('PUT /api/mount-rules accepts project-relative custom skill mount paths', async () => {
    const prevOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    const projectDir = await mkdtemp(join(tmpdir(), 'mount-rules-route-relative-custom-'));
    const canonicalProjectDir = await realpath(projectDir);
    const skillsSource = await resolveRepoSkillsDir();
    const skillName = 'debugging';
    const relativeCustomDir = '.opencode/skills';
    const nextCustomDir = join(canonicalProjectDir, relativeCustomDir);
    const nextCustomLink = join(nextCustomDir, skillName);
    const nextCustomTarget = expectedSymlinkTarget(nextCustomLink, join(skillsSource, skillName));
    const nextRules = {
      version: 1,
      mountPoints: {
        claude: { enabled: false, path: '.claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
      customPaths: [{ alias: 'opencode', path: relativeCustomDir }],
    };

    const app = await buildMountRulesApp({ mainProjectRoot: canonicalProjectDir });
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/mount-rules',
        headers: LOCAL_WRITE_HEADERS,
        payload: { projectPath: projectDir, rules: nextRules },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(
        resolve(dirname(nextCustomLink), await readlink(nextCustomLink)),
        resolve(dirname(nextCustomLink), nextCustomTarget),
        'project-relative custom path should mount under the selected project root',
      );
    } finally {
      if (prevOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prevOwner;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('PUT /api/mount-rules preserves per-skill mountPaths during reconciliation', async () => {
    const prevOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    const projectDir = await mkdtemp(join(tmpdir(), 'mount-rules-route-mount-paths-'));
    const canonicalProjectDir = await realpath(projectDir);
    const skillsSource = await resolveRepoSkillsDir();
    const skillName = 'debugging';
    const claudeLink = join(canonicalProjectDir, '.claude/skills', skillName);
    const codexLink = join(canonicalProjectDir, '.codex/skills', skillName);
    const geminiLink = join(canonicalProjectDir, '.gemini/skills', skillName);
    const customLink = join(canonicalProjectDir, 'custom-client/skills', skillName);
    const claudeTarget = expectedSymlinkTarget(claudeLink, join(skillsSource, skillName));
    const previousRules = {
      ...DEFAULT_MOUNT_RULES,
      customPaths: [{ alias: 'old-custom', path: 'old-custom-client/skills' }],
    };
    const nextRules = {
      ...DEFAULT_MOUNT_RULES,
      customPaths: [{ alias: 'custom-client', path: 'custom-client/skills' }],
    };

    await writeMountRules(canonicalProjectDir, previousRules);
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
    await symlink(claudeTarget, claudeLink);

    const app = await buildMountRulesApp({ mainProjectRoot: canonicalProjectDir });
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/mount-rules',
        headers: LOCAL_WRITE_HEADERS,
        payload: { projectPath: projectDir, rules: nextRules },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(
        resolve(dirname(claudeLink), await readlink(claudeLink)),
        resolve(join(skillsSource, skillName)),
        'declared provider should remain mounted',
      );
      assert.equal(await exists(codexLink), false, 'undeclared enabled standard provider should not be mounted');
      assert.equal(await exists(geminiLink), false, 'undeclared enabled standard provider should not be mounted');
      assert.equal(await exists(customLink), false, 'undeclared custom mount path should not be mounted');
    } finally {
      if (prevOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prevOwner;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('PUT /api/mount-rules prunes mountPaths for providers removed by new rules', async () => {
    const prevOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    const projectDir = await mkdtemp(join(tmpdir(), 'mount-rules-route-prune-mount-paths-'));
    const canonicalProjectDir = await realpath(projectDir);
    const skillsSource = await resolveRepoSkillsDir();
    const skillName = 'debugging';
    const claudeLink = join(canonicalProjectDir, '.claude/skills', skillName);
    const codexLink = join(canonicalProjectDir, '.codex/skills', skillName);
    const claudeTarget = expectedSymlinkTarget(claudeLink, join(skillsSource, skillName));
    const codexTarget = expectedSymlinkTarget(codexLink, join(skillsSource, skillName));
    const previousRules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        gemini: { ...DEFAULT_MOUNT_RULES.mountPoints.gemini, enabled: false },
        kimi: { ...DEFAULT_MOUNT_RULES.mountPoints.kimi, enabled: false },
      },
    };
    const nextRules = {
      ...previousRules,
      mountPoints: {
        ...previousRules.mountPoints,
        codex: { ...previousRules.mountPoints.codex, enabled: false },
      },
    };

    await writeMountRules(canonicalProjectDir, previousRules);
    await writeCapabilitiesConfig(canonicalProjectDir, {
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
    await Promise.all([
      mkdir(dirname(claudeLink), { recursive: true }),
      mkdir(dirname(codexLink), { recursive: true }),
    ]);
    await Promise.all([symlink(claudeTarget, claudeLink), symlink(codexTarget, codexLink)]);

    const app = await buildMountRulesApp({ mainProjectRoot: canonicalProjectDir });
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/mount-rules',
        headers: LOCAL_WRITE_HEADERS,
        payload: { projectPath: projectDir, rules: nextRules },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(await exists(codexLink), false, 'removed provider should be unmounted');
      assert.equal(
        resolve(dirname(claudeLink), await readlink(claudeLink)),
        resolve(join(skillsSource, skillName)),
        'remaining provider should stay mounted',
      );
      const persisted = JSON.parse(await readFile(join(canonicalProjectDir, '.cat-cafe/capabilities.json'), 'utf-8'));
      const cap = persisted.capabilities.find((entry) => entry.id === skillName);
      assert.deepEqual(cap.mountPaths, ['claude']);
      assert.equal(cap.enabled, true);
    } finally {
      if (prevOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prevOwner;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('reconciles inherited projects when default mount rules disable a provider', async () => {
    const mainDir = await mkdtemp(join(tmpdir(), 'mount-rules-route-default-main-'));
    const inheritedDir = await mkdtemp(join(tmpdir(), 'mount-rules-route-default-inherited-'));
    const ownRulesDir = await mkdtemp(join(tmpdir(), 'mount-rules-route-default-own-'));
    const legacyOwnRulesDir = await mkdtemp(join(tmpdir(), 'mount-rules-route-default-legacy-own-'));
    const inheritedProjectDir = await realpath(inheritedDir);
    const ownRulesProjectDir = await realpath(ownRulesDir);
    const legacyOwnRulesProjectDir = await realpath(legacyOwnRulesDir);
    const skillsSource = await resolveRepoSkillsDir();
    const skillName = 'debugging';
    const mainCodexLink = join(mainDir, '.codex/skills', skillName);
    const inheritedCodexLink = join(inheritedProjectDir, '.codex/skills', skillName);
    const ownCodexLink = join(ownRulesProjectDir, '.codex/skills', skillName);
    const legacyOwnCodexLink = join(legacyOwnRulesProjectDir, '.codex/skills', skillName);
    const mainTarget = expectedSymlinkTarget(mainCodexLink, join(skillsSource, skillName));
    const inheritedTarget = expectedSymlinkTarget(inheritedCodexLink, join(skillsSource, skillName));
    const ownTarget = expectedSymlinkTarget(ownCodexLink, join(skillsSource, skillName));
    const legacyOwnTarget = expectedSymlinkTarget(legacyOwnCodexLink, join(skillsSource, skillName));
    const previousRules = DEFAULT_MOUNT_RULES;
    const nextRules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        codex: { ...DEFAULT_MOUNT_RULES.mountPoints.codex, enabled: false },
      },
    };

    await mkdir(join(mainDir, '.cat-cafe'), { recursive: true });
    await writeFile(
      join(mainDir, '.cat-cafe/governance-registry.json'),
      `${JSON.stringify(
        {
          entries: [
            { projectPath: inheritedProjectDir, packVersion: 'test', syncedAt: new Date().toISOString() },
            { projectPath: ownRulesProjectDir, packVersion: 'test', syncedAt: new Date().toISOString() },
            { projectPath: legacyOwnRulesProjectDir, packVersion: 'test', syncedAt: new Date().toISOString() },
          ],
        },
        null,
        2,
      )}\n`,
    );
    await writeCapabilitiesConfig(mainDir, {
      version: 2,
      capabilities: [{ id: skillName, type: 'skill', enabled: true, source: 'cat-cafe', mountPaths: ['codex'] }],
    });
    await writeCapabilitiesConfig(inheritedProjectDir, {
      version: 2,
      capabilities: [{ id: skillName, type: 'skill', enabled: true, source: 'cat-cafe', mountPaths: ['codex'] }],
    });
    await writeCapabilitiesConfig(ownRulesProjectDir, {
      version: 2,
      capabilities: [{ id: skillName, type: 'skill', enabled: true, source: 'cat-cafe', mountPaths: ['codex'] }],
    });
    await writeMountRules(ownRulesProjectDir, previousRules);
    await writeMountRules(legacyOwnRulesProjectDir, previousRules);
    await Promise.all([
      mkdir(dirname(mainCodexLink), { recursive: true }),
      mkdir(dirname(inheritedCodexLink), { recursive: true }),
      mkdir(dirname(ownCodexLink), { recursive: true }),
      mkdir(dirname(legacyOwnCodexLink), { recursive: true }),
    ]);
    await Promise.all([
      symlink(mainTarget, mainCodexLink),
      symlink(inheritedTarget, inheritedCodexLink),
      symlink(ownTarget, ownCodexLink),
      symlink(legacyOwnTarget, legacyOwnCodexLink),
    ]);

    try {
      const skillsSource = await resolveRepoSkillsDir();
      await writeDefaultMountRules(mainDir, nextRules);
      await syncProject(mainDir, skillsSource, { mountRules: nextRules });
      const syncResult = await syncAll(mainDir, skillsSource, { mountRules: nextRules });

      assert.deepEqual(syncResult.warnings, []);
      assert.equal(await exists(mainCodexLink), false, 'main project default rules should be reconciled');
      assert.equal(await exists(inheritedCodexLink), false, 'inherited disabled provider should be cleaned');
      assert.equal(await readlink(ownCodexLink), ownTarget, 'project-owned mount rules should not be reconciled');
      assert.equal(
        await readlink(legacyOwnCodexLink),
        legacyOwnTarget,
        'legacy project-owned mount rules should not be reconciled',
      );
    } finally {
      await rm(mainDir, { recursive: true, force: true });
      await rm(inheritedProjectDir, { recursive: true, force: true });
      await rm(ownRulesProjectDir, { recursive: true, force: true });
      await rm(legacyOwnRulesProjectDir, { recursive: true, force: true });
    }
  });

  it('syncAll silently skips stale registry entries without treating them as propagation failures', async () => {
    const mainDir = await mkdtemp(join(tmpdir(), 'mount-rules-route-stale-main-'));
    const stalePath = join(tmpdir(), 'mount-rules-route-stale-deleted-does-not-exist-xyz');
    await mkdir(join(mainDir, '.cat-cafe'), { recursive: true });
    const registryFile = join(mainDir, '.cat-cafe/governance-registry.json');
    await writeFile(
      registryFile,
      `${JSON.stringify({ entries: [{ projectPath: stalePath, packVersion: 'test', syncedAt: new Date().toISOString() }] }, null, 2)}\n`,
    );
    await writeCapabilitiesConfig(mainDir, { version: 2, capabilities: [] });

    try {
      const skillsSource = await resolveRepoSkillsDir();
      const syncResult = await syncAll(mainDir, skillsSource, { mountRules: DEFAULT_MOUNT_RULES });

      // Stale path must be silently skipped — not a propagation failure.
      assert.deepEqual(syncResult.warnings, [], 'stale path must not appear in warnings');
      assert.equal(syncResult.perProject.size, 0, 'stale path must not produce a sync result');
    } finally {
      await rm(mainDir, { recursive: true, force: true });
    }
  });

  it('PUT /api/mount-rules preserves provider roots that remain disabled across rule edits', async () => {
    const prevOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    const projectDir = await mkdtemp(join(tmpdir(), 'mount-rules-route-disabled-root-'));
    const canonicalProjectDir = await realpath(projectDir);
    const skillsSource = await resolveRepoSkillsDir();
    const disabledKimiRoot = join(canonicalProjectDir, '.kimi/skills');
    const disabledKimiTarget = expectedSymlinkTarget(disabledKimiRoot, skillsSource);
    const previousRules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        claude: { enabled: true, path: '.claude/skills' },
        codex: { enabled: true, path: '.codex/skills' },
        gemini: { enabled: true, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };
    const nextRules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        ...previousRules.mountPoints,
        claude: { enabled: true, path: '.project-claude/skills' },
      },
    };

    await writeMountRules(canonicalProjectDir, previousRules);
    await mkdir(dirname(disabledKimiRoot), { recursive: true });
    await symlink(disabledKimiTarget, disabledKimiRoot);

    const app = await buildMountRulesApp({ mainProjectRoot: canonicalProjectDir });
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/mount-rules',
        headers: LOCAL_WRITE_HEADERS,
        payload: { projectPath: projectDir, rules: nextRules },
      });

      assert.equal(res.statusCode, 200);
      // R1 P2: disabled provider's legacy directory-level symlink must be removed —
      // it exposes all skills even though the provider is disabled
      assert.equal(
        await exists(disabledKimiRoot),
        false,
        'disabled provider legacy directory-level symlink should be cleaned',
      );
    } finally {
      if (prevOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prevOwner;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('PUT /api/mount-rules preserves user-owned directories as conflicts', async () => {
    const prevOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    const projectDir = await mkdtemp(join(tmpdir(), 'mount-rules-route-conflict-preserve-'));
    const canonicalProjectDir = await realpath(projectDir);
    const skillName = 'debugging';
    const nextRules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        claude: { enabled: true, path: '.project-claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };
    const userOwnedSkillDir = join(canonicalProjectDir, '.project-claude/skills', skillName);
    await mkdir(userOwnedSkillDir, { recursive: true });
    await writeFile(join(userOwnedSkillDir, 'local.txt'), 'keep local skill');

    const app = await buildMountRulesApp({ mainProjectRoot: canonicalProjectDir });
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/mount-rules',
        headers: LOCAL_WRITE_HEADERS,
        payload: { projectPath: projectDir, rules: nextRules },
      });

      // Conflicts are skip+record, not throw — user data preserved
      assert.equal(res.statusCode, 200);
      assert.equal(await readFile(join(userOwnedSkillDir, 'local.txt'), 'utf8'), 'keep local skill');
    } finally {
      if (prevOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prevOwner;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('PUT /api/mount-rules removes stale managed symlinks for source-removed skills', async () => {
    const prevOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    const projectDir = await mkdtemp(join(tmpdir(), 'mount-rules-route-removed-skill-'));
    const canonicalProjectDir = await realpath(projectDir);
    const skillsSource = await resolveRepoSkillsDir();
    const removedSkill = 'source-removed-skill';
    const oldClaudeLink = join(canonicalProjectDir, '.claude/skills', removedSkill);
    const oldCodexLink = join(canonicalProjectDir, '.codex/skills', removedSkill);
    const oldClaudeTarget = expectedSymlinkTarget(oldClaudeLink, join(skillsSource, removedSkill));
    const oldCodexTarget = expectedSymlinkTarget(oldCodexLink, join(skillsSource, removedSkill));
    const newRules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        claude: { enabled: true, path: '.project-claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };

    await Promise.all([
      mkdir(dirname(oldClaudeLink), { recursive: true }),
      mkdir(dirname(oldCodexLink), { recursive: true }),
    ]);
    await Promise.all([symlink(oldClaudeTarget, oldClaudeLink), symlink(oldCodexTarget, oldCodexLink)]);

    const app = await buildMountRulesApp({ mainProjectRoot: canonicalProjectDir });
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/mount-rules',
        headers: LOCAL_WRITE_HEADERS,
        payload: { projectPath: projectDir, rules: newRules },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(await exists(oldClaudeLink), false, 'source-removed symlink in old provider path should be cleaned');
      assert.equal(
        await exists(oldCodexLink),
        false,
        'source-removed symlink in now-disabled provider path should be cleaned',
      );
    } finally {
      if (prevOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prevOwner;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('PUT /api/mount-rules rejects owner writes from non-local browser origins before persisting', async () => {
    const prevOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    const projectDir = await mkdtemp(join(tmpdir(), 'mount-rules-route-remote-origin-'));
    const canonicalProjectDir = await realpath(projectDir);
    const newRules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        claude: { enabled: true, path: '.project-claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };

    const app = await buildMountRulesApp({ mainProjectRoot: canonicalProjectDir });
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/mount-rules',
        headers: {
          'x-test-session-user': OWNER_ID,
          origin: 'https://cafe.example.com',
          host: 'localhost:3003',
        },
        payload: { projectPath: projectDir, rules: newRules },
      });

      assert.equal(res.statusCode, 403);
    } finally {
      if (prevOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prevOwner;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('PUT /api/mount-rules allows local single-user writes when no owner is configured', async () => {
    const prevOwner = process.env.DEFAULT_OWNER_USER_ID;
    delete process.env.DEFAULT_OWNER_USER_ID;
    const projectDir = await mkdtemp(join(tmpdir(), 'mount-rules-route-single-user-'));
    const canonicalProjectDir = await realpath(projectDir);
    const newRules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        claude: { enabled: true, path: '.project-claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };

    const app = await buildMountRulesApp({ mainProjectRoot: canonicalProjectDir });
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/mount-rules',
        headers: {
          'x-test-session-user': 'single-user',
          origin: 'http://localhost:3003',
          host: 'localhost:3003',
        },
        payload: { projectPath: projectDir, rules: newRules },
      });

      assert.equal(res.statusCode, 200);
      assert.equal(await exists(join(projectDir, '.cat-cafe/capabilities.json')), true);
    } finally {
      if (prevOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prevOwner;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('PUT /api/mount-rules remounts plugin skill from old provider to new provider', async () => {
    const prevOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    const projectDir = await mkdtemp(join(tmpdir(), 'mount-rules-route-plugin-reconcile-'));
    const canonicalProjectDir = await realpath(projectDir);

    // pluginsDir must match the route's resolution: join(STARTUP_PROJECT_ROOT, 'plugins')
    const repoRoot = resolveRepoRoot();
    const pluginsDir = join(repoRoot, 'plugins');
    const pluginId = 'test-reconcile-plugin-regr';
    const skillName = 'plugin-reconcile-skill';
    const skillSourceDir = join(pluginsDir, pluginId, 'skills', skillName);
    await mkdir(skillSourceDir, { recursive: true });
    await writeFile(join(skillSourceDir, 'SKILL.md'), '# Test Plugin Skill\n');
    await writeFile(
      join(pluginsDir, pluginId, 'plugin.yaml'),
      [
        `id: ${pluginId}`,
        'name: Test Reconcile Plugin',
        'version: 1.0.0',
        'resources:',
        '  - type: skill',
        `    path: skills/${skillName}`,
      ].join('\n'),
    );

    // Write capabilities.json with an enabled plugin skill
    await writeCapabilitiesConfig(canonicalProjectDir, {
      version: 2,
      capabilities: [{ id: skillName, type: 'skill', enabled: true, source: 'cat-cafe', pluginId }],
    });

    // Pre-mount the plugin skill under old provider (.claude/skills)
    const oldClaudeLink = join(canonicalProjectDir, '.claude/skills', skillName);
    await mkdir(dirname(oldClaudeLink), { recursive: true });
    await symlink(expectedSymlinkTarget(oldClaudeLink, skillSourceDir), oldClaudeLink);

    // New rules: claude disabled, codex path changed
    const newRules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        claude: { enabled: false, path: '.claude/skills' },
        codex: { enabled: true, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };

    const app = await buildMountRulesApp({ mainProjectRoot: canonicalProjectDir });
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/mount-rules',
        headers: LOCAL_WRITE_HEADERS,
        payload: { projectPath: projectDir, rules: newRules },
      });

      assert.equal(res.statusCode, 200);

      // Plugin skill should be unmounted from disabled claude provider
      assert.equal(await exists(oldClaudeLink), false, 'plugin skill should be removed from disabled provider');

      // Plugin skill should be mounted under newly enabled codex provider
      const newCodexLink = join(canonicalProjectDir, '.codex/skills', skillName);
      assert.equal(
        (await lstat(newCodexLink)).isSymbolicLink(),
        true,
        'plugin skill should be mounted under newly enabled provider',
      );
      const target = await readlink(newCodexLink);
      assert.equal(
        resolve(dirname(newCodexLink), target),
        resolve(skillSourceDir),
        'plugin skill symlink should point to correct plugin source',
      );
    } finally {
      if (prevOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prevOwner;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
      await rm(join(pluginsDir, pluginId), { recursive: true, force: true });
    }
  });

  it('PUT /api/mount-rules remounts project-local plugin skill from old provider to new provider', async () => {
    const prevOwner = process.env.DEFAULT_OWNER_USER_ID;
    process.env.DEFAULT_OWNER_USER_ID = OWNER_ID;
    const projectDir = await mkdtemp(join(tmpdir(), 'mount-rules-route-project-plugin-reconcile-'));
    const canonicalProjectDir = await realpath(projectDir);
    const pluginsDir = join(canonicalProjectDir, 'plugins');
    const pluginId = 'test-project-local-reconcile-plugin';
    const skillName = 'project-plugin-reconcile-skill';
    const skillSourceDir = join(pluginsDir, pluginId, 'skills', skillName);

    await mkdir(skillSourceDir, { recursive: true });
    await writeFile(join(skillSourceDir, 'SKILL.md'), '# Test Project Plugin Skill\n');
    await writeFile(
      join(pluginsDir, pluginId, 'plugin.yaml'),
      [
        `id: ${pluginId}`,
        'name: Test Project Local Reconcile Plugin',
        'version: 1.0.0',
        'resources:',
        '  - type: skill',
        `    path: skills/${skillName}`,
      ].join('\n'),
    );
    await writeCapabilitiesConfig(canonicalProjectDir, {
      version: 2,
      capabilities: [{ id: skillName, type: 'skill', enabled: true, source: 'cat-cafe', pluginId }],
    });

    const oldClaudeLink = join(canonicalProjectDir, '.claude/skills', skillName);
    await mkdir(dirname(oldClaudeLink), { recursive: true });
    await symlink(expectedSymlinkTarget(oldClaudeLink, skillSourceDir), oldClaudeLink);

    const newRules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        claude: { enabled: false, path: '.claude/skills' },
        codex: { enabled: true, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };

    const app = await buildMountRulesApp({ mainProjectRoot: canonicalProjectDir });
    try {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/mount-rules',
        headers: LOCAL_WRITE_HEADERS,
        payload: { projectPath: projectDir, rules: newRules },
      });

      assert.equal(res.statusCode, 200, res.payload);
      assert.equal(await exists(oldClaudeLink), false, 'project-local plugin skill should leave disabled provider');

      const newCodexLink = join(canonicalProjectDir, '.codex/skills', skillName);
      assert.equal(
        (await lstat(newCodexLink)).isSymbolicLink(),
        true,
        'project-local plugin skill should mount under newly enabled provider',
      );
      assert.equal(
        resolve(dirname(newCodexLink), await readlink(newCodexLink)),
        resolve(skillSourceDir),
        'project-local plugin symlink should point to project-local source',
      );
    } finally {
      if (prevOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
      else process.env.DEFAULT_OWNER_USER_ID = prevOwner;
      await app.close();
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('syncProject removes legacy directory-level symlink on disabled provider', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'sync-disabled-legacy-root-'));
    const canonicalDir = await realpath(projectDir);
    const skillsSource = await resolveRepoSkillsDir();
    const codexSkillsDir = join(canonicalDir, '.codex/skills');

    // Create a legacy directory-level symlink on a disabled provider
    await mkdir(dirname(codexSkillsDir), { recursive: true });
    await symlink(expectedSymlinkTarget(codexSkillsDir, skillsSource), codexSkillsDir);

    const rules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        claude: { enabled: true, path: '.claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };

    try {
      const result = await syncProject(canonicalDir, skillsSource, { mountRules: rules });

      // The legacy directory-level symlink on disabled codex should be removed
      assert.equal(
        await exists(codexSkillsDir),
        false,
        'disabled provider directory-level symlink must be removed by Phase 3',
      );
      assert.ok(
        result.unmounted.some((u) => u.path === codexSkillsDir),
        'unmounted list should include the removed directory-level symlink',
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('syncProject ignores config entries with path-traversal skill ids', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'mount-rules-invalid-id-'));
    const canonicalDir = await realpath(projectDir);
    const skillsSource = await resolveCatCafeSkillsSource();

    // Seed capabilities.json with a path-traversal cap.id
    await writeCapabilitiesConfig(canonicalDir, {
      version: 2,
      capabilities: [{ id: '../../traversal-target', type: 'skill', source: 'cat-cafe', enabled: true }],
    });

    const rules = { ...DEFAULT_MOUNT_RULES };

    try {
      const result = await syncProject(canonicalDir, skillsSource, { mountRules: rules });

      // Invalid cap.id must not appear in removed list (filtered at ingestion)
      assert.ok(
        !result.removed.includes('../../traversal-target'),
        'invalid skill id must be filtered from removed list',
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('mountSkillSymlinks rejects symlinked provider dirs instead of following them', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'mount-symlink-dir-'));
    const canonicalDir = await realpath(projectDir);
    const outsideDir = await mkdtemp(join(tmpdir(), 'mount-outside-'));
    const skillsSource = await resolveCatCafeSkillsSource();

    // Make .claude/skills a symlink pointing outside the project
    await mkdir(join(canonicalDir, '.claude'), { recursive: true });
    await symlink(outsideDir, join(canonicalDir, '.claude', 'skills'));

    const rules = { ...DEFAULT_MOUNT_RULES };

    try {
      const result = await mountSkillSymlinks(canonicalDir, 'tdd', skillsSource, rules);

      // Should report conflict for the symlinked provider dir, NOT mount into it
      assert.ok(
        result.conflicts.some((c) => c.skillName === 'tdd'),
        'should report conflict for symlinked provider dir',
      );
      assert.ok(
        !result.mounted.some((m) => m.skillName === 'tdd' && m.path?.includes('.claude')),
        'should not mount into symlinked provider dir',
      );

      // Verify nothing was written into the symlink target (outside dir)
      await assert.rejects(lstat(join(outsideDir, 'tdd')), { code: 'ENOENT' }, 'symlink target must not be written to');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('syncProject does not freeze inherited global mountPaths into project config', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'mount-global-cascade-'));
    const canonicalDir = await realpath(projectDir);
    const skillsSource = await resolveCatCafeSkillsSource();
    const rules = { ...DEFAULT_MOUNT_RULES };

    try {
      // First sync: global policy says mount tdd to claude only (no project overrides).
      // preserveGlobalCascade=true simulates drift-resolve context.
      await syncProject(canonicalDir, skillsSource, {
        mountRules: rules,
        globalMountPathsBySkill: new Map([['tdd', ['claude']]]),
        preserveGlobalCascade: true,
      });

      // Project config must NOT have frozen mountPaths=['claude'] for tdd
      const config1 = await readCapabilitiesConfig(canonicalDir);
      const tddCap1 = config1?.capabilities.find(
        (c) => c.id === 'tdd' && c.type === 'skill' && c.source === 'cat-cafe' && !c.pluginId,
      );
      assert.ok(
        !tddCap1?.mountPaths?.includes('claude'),
        'inherited global mountPaths must not be frozen into project config',
      );

      // Second sync: global changed to codex — should cascade
      const result2 = await syncProject(canonicalDir, skillsSource, {
        mountRules: rules,
        globalMountPathsBySkill: new Map([['tdd', ['codex']]]),
        preserveGlobalCascade: true,
      });

      // tdd should mount to codex (global cascade worked), not stuck on old claude
      assert.ok(
        result2.mounted.some((m) => m.skillName === 'tdd' && m.mountPointId === 'codex'),
        'tdd should be mounted to codex after global policy change',
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('syncProject supplements newly enabled mount point into active skills (scenario 9)', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'mount-rules-route-scenario9-'));
    const canonicalProjectDir = await realpath(projectDir);
    const skillsSource = await resolveRepoSkillsDir();
    const skillName = 'debugging';
    const claudeLink = join(canonicalProjectDir, '.claude/skills', skillName);
    const codexLink = join(canonicalProjectDir, '.codex/skills', skillName);

    // Setup: skill mounted only to claude, codex disabled
    await mkdir(dirname(claudeLink), { recursive: true });
    await mkdir(dirname(codexLink), { recursive: true });
    await symlink(expectedSymlinkTarget(claudeLink, join(skillsSource, skillName)), claudeLink);
    await writeCapabilitiesConfig(canonicalProjectDir, {
      version: 2,
      capabilities: [{ id: skillName, type: 'skill', enabled: true, source: 'cat-cafe', mountPaths: ['claude'] }],
    });

    const previousRules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        claude: { enabled: true, path: '.claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };
    const newRules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        claude: { enabled: true, path: '.claude/skills' },
        codex: { enabled: true, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };

    try {
      // Enable codex mount point
      const result = await syncProject(canonicalProjectDir, skillsSource, {
        mountRules: newRules,
        previousMountRules: previousRules,
        pruneMountPaths: true,
      });

      // Config must include codex
      const config = await readCapabilitiesConfig(canonicalProjectDir);
      const cap = config?.capabilities.find((c) => c.id === skillName);
      assert.ok(cap?.mountPaths?.includes('codex'), 'mountPaths should include newly enabled codex');
      assert.ok(cap?.mountPaths?.includes('claude'), 'mountPaths should still include claude');

      // Symlinks must exist for both
      assert.ok(await exists(claudeLink), 'claude symlink should still exist');
      assert.ok(await exists(codexLink), 'codex symlink should be created for newly enabled mount point');
      assert.ok(
        result.mounted.some((m) => m.skillName === skillName && m.mountPointId === 'codex'),
        'codex mount should appear in sync result',
      );
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
