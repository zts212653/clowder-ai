/**
 * ADR-025 Phase 1: skills-state.json — managed skill set + manifest hash
 *
 * Tests for the SkillsState module that tracks which skills are
 * managed by Clowder AI sync vs externally installed.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

// Module under test
import {
  checkStaleness,
  computeSourceManifestHash,
  isManagedSkill,
  listSourceSkillNames,
  readSkillsState,
  writeSkillsState,
} from '../../dist/config/governance/skills-state.js';

let tempDir;

describe('SkillsState (ADR-025 Phase 1)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skills-state-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // --- readSkillsState ---

  test('readSkillsState returns null when file does not exist', async () => {
    const result = await readSkillsState(tempDir);
    assert.equal(result, null);
  });

  test('readSkillsState returns null when file is malformed JSON', async () => {
    const catCafeDir = join(tempDir, '.cat-cafe');
    await mkdir(catCafeDir, { recursive: true });
    await writeFile(join(catCafeDir, 'skills-state.json'), 'not json');
    const result = await readSkillsState(tempDir);
    assert.equal(result, null);
  });

  test('readSkillsState returns null when required fields are missing', async () => {
    const catCafeDir = join(tempDir, '.cat-cafe');
    await mkdir(catCafeDir, { recursive: true });
    await writeFile(join(catCafeDir, 'skills-state.json'), '{"foo":"bar"}');
    const result = await readSkillsState(tempDir);
    assert.equal(result, null);
  });

  // --- writeSkillsState ---

  test('writeSkillsState creates .cat-cafe directory and writes valid JSON', async () => {
    const state = {
      managedSkillNames: ['tdd', 'worktree'],
      sourceRoot: '../../cat-cafe-skills',
      sourceManifestHash: 'sha256:abc123',
      lastSyncedAt: '2026-04-15T12:00:00Z',
    };

    await writeSkillsState(tempDir, state);

    const raw = await readFile(join(tempDir, '.cat-cafe', 'skills-state.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    assert.deepStrictEqual(parsed.managedSkillNames, ['tdd', 'worktree']);
    assert.equal(parsed.sourceRoot, '../../cat-cafe-skills');
    assert.equal(parsed.sourceManifestHash, 'sha256:abc123');
    assert.equal(parsed.lastSyncedAt, '2026-04-15T12:00:00Z');
  });

  // --- round-trip ---

  test('write then read returns the same data', async () => {
    const state = {
      managedSkillNames: ['quality-gate', 'debugging', 'tdd'],
      sourceRoot: '../../cat-cafe-skills',
      sourceManifestHash: 'sha256:def456',
      lastSyncedAt: '2026-04-15T14:30:00Z',
    };

    await writeSkillsState(tempDir, state);
    const result = await readSkillsState(tempDir);
    assert.deepStrictEqual(result, state);
  });

  // --- computeSourceManifestHash ---

  test('computeSourceManifestHash is deterministic', async () => {
    // Create fake skills source dir
    const skillsRoot = join(tempDir, 'cat-cafe-skills');
    await mkdir(join(skillsRoot, 'tdd'), { recursive: true });
    await writeFile(join(skillsRoot, 'tdd', 'SKILL.md'), '# TDD');
    await mkdir(join(skillsRoot, 'worktree'));
    await writeFile(join(skillsRoot, 'worktree', 'SKILL.md'), '# Worktree');

    const hash1 = await computeSourceManifestHash(skillsRoot);
    const hash2 = await computeSourceManifestHash(skillsRoot);

    assert.equal(hash1, hash2);
    assert.ok(hash1.startsWith('sha256:'), `hash should start with sha256: but got ${hash1}`);
  });

  test('computeSourceManifestHash changes when a skill is added', async () => {
    const skillsRoot = join(tempDir, 'cat-cafe-skills');
    await mkdir(join(skillsRoot, 'tdd'), { recursive: true });
    await writeFile(join(skillsRoot, 'tdd', 'SKILL.md'), '# TDD');

    const hash1 = await computeSourceManifestHash(skillsRoot);

    // Add a new skill
    await mkdir(join(skillsRoot, 'debugging'));
    await writeFile(join(skillsRoot, 'debugging', 'SKILL.md'), '# Debugging');

    const hash2 = await computeSourceManifestHash(skillsRoot);

    assert.notEqual(hash1, hash2, 'Hash should change when skills are added');
  });

  test('computeSourceManifestHash changes when a skill is removed', async () => {
    const skillsRoot = join(tempDir, 'cat-cafe-skills');
    await mkdir(join(skillsRoot, 'tdd'), { recursive: true });
    await writeFile(join(skillsRoot, 'tdd', 'SKILL.md'), '# TDD');
    await mkdir(join(skillsRoot, 'debugging'));
    await writeFile(join(skillsRoot, 'debugging', 'SKILL.md'), '# Debugging');

    const hash1 = await computeSourceManifestHash(skillsRoot);

    // Remove a skill
    await rm(join(skillsRoot, 'debugging'), { recursive: true });

    const hash2 = await computeSourceManifestHash(skillsRoot);

    assert.notEqual(hash1, hash2, 'Hash should change when skills are removed');
  });

  test('computeSourceManifestHash ignores dirs without SKILL.md', async () => {
    const skillsRoot = join(tempDir, 'cat-cafe-skills');
    await mkdir(join(skillsRoot, 'tdd'), { recursive: true });
    await writeFile(join(skillsRoot, 'tdd', 'SKILL.md'), '# TDD');
    await mkdir(join(skillsRoot, 'refs')); // no SKILL.md — should be ignored

    const hash1 = await computeSourceManifestHash(skillsRoot);

    // Add another non-skill dir
    await mkdir(join(skillsRoot, 'scripts'));

    const hash2 = await computeSourceManifestHash(skillsRoot);

    assert.equal(hash1, hash2, 'Hash should not change for non-skill dirs');
  });

  // --- bash/TypeScript parity ---

  test('computeSourceManifestHash matches bash printf|sort|shasum', async () => {
    // Known input: skills "debugging", "tdd", "worktree" (sorted)
    // bash: printf '%s\n' debugging tdd worktree | sort | shasum -a 256 | cut -c1-16
    // Expected: a2febe6348bb2854
    const skillsRoot = join(tempDir, 'cat-cafe-skills');
    for (const name of ['debugging', 'tdd', 'worktree']) {
      await mkdir(join(skillsRoot, name), { recursive: true });
      await writeFile(join(skillsRoot, name, 'SKILL.md'), `# ${name}`);
    }

    const hash = await computeSourceManifestHash(skillsRoot);
    assert.equal(hash, 'sha256:a2febe6348bb2854', 'Hash must match bash shasum output');
  });

  // --- isManagedSkill ---

  test('isManagedSkill returns true for managed skill names', () => {
    const state = {
      managedSkillNames: ['tdd', 'worktree', 'quality-gate'],
      sourceRoot: '../../cat-cafe-skills',
      sourceManifestHash: 'sha256:abc',
      lastSyncedAt: '2026-04-15T00:00:00Z',
    };
    assert.equal(isManagedSkill(state, 'tdd'), true);
    assert.equal(isManagedSkill(state, 'worktree'), true);
  });

  test('isManagedSkill returns false for external skill names', () => {
    const state = {
      managedSkillNames: ['tdd', 'worktree'],
      sourceRoot: '../../cat-cafe-skills',
      sourceManifestHash: 'sha256:abc',
      lastSyncedAt: '2026-04-15T00:00:00Z',
    };
    assert.equal(isManagedSkill(state, 'react-best-practices'), false);
  });

  test('isManagedSkill returns false when state is null', () => {
    assert.equal(isManagedSkill(null, 'tdd'), false);
  });

  // --- listSourceSkillNames (ADR-025 Phase 2) ---

  test('listSourceSkillNames returns sorted skill names', async () => {
    const skillsRoot = join(tempDir, 'cat-cafe-skills');
    await mkdir(join(skillsRoot, 'worktree'), { recursive: true });
    await writeFile(join(skillsRoot, 'worktree', 'SKILL.md'), '# Worktree');
    await mkdir(join(skillsRoot, 'tdd'));
    await writeFile(join(skillsRoot, 'tdd', 'SKILL.md'), '# TDD');
    await mkdir(join(skillsRoot, 'refs')); // no SKILL.md

    const names = await listSourceSkillNames(skillsRoot);
    assert.deepStrictEqual(names, ['tdd', 'worktree']);
  });

  test('listSourceSkillNames returns empty for missing dir', async () => {
    const names = await listSourceSkillNames(join(tempDir, 'nonexistent'));
    assert.deepStrictEqual(names, []);
  });

  // --- checkStaleness (ADR-025 Phase 2) ---

  test('checkStaleness reports fresh when hashes match', async () => {
    const skillsRoot = join(tempDir, 'cat-cafe-skills');
    await mkdir(join(skillsRoot, 'tdd'), { recursive: true });
    await writeFile(join(skillsRoot, 'tdd', 'SKILL.md'), '# TDD');

    const hash = await computeSourceManifestHash(skillsRoot);
    await writeSkillsState(tempDir, {
      managedSkillNames: ['tdd'],
      sourceRoot: 'cat-cafe-skills',
      sourceManifestHash: hash,
      lastSyncedAt: '2026-04-16T00:00:00Z',
    });

    const result = await checkStaleness(tempDir, skillsRoot);
    assert.equal(result.stale, false);
    assert.deepStrictEqual(result.newSkills, []);
    assert.deepStrictEqual(result.removedSkills, []);
  });

  test('checkStaleness reports stale when skill added', async () => {
    const skillsRoot = join(tempDir, 'cat-cafe-skills');
    await mkdir(join(skillsRoot, 'tdd'), { recursive: true });
    await writeFile(join(skillsRoot, 'tdd', 'SKILL.md'), '# TDD');

    const hash = await computeSourceManifestHash(skillsRoot);
    await writeSkillsState(tempDir, {
      managedSkillNames: ['tdd'],
      sourceRoot: 'cat-cafe-skills',
      sourceManifestHash: hash,
      lastSyncedAt: '2026-04-16T00:00:00Z',
    });

    // Add a new skill to source
    await mkdir(join(skillsRoot, 'debugging'));
    await writeFile(join(skillsRoot, 'debugging', 'SKILL.md'), '# Debugging');

    const result = await checkStaleness(tempDir, skillsRoot);
    assert.equal(result.stale, true);
    assert.deepStrictEqual(result.newSkills, ['debugging']);
    assert.deepStrictEqual(result.removedSkills, []);
  });

  test('checkStaleness reports stale when skill removed from source', async () => {
    const skillsRoot = join(tempDir, 'cat-cafe-skills');
    await mkdir(join(skillsRoot, 'tdd'), { recursive: true });
    await writeFile(join(skillsRoot, 'tdd', 'SKILL.md'), '# TDD');
    await mkdir(join(skillsRoot, 'debugging'));
    await writeFile(join(skillsRoot, 'debugging', 'SKILL.md'), '# Debugging');

    const hash = await computeSourceManifestHash(skillsRoot);
    await writeSkillsState(tempDir, {
      managedSkillNames: ['debugging', 'tdd'],
      sourceRoot: 'cat-cafe-skills',
      sourceManifestHash: hash,
      lastSyncedAt: '2026-04-16T00:00:00Z',
    });

    // Remove a skill from source
    await rm(join(skillsRoot, 'debugging'), { recursive: true });

    const result = await checkStaleness(tempDir, skillsRoot);
    assert.equal(result.stale, true);
    assert.deepStrictEqual(result.newSkills, []);
    assert.deepStrictEqual(result.removedSkills, ['debugging']);
  });

  test('checkStaleness reports stale when no state file exists', async () => {
    const skillsRoot = join(tempDir, 'cat-cafe-skills');
    await mkdir(join(skillsRoot, 'tdd'), { recursive: true });
    await writeFile(join(skillsRoot, 'tdd', 'SKILL.md'), '# TDD');

    const result = await checkStaleness(tempDir, skillsRoot);
    assert.equal(result.stale, true);
    assert.equal(result.recordedHash, null);
    assert.deepStrictEqual(result.newSkills, ['tdd']);
  });
});
