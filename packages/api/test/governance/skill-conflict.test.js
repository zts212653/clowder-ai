/**
 * ADR-025 Phase 2: Skill Conflict Detection
 *
 * Tests for detecting same-name skills across user-level and project-level
 * directories that point to different realpath targets.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { detectConflicts } from '../../dist/config/governance/skill-conflict.js';

let tempDir;
let projectRoot;
let homeDir;
let skillsSourceA;
let skillsSourceB;

describe('Skill Conflict Detection (ADR-025 Phase 2)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-conflict-'));
    projectRoot = join(tempDir, 'project');
    homeDir = join(tempDir, 'home');

    // Two different skill source trees (simulating A/B checkout drift)
    skillsSourceA = join(tempDir, 'source-a');
    skillsSourceB = join(tempDir, 'source-b');

    // Create skill content in both sources
    await mkdir(join(skillsSourceA, 'tdd'), { recursive: true });
    await writeFile(join(skillsSourceA, 'tdd', 'SKILL.md'), '# TDD from A');
    await mkdir(join(skillsSourceB, 'tdd'), { recursive: true });
    await writeFile(join(skillsSourceB, 'tdd', 'SKILL.md'), '# TDD from B');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('no conflict when user-level has no matching skill', async () => {
    // Only project-level has the skill
    const projectSkills = join(projectRoot, '.claude', 'skills');
    await mkdir(projectSkills, { recursive: true });
    await symlink(join(skillsSourceA, 'tdd'), join(projectSkills, 'tdd'));

    // User-level dir exists but empty
    const userSkills = join(homeDir, '.claude', 'skills');
    await mkdir(userSkills, { recursive: true });

    const conflicts = await detectConflicts(projectRoot, homeDir, ['tdd']);
    assert.equal(conflicts.length, 0);
  });

  test('no conflict when both point to same target', async () => {
    const projectSkills = join(projectRoot, '.claude', 'skills');
    await mkdir(projectSkills, { recursive: true });
    await symlink(join(skillsSourceA, 'tdd'), join(projectSkills, 'tdd'));

    const userSkills = join(homeDir, '.claude', 'skills');
    await mkdir(userSkills, { recursive: true });
    await symlink(join(skillsSourceA, 'tdd'), join(userSkills, 'tdd'));

    const conflicts = await detectConflicts(projectRoot, homeDir, ['tdd']);
    assert.equal(conflicts.length, 0);
  });

  test('detects conflict when project and user point to different targets', async () => {
    const projectSkills = join(projectRoot, '.claude', 'skills');
    await mkdir(projectSkills, { recursive: true });
    await symlink(join(skillsSourceA, 'tdd'), join(projectSkills, 'tdd'));

    const userSkills = join(homeDir, '.claude', 'skills');
    await mkdir(userSkills, { recursive: true });
    await symlink(join(skillsSourceB, 'tdd'), join(userSkills, 'tdd'));

    const conflicts = await detectConflicts(projectRoot, homeDir, ['tdd']);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].skillName, 'tdd');
    assert.equal(conflicts[0].activeLayer, 'user');
  });

  test('detects conflict across multiple providers', async () => {
    // Set up Claude provider conflict
    for (const provider of ['.claude', '.codex']) {
      const projectDir = join(projectRoot, provider, 'skills');
      await mkdir(projectDir, { recursive: true });
      await symlink(join(skillsSourceA, 'tdd'), join(projectDir, 'tdd'));

      const userDir = join(homeDir, provider, 'skills');
      await mkdir(userDir, { recursive: true });
      await symlink(join(skillsSourceB, 'tdd'), join(userDir, 'tdd'));
    }

    const conflicts = await detectConflicts(projectRoot, homeDir, ['tdd']);
    // Should report ONE conflict per skill (not per provider)
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].skillName, 'tdd');
  });

  test('handles missing skill directories gracefully', async () => {
    // Neither project nor home has skills dirs
    const conflicts = await detectConflicts(projectRoot, homeDir, ['tdd']);
    assert.equal(conflicts.length, 0);
  });

  test('ignores non-managed skills', async () => {
    // User has an external skill that's not in managed list
    const userSkills = join(homeDir, '.claude', 'skills');
    await mkdir(join(userSkills, 'react-best-practices'), { recursive: true });
    await writeFile(join(userSkills, 'react-best-practices', 'SKILL.md'), '# React');

    const conflicts = await detectConflicts(projectRoot, homeDir, ['tdd']);
    assert.equal(conflicts.length, 0);
  });

  test('P1-2: detects conflict when user-level is a real directory (not symlink)', async () => {
    // Project-level: symlink → source-a/tdd (the usual managed symlink)
    const projectSkills = join(projectRoot, '.claude', 'skills');
    await mkdir(projectSkills, { recursive: true });
    await symlink(join(skillsSourceA, 'tdd'), join(projectSkills, 'tdd'));

    // User-level: real directory (external install, e.g. `claude skill install`)
    const userSkills = join(homeDir, '.claude', 'skills');
    const userTddDir = join(userSkills, 'tdd');
    await mkdir(userTddDir, { recursive: true });
    await writeFile(join(userTddDir, 'SKILL.md'), '# TDD external (real dir, not symlink)');

    const conflicts = await detectConflicts(projectRoot, homeDir, ['tdd']);
    // Must detect this — user-level real dir shadows project-level symlink
    assert.equal(conflicts.length, 1, 'Should detect conflict with real directory at user-level');
    assert.equal(conflicts[0].skillName, 'tdd');
    assert.equal(conflicts[0].activeLayer, 'user');
  });

  test('P1-2: detects conflict when project-level is a real directory', async () => {
    // Project-level: real directory (non-symlink install)
    const projectSkills = join(projectRoot, '.claude', 'skills');
    const projectTddDir = join(projectSkills, 'tdd');
    await mkdir(projectTddDir, { recursive: true });
    await writeFile(join(projectTddDir, 'SKILL.md'), '# TDD project-local');

    // User-level: symlink → source-b/tdd
    const userSkills = join(homeDir, '.claude', 'skills');
    await mkdir(userSkills, { recursive: true });
    await symlink(join(skillsSourceB, 'tdd'), join(userSkills, 'tdd'));

    const conflicts = await detectConflicts(projectRoot, homeDir, ['tdd']);
    assert.equal(conflicts.length, 1, 'Should detect conflict with real directory at project-level');
    assert.equal(conflicts[0].skillName, 'tdd');
  });

  test('P1-2: no conflict when both are real directories at same realpath', async () => {
    // Both sides are real directories but with same content location
    // (edge case: same absolute path shouldn't conflict with itself)
    const sharedDir = join(tempDir, 'shared-skills', 'tdd');
    await mkdir(sharedDir, { recursive: true });
    await writeFile(join(sharedDir, 'SKILL.md'), '# TDD shared');

    // Both symlink to same place
    const projectSkills = join(projectRoot, '.claude', 'skills');
    await mkdir(projectSkills, { recursive: true });
    await symlink(sharedDir, join(projectSkills, 'tdd'));

    const userSkills = join(homeDir, '.claude', 'skills');
    await mkdir(userSkills, { recursive: true });
    await symlink(sharedDir, join(userSkills, 'tdd'));

    const conflicts = await detectConflicts(projectRoot, homeDir, ['tdd']);
    assert.equal(conflicts.length, 0, 'Same target should not be flagged as conflict');
  });
});
