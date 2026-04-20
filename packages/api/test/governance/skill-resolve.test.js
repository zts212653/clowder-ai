/**
 * ADR-025 Phase 2: Skill Conflict Resolution
 *
 * Tests for resolving conflicts between user-level and project-level skills.
 * - 'official' → remove user-level symlink (project version wins)
 * - 'mine' → remove project-level symlink + remove from managed set
 */

import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { resolveConflict } from '../../dist/config/governance/skill-sync.js';
import { readSkillsState, writeSkillsState } from '../../dist/config/governance/skills-state.js';

let tempDir;
let projectRoot;
let homeDir;
let skillsSourceA;
let skillsSourceB;

describe('Skill Conflict Resolution (ADR-025 Phase 2)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-resolve-'));
    projectRoot = join(tempDir, 'project');
    homeDir = join(tempDir, 'home');
    skillsSourceA = join(tempDir, 'source-a');
    skillsSourceB = join(tempDir, 'source-b');

    // Create two different skill versions
    await mkdir(join(skillsSourceA, 'tdd'), { recursive: true });
    await writeFile(join(skillsSourceA, 'tdd', 'SKILL.md'), '# TDD from A (official)');
    await mkdir(join(skillsSourceB, 'tdd'), { recursive: true });
    await writeFile(join(skillsSourceB, 'tdd', 'SKILL.md'), '# TDD from B (user)');

    // Set up conflicting symlinks for all providers
    for (const provider of ['.claude', '.codex', '.gemini', '.kimi']) {
      const projectDir = join(projectRoot, provider, 'skills');
      await mkdir(projectDir, { recursive: true });
      await symlink(join(skillsSourceA, 'tdd'), join(projectDir, 'tdd'));

      const userDir = join(homeDir, provider, 'skills');
      await mkdir(userDir, { recursive: true });
      await symlink(join(skillsSourceB, 'tdd'), join(userDir, 'tdd'));
    }

    // Write initial skills-state
    await writeSkillsState(projectRoot, {
      managedSkillNames: ['tdd', 'debugging'],
      sourceRoot: skillsSourceA,
      sourceManifestHash: 'sha256:abc123',
      lastSyncedAt: '2026-04-16T00:00:00Z',
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('official choice removes user-level symlinks', async () => {
    await resolveConflict(projectRoot, homeDir, 'tdd', 'official');

    // User-level symlinks should be removed
    for (const provider of ['.claude', '.codex', '.gemini', '.kimi']) {
      const userLink = join(homeDir, provider, 'skills', 'tdd');
      try {
        await lstat(userLink);
        assert.fail(`${provider} user-level symlink should be removed`);
      } catch (err) {
        assert.equal(err.code, 'ENOENT');
      }
    }

    // Project-level symlinks should remain
    for (const provider of ['.claude', '.codex', '.gemini', '.kimi']) {
      const projectLink = join(projectRoot, provider, 'skills', 'tdd');
      const s = await lstat(projectLink);
      assert.ok(s.isSymbolicLink(), `${provider} project-level symlink should remain`);
    }

    // managed set unchanged
    const state = await readSkillsState(projectRoot);
    assert.ok(state?.managedSkillNames.includes('tdd'));
  });

  test('mine choice removes project-level symlinks and updates managed set', async () => {
    await resolveConflict(projectRoot, homeDir, 'tdd', 'mine');

    // Project-level symlinks should be removed
    for (const provider of ['.claude', '.codex', '.gemini', '.kimi']) {
      const projectLink = join(projectRoot, provider, 'skills', 'tdd');
      try {
        await lstat(projectLink);
        assert.fail(`${provider} project-level symlink should be removed`);
      } catch (err) {
        assert.equal(err.code, 'ENOENT');
      }
    }

    // User-level symlinks should remain
    for (const provider of ['.claude', '.codex', '.gemini', '.kimi']) {
      const userLink = join(homeDir, provider, 'skills', 'tdd');
      const s = await lstat(userLink);
      assert.ok(s.isSymbolicLink(), `${provider} user-level symlink should remain`);
    }

    // 'tdd' removed from managed set, 'debugging' remains
    const state = await readSkillsState(projectRoot);
    assert.ok(state);
    assert.ok(!state.managedSkillNames.includes('tdd'), 'tdd should be removed from managed set');
    assert.ok(state.managedSkillNames.includes('debugging'), 'debugging should remain');
  });

  test('handles missing symlinks gracefully', async () => {
    // Remove user-level symlinks first
    for (const provider of ['.claude', '.codex', '.gemini', '.kimi']) {
      await rm(join(homeDir, provider, 'skills', 'tdd'));
    }

    // Should not throw even though user-level is already gone
    await resolveConflict(projectRoot, homeDir, 'tdd', 'official');
  });

  test('rejects invalid choice', async () => {
    await assert.rejects(
      // @ts-expect-error — testing runtime validation
      resolveConflict(projectRoot, homeDir, 'tdd', 'invalid'),
      /Invalid choice/,
    );
  });

  test('P1-1: rejects skillName with path traversal characters', async () => {
    // ../victim-link should not be accepted — it could escape the skills directory
    await assert.rejects(resolveConflict(projectRoot, homeDir, '../victim-link', 'official'), /Invalid skill name/);

    // Nested traversal
    await assert.rejects(resolveConflict(projectRoot, homeDir, '../../etc/passwd', 'mine'), /Invalid skill name/);

    // Absolute path injection
    await assert.rejects(resolveConflict(projectRoot, homeDir, '/tmp/evil', 'official'), /Invalid skill name/);

    // Dot-only names
    await assert.rejects(resolveConflict(projectRoot, homeDir, '..', 'official'), /Invalid skill name/);
    await assert.rejects(resolveConflict(projectRoot, homeDir, '.', 'official'), /Invalid skill name/);

    // Skill names with slashes (subdirectory traversal)
    await assert.rejects(resolveConflict(projectRoot, homeDir, 'foo/bar', 'official'), /Invalid skill name/);
  });
});
