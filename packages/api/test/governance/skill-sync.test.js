/**
 * ADR-025 Phase 2: Skill Sync Service
 *
 * Tests for the sync logic that creates/updates per-skill symlinks
 * and updates capabilities.json#skillsSync.
 */

import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { DEFAULT_MOUNT_RULES } from '@cat-cafe/shared';
import {
  readCapabilitiesConfig,
  writeCapabilitiesConfig,
} from '../../dist/config/capabilities/capability-orchestrator.js';
import { syncSkills } from '../../dist/config/governance/skill-sync.js';

let tempDir;
let projectRoot;
let skillsSource;

async function assertNoLegacySkillsState(projectRoot) {
  await assert.rejects(() => lstat(join(projectRoot, '.cat-cafe', 'skills-state.json')), { code: 'ENOENT' });
}

describe('Skill Sync Service (ADR-025 Phase 2)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-sync-'));
    projectRoot = join(tempDir, 'project');
    skillsSource = join(tempDir, 'cat-cafe-skills');

    await mkdir(projectRoot, { recursive: true });

    // Create skill source tree
    await mkdir(join(skillsSource, 'tdd'), { recursive: true });
    await writeFile(join(skillsSource, 'tdd', 'SKILL.md'), '# TDD');
    await mkdir(join(skillsSource, 'debugging'));
    await writeFile(join(skillsSource, 'debugging', 'SKILL.md'), '# Debugging');
    await mkdir(join(skillsSource, 'worktree'));
    await writeFile(join(skillsSource, 'worktree', 'SKILL.md'), '# Worktree');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('creates per-skill symlinks for all 4 providers', async () => {
    const result = await syncSkills(projectRoot, skillsSource);

    // Check symlinks exist for each provider
    for (const provider of ['.claude', '.codex', '.gemini', '.kimi']) {
      for (const skill of ['debugging', 'tdd', 'worktree']) {
        const linkPath = join(projectRoot, provider, 'skills', skill);
        const s = await lstat(linkPath);
        assert.ok(s.isSymbolicLink(), `${provider}/skills/${skill} should be a symlink`);

        const target = await readlink(linkPath);
        const expectedTarget = relative(join(projectRoot, provider, 'skills'), join(skillsSource, skill));
        assert.equal(target, expectedTarget, `${provider}/skills/${skill} should point to source`);
      }
    }

    assert.deepStrictEqual(result.synced.sort(), ['debugging', 'tdd', 'worktree']);
    assert.deepStrictEqual(result.removed, []);
  });

  test('updates capabilities.json#skillsSync after sync without writing legacy skills-state.json', async () => {
    const result = await syncSkills(projectRoot, skillsSource);

    const config = await readCapabilitiesConfig(projectRoot);
    assert.ok(config?.skillsSync, 'capabilities.json#skillsSync should exist after sync');
    assert.equal(config.version, 2);
    assert.equal(config.skillsSync.sourceRoot, relative(projectRoot, skillsSource));
    assert.ok(config.skillsSync.sourceManifestHash.startsWith('sha256:'));
    assert.ok(config.skillsSync.lastSyncedAt, 'should have a timestamp');
    assert.equal(result.newHash, config.skillsSync.sourceManifestHash);
    const managedIds = config.capabilities.filter((cap) => cap.type === 'skill' && cap.source === 'cat-cafe');
    assert.deepStrictEqual(managedIds.map((cap) => cap.id).sort(), ['debugging', 'tdd', 'worktree']);
    await assertNoLegacySkillsState(projectRoot);
  });

  test('removes stale symlinks for skills no longer in source', async () => {
    // First sync with all 3 skills
    await syncSkills(projectRoot, skillsSource);

    // Remove debugging from source
    await rm(join(skillsSource, 'debugging'), { recursive: true });

    // Re-sync
    const result = await syncSkills(projectRoot, skillsSource);

    assert.deepStrictEqual(result.removed, ['debugging']);
    assert.deepStrictEqual(result.synced.sort(), ['tdd', 'worktree']);

    // Verify symlink is gone
    for (const provider of ['.claude', '.codex', '.gemini', '.kimi']) {
      const linkPath = join(projectRoot, provider, 'skills', 'debugging');
      try {
        await lstat(linkPath);
        assert.fail(`${provider}/skills/debugging should have been removed`);
      } catch (err) {
        assert.equal(err.code, 'ENOENT');
      }
    }

    const config = await readCapabilitiesConfig(projectRoot);
    assert.equal(
      config?.capabilities.some((cap) => cap.type === 'skill' && cap.id === 'debugging'),
      false,
      'source-deleted skills should be removed from capabilities after stale symlinks are cleaned',
    );
  });

  test('preserves plugin-owned skill mountPaths during Cat Cafe source sync', async () => {
    await writeCapabilitiesConfig(projectRoot, {
      version: 2,
      capabilities: [
        {
          id: 'plugin-owned-skill',
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'test-plugin',
          mountPaths: ['claude'],
        },
      ],
    });

    await syncSkills(projectRoot, skillsSource);

    const config = await readCapabilitiesConfig(projectRoot);
    const pluginSkill = config?.capabilities.find((cap) => cap.type === 'skill' && cap.id === 'plugin-owned-skill');
    assert.deepStrictEqual(
      pluginSkill?.mountPaths,
      ['claude'],
      'source-tree sync must not clear mountPaths for plugin-owned skills',
    );
  });

  test('creates Cat Cafe capability without mutating a same-name plugin-owned skill', async () => {
    await mkdir(join(skillsSource, 'plugin-owned-skill'), { recursive: true });
    await writeFile(join(skillsSource, 'plugin-owned-skill', 'SKILL.md'), '# First-party skill');
    await writeCapabilitiesConfig(projectRoot, {
      version: 2,
      capabilities: [
        {
          id: 'plugin-owned-skill',
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'test-plugin',
          mountPaths: ['claude'],
        },
      ],
    });

    await syncSkills(projectRoot, skillsSource);

    const config = await readCapabilitiesConfig(projectRoot);
    const pluginSkill = config?.capabilities.find(
      (cap) => cap.type === 'skill' && cap.id === 'plugin-owned-skill' && cap.pluginId === 'test-plugin',
    );
    const catCafeSkill = config?.capabilities.find(
      (cap) => cap.type === 'skill' && cap.id === 'plugin-owned-skill' && !cap.pluginId,
    );
    assert.deepStrictEqual(
      pluginSkill?.mountPaths,
      ['claude'],
      'source-tree sync must not mutate same-name plugin-owned skill policy',
    );
    assert.deepStrictEqual(
      catCafeSkill?.mountPaths,
      ['claude', 'codex', 'gemini', 'kimi'],
      'source-tree sync must create an independent Cat Cafe skill capability with all available mount points',
    );
    assert.equal(catCafeSkill?.source, 'cat-cafe');
    assert.equal(catCafeSkill?.enabled, true);
  });

  test('rejects incorrect symlinks pointing to user-owned targets', async () => {
    // Create a wrong symlink first
    const claudeSkills = join(projectRoot, '.claude', 'skills');
    const userSource = join(tempDir, 'user-skills');
    await mkdir(claudeSkills, { recursive: true });
    await mkdir(join(userSource, 'tdd'), { recursive: true });
    await symlink(join(userSource, 'tdd'), join(claudeSkills, 'tdd'));

    await assert.rejects(
      () => syncSkills(projectRoot, skillsSource),
      /Refusing to sync skill mount/,
      'sync must report the conflict instead of replacing user-owned skill symlinks',
    );

    const target = await readlink(join(claudeSkills, 'tdd'));
    assert.equal(target, join(userSource, 'tdd'), 'user-owned symlink should be preserved');
    await assertNoLegacySkillsState(projectRoot);
  });

  test('rejects user-owned directories at managed skill paths', async () => {
    const localSkillDir = join(projectRoot, '.claude', 'skills', 'tdd');
    await mkdir(localSkillDir, { recursive: true });
    await writeFile(join(localSkillDir, 'local.txt'), 'keep local skill');

    await assert.rejects(
      () => syncSkills(projectRoot, skillsSource),
      /Refusing to sync skill mount/,
      'sync must report the conflict instead of deleting local skill content',
    );

    const stat = await lstat(localSkillDir);
    assert.equal(stat.isDirectory(), true, 'user-owned directory should be preserved');
    assert.equal(await readFile(join(localSkillDir, 'local.txt'), 'utf8'), 'keep local skill');
    await assertNoLegacySkillsState(projectRoot);
  });

  test('rolls back earlier provider writes when a later provider has a user-owned conflict', async () => {
    const localSkillDir = join(projectRoot, '.codex', 'skills', 'tdd');
    await mkdir(localSkillDir, { recursive: true });
    await writeFile(join(localSkillDir, 'local.txt'), 'keep local skill');

    await assert.rejects(
      () => syncSkills(projectRoot, skillsSource),
      /Refusing to sync skill mount/,
      'sync must report the later provider conflict',
    );

    for (const skill of ['debugging', 'tdd', 'worktree']) {
      await assert.rejects(
        () => lstat(join(projectRoot, '.claude', 'skills', skill)),
        { code: 'ENOENT' },
        `earlier .claude write for ${skill} should be rolled back`,
      );
    }
    assert.equal(await readFile(join(localSkillDir, 'local.txt'), 'utf8'), 'keep local skill');
    await assertNoLegacySkillsState(projectRoot);
  });

  test('preserves user-owned symlinks when removing source-deleted stale skills', async () => {
    await syncSkills(projectRoot, skillsSource);
    await rm(join(skillsSource, 'debugging'), { recursive: true });

    const userSource = join(tempDir, 'user-skills');
    const userTarget = join(userSource, 'debugging');
    const claudeDebugging = join(projectRoot, '.claude', 'skills', 'debugging');
    await mkdir(userTarget, { recursive: true });
    await rm(claudeDebugging);
    await symlink(userTarget, claudeDebugging);

    await syncSkills(projectRoot, skillsSource);

    assert.equal(await readlink(claudeDebugging), userTarget, 'source-deleted user symlink should be preserved');
  });

  test('does not write through directory-level provider skills symlinks', async () => {
    const codexDir = join(projectRoot, '.codex');
    const codexSkills = join(codexDir, 'skills');
    await mkdir(codexDir, { recursive: true });
    await symlink(skillsSource, codexSkills);

    await syncSkills(projectRoot, skillsSource);

    const sourceTdd = await lstat(join(skillsSource, 'tdd'));
    assert.equal(sourceTdd.isDirectory(), true, 'source skill directory must not be replaced by a symlink');
    assert.equal(await readlink(codexSkills), skillsSource, 'directory-level mount should be preserved');

    const claudeSkill = join(projectRoot, '.claude', 'skills', 'tdd');
    assert.equal((await lstat(claudeSkill)).isSymbolicLink(), true, 'non-mounted providers still get per-skill links');
  });

  test('converts directory-level provider skills symlinks when a source skill is disabled', async () => {
    const claudeSkills = join(projectRoot, '.claude', 'skills');
    await mkdir(join(projectRoot, '.claude'), { recursive: true });
    await symlink(skillsSource, claudeSkills);

    await syncSkills(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, { disabledSkills: ['debugging'] });

    const rootStat = await lstat(claudeSkills);
    assert.equal(rootStat.isDirectory(), true, 'legacy root should be converted to a real provider dir');
    assert.equal(rootStat.isSymbolicLink(), false, 'legacy directory-level symlink should be removed');

    const tddLink = join(claudeSkills, 'tdd');
    assert.equal((await lstat(tddLink)).isSymbolicLink(), true, 'enabled skill should remain mounted');
    assert.equal(await readlink(tddLink), relative(claudeSkills, join(skillsSource, 'tdd')));

    await assert.rejects(() => lstat(join(claudeSkills, 'debugging')), /ENOENT/);
    assert.equal(await readFile(join(skillsSource, 'debugging', 'SKILL.md'), 'utf8'), '# Debugging');
  });

  test('rejects invalid directory-level provider skills symlinks', async () => {
    const codexDir = join(projectRoot, '.codex');
    const codexSkills = join(codexDir, 'skills');
    const wrongSource = join(tempDir, 'wrong-skills');
    await mkdir(codexDir, { recursive: true });
    await mkdir(wrongSource, { recursive: true });
    await symlink(wrongSource, codexSkills);

    await assert.rejects(
      () => syncSkills(projectRoot, skillsSource),
      /Invalid directory-level skills mount/,
      'wrong directory-level mount should fail loudly instead of marking sync successful',
    );
    await assertNoLegacySkillsState(projectRoot);
  });

  test('rejects dangling directory-level provider skills symlinks', async () => {
    const codexDir = join(projectRoot, '.codex');
    const codexSkills = join(codexDir, 'skills');
    await mkdir(codexDir, { recursive: true });
    await symlink(join(tempDir, 'missing-skills'), codexSkills);

    await assert.rejects(
      () => syncSkills(projectRoot, skillsSource),
      /Invalid directory-level skills mount/,
      'dangling directory-level mount should fail loudly instead of marking sync successful',
    );
    await assertNoLegacySkillsState(projectRoot);
  });

  test('is idempotent — second sync produces same result', async () => {
    const result1 = await syncSkills(projectRoot, skillsSource);
    const result2 = await syncSkills(projectRoot, skillsSource);

    assert.equal(result1.newHash, result2.newHash);
    assert.deepStrictEqual(result1.synced.sort(), result2.synced.sort());
  });

  test('returns empty result for source dir with no skills', async () => {
    const emptySource = join(tempDir, 'empty-skills');
    await mkdir(emptySource, { recursive: true });

    const result = await syncSkills(projectRoot, emptySource);

    assert.deepStrictEqual(result.synced, []);
    assert.equal(result.newHash.startsWith('sha256:'), true);
  });
});
