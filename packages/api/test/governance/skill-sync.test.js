/**
 * ADR-025 Phase 2: Skill Sync Service
 *
 * Tests for the sync logic that creates/updates per-skill symlinks
 * and updates skills-state.json.
 */

import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { syncSkills } from '../../dist/config/governance/skill-sync.js';
import { readSkillsState } from '../../dist/config/governance/skills-state.js';

let tempDir;
let projectRoot;
let skillsSource;

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
        const expectedTarget = join(skillsSource, skill);
        assert.equal(target, expectedTarget, `${provider}/skills/${skill} should point to source`);
      }
    }

    assert.deepStrictEqual(result.synced.sort(), ['debugging', 'tdd', 'worktree']);
    assert.deepStrictEqual(result.removed, []);
  });

  test('updates skills-state.json after sync', async () => {
    const result = await syncSkills(projectRoot, skillsSource);

    const state = await readSkillsState(projectRoot);
    assert.ok(state, 'skills-state.json should exist after sync');
    assert.deepStrictEqual(state.managedSkillNames.sort(), ['debugging', 'tdd', 'worktree']);
    assert.ok(state.sourceManifestHash.startsWith('sha256:'));
    assert.ok(state.lastSyncedAt, 'should have a timestamp');
    assert.equal(result.newHash, state.sourceManifestHash);
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
  });

  test('fixes incorrect symlinks pointing to wrong target', async () => {
    // Create a wrong symlink first
    const claudeSkills = join(projectRoot, '.claude', 'skills');
    await mkdir(claudeSkills, { recursive: true });
    await symlink('/wrong/target', join(claudeSkills, 'tdd'));

    await syncSkills(projectRoot, skillsSource);

    const target = await readlink(join(claudeSkills, 'tdd'));
    assert.equal(target, join(skillsSource, 'tdd'), 'should fix the wrong symlink');
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
