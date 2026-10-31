/**
 * F228: capabilities.json-backed skill sync state helpers.
 */

import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  readCapabilitiesConfig,
  writeCapabilitiesConfig,
} from '../../dist/config/capabilities/capability-orchestrator.js';
import {
  readSkillsSyncState,
  updateSkillMountPaths,
  writeSkillsSyncState,
} from '../../dist/skills/skill-sync-config.js';
import { checkStaleness, computeSourceManifestHash, listSourceSkillNames } from '../../dist/utils/skill-source.js';

let tempDir;

async function makeSkill(skillsRoot, name) {
  await mkdir(join(skillsRoot, name), { recursive: true });
  await writeFile(join(skillsRoot, name, 'SKILL.md'), `# ${name}`);
}

async function writeSyncedCapabilities(projectRoot, skillsRoot, skillIds) {
  const hash = await computeSourceManifestHash(skillsRoot);
  await writeCapabilitiesConfig(projectRoot, {
    version: 2,
    skillsSync: {
      sourceRoot: 'cat-cafe-skills',
      sourceManifestHash: hash,
      lastSyncedAt: '2026-04-16T00:00:00Z',
    },
    capabilities: skillIds.map((id) => ({
      id,
      type: 'skill',
      enabled: true,
      source: 'cat-cafe',
    })),
  });
  return hash;
}

describe('Skills sync state (F228)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skills-state-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('writeSkillsSyncState writes capabilities.json#skillsSync without skills-state.json', async () => {
    await writeSkillsSyncState(tempDir, {
      sourceRoot: 'cat-cafe-skills',
      sourceManifestHash: 'sha256:abc123',
      lastSyncedAt: '2026-04-15T12:00:00Z',
    });

    const config = await readCapabilitiesConfig(tempDir);
    assert.equal(config?.version, 2);
    assert.deepEqual(config?.skillsSync, {
      sourceRoot: 'cat-cafe-skills',
      sourceManifestHash: 'sha256:abc123',
      lastSyncedAt: '2026-04-15T12:00:00Z',
    });
    await assert.rejects(() => lstat(join(tempDir, '.cat-cafe', 'skills-state.json')), { code: 'ENOENT' });
  });

  test('readSkillsSyncState reads only capabilities.json#skillsSync', async () => {
    await writeSkillsSyncState(tempDir, {
      sourceRoot: 'cat-cafe-skills',
      sourceManifestHash: 'sha256:def456',
      lastSyncedAt: '2026-04-15T14:30:00Z',
    });

    const result = await readSkillsSyncState(tempDir);
    assert.deepEqual(result, {
      sourceRoot: 'cat-cafe-skills',
      sourceManifestHash: 'sha256:def456',
      lastSyncedAt: '2026-04-15T14:30:00Z',
    });
  });

  test('updateSkillMountPaths writes empty mountPaths when no active mount points (F228 simplified)', async () => {
    await writeCapabilitiesConfig(tempDir, {
      version: 2,
      capabilities: [
        { id: 'debugging', type: 'skill', enabled: true, source: 'cat-cafe', mountPaths: ['claude'] },
        { id: 'worktree', type: 'skill', enabled: false, source: 'cat-cafe', mountPaths: [] },
      ],
    });

    // F228 simplified: empty mountPointIds = no active mounts → write mountPaths: []
    // No preservation — mountPaths is a current-state record, not a "desired" strategy.
    await updateSkillMountPaths(tempDir, ['debugging'], []);
    // Non-empty providers → update mountPaths only; enabled/globalEnabled are unchanged.
    await updateSkillMountPaths(tempDir, ['worktree'], ['codex']);
    // New entry with empty mountPointIds, no forceDisabled → defaults to enabled=true, mountPaths=[]
    await updateSkillMountPaths(tempDir, ['tdd'], []);

    const config = await readCapabilitiesConfig(tempDir);
    const byId = new Map(config?.capabilities.map((cap) => [cap.id, cap]));

    // F228 simplified: empty mountPointIds writes mountPaths: [] directly.
    // enabled/globalEnabled unchanged (no force flag).
    assert.deepEqual(byId.get('debugging'), {
      id: 'debugging',
      type: 'skill',
      enabled: true,
      globalEnabled: true,
      source: 'cat-cafe',
      mountPaths: [],
    });
    assert.deepEqual(byId.get('worktree'), {
      id: 'worktree',
      type: 'skill',
      enabled: false,
      globalEnabled: false,
      source: 'cat-cafe',
      mountPaths: ['codex'],
    });
    // F228: New upsert with empty providers → enabled:true, mountPaths:[].
    // In practice callers pass the active mount point list, but the function
    // faithfully records whatever is passed.
    const tdd = byId.get('tdd');
    assert.deepEqual(tdd, {
      id: 'tdd',
      type: 'skill',
      enabled: true,
      globalEnabled: true,
      source: 'cat-cafe',
      mountPaths: [],
    });
  });

  test('updateSkillMountPaths forceDisabled sets enabled=false even when providers are empty (F228 P1)', async () => {
    await writeCapabilitiesConfig(tempDir, {
      version: 2,
      capabilities: [{ id: 'debugging', type: 'skill', enabled: true, source: 'cat-cafe', mountPaths: ['claude'] }],
    });

    // forceDisabled: true → always disable, regardless of existing state
    await updateSkillMountPaths(tempDir, ['debugging'], [], { forceDisabled: true });
    // New entry with forceDisabled → also disabled
    await updateSkillMountPaths(tempDir, ['tdd'], [], { forceDisabled: true });

    const config = await readCapabilitiesConfig(tempDir);
    const byId = new Map(config?.capabilities.map((cap) => [cap.id, cap]));

    assert.deepEqual(byId.get('debugging'), {
      id: 'debugging',
      type: 'skill',
      enabled: false,
      globalEnabled: false,
      source: 'cat-cafe',
      mountPaths: [],
    });
    assert.deepEqual(byId.get('tdd'), {
      id: 'tdd',
      type: 'skill',
      enabled: false,
      globalEnabled: false,
      source: 'cat-cafe',
      mountPaths: [],
    });
  });

  test('updateSkillMountPaths forceEnabled restores with explicit mount points (F228 cascade re-enable)', async () => {
    // Simulates cascade re-enable: skill was cascade-disabled (enabled:false, mountPaths:[]),
    // then global re-enables → forceEnabled sets enabled:true with all available mount points.
    await writeCapabilitiesConfig(tempDir, {
      version: 2,
      capabilities: [{ id: 'tdd', type: 'skill', enabled: false, source: 'cat-cafe', mountPaths: [] }],
    });

    // Caller passes the active mount point list (not empty)
    await updateSkillMountPaths(tempDir, ['tdd'], ['claude', 'codex', 'gemini', 'kimi'], { forceEnabled: true });

    const config = await readCapabilitiesConfig(tempDir);
    const tdd = config?.capabilities.find((c) => c.id === 'tdd');
    assert.equal(tdd.enabled, true, 'forceEnabled must set enabled:true');
    assert.deepStrictEqual(
      tdd.mountPaths,
      ['claude', 'codex', 'gemini', 'kimi'],
      'forceEnabled must write explicit mount point list',
    );
  });

  test('updateSkillMountPaths explicit mount points lifecycle (F228 state-record model)', async () => {
    // F228: mountPaths = faithful record of current mount state.
    // Callers always pass explicit mount point lists.

    await writeCapabilitiesConfig(tempDir, { version: 2, capabilities: [] });

    // Step 1: First sync — new skill gets all available mount points
    await updateSkillMountPaths(tempDir, ['tdd'], ['claude', 'codex', 'gemini', 'kimi']);

    const config1 = await readCapabilitiesConfig(tempDir);
    const tdd1 = config1?.capabilities.find((c) => c.id === 'tdd');
    assert.ok(tdd1, 'tdd should be created');
    assert.equal(tdd1.enabled, true, 'new skill defaults to enabled');
    assert.deepStrictEqual(tdd1.mountPaths, ['claude', 'codex', 'gemini', 'kimi'], 'all mount points recorded');

    // Step 2: User restricts to kimi only (scenario 2 per mount point)
    await updateSkillMountPaths(tempDir, ['tdd'], ['kimi']);

    const config2 = await readCapabilitiesConfig(tempDir);
    const tdd2 = config2?.capabilities.find((c) => c.id === 'tdd');
    assert.equal(tdd2.enabled, true);
    assert.deepStrictEqual(tdd2.mountPaths, ['kimi'], 'restricted to kimi only');

    // Step 3: Empty mountPointIds → write mountPaths: [] (no active mounts)
    // F228 simplified: no preservation. enabled unchanged (no force flag).
    await updateSkillMountPaths(tempDir, ['tdd'], []);

    const config3 = await readCapabilitiesConfig(tempDir);
    const tdd3 = config3?.capabilities.find((c) => c.id === 'tdd');
    assert.equal(tdd3.enabled, true, 'still enabled — empty mountPointIds does not change enabled');
    assert.deepStrictEqual(tdd3.mountPaths, [], 'empty mountPointIds writes empty mountPaths (no preservation)');

    // Step 4: Re-enable with full list (cascade re-enable scenario)
    await updateSkillMountPaths(tempDir, ['tdd'], ['claude', 'codex', 'gemini', 'kimi'], { forceEnabled: true });

    const config4 = await readCapabilitiesConfig(tempDir);
    const tdd4 = config4?.capabilities.find((c) => c.id === 'tdd');
    assert.equal(tdd4.enabled, true);
    assert.deepStrictEqual(tdd4.mountPaths, ['claude', 'codex', 'gemini', 'kimi'], 'all mount points restored');
  });

  test('computeSourceManifestHash is deterministic', async () => {
    const skillsRoot = join(tempDir, 'cat-cafe-skills');
    await makeSkill(skillsRoot, 'tdd');
    await makeSkill(skillsRoot, 'worktree');

    const hash1 = await computeSourceManifestHash(skillsRoot);
    const hash2 = await computeSourceManifestHash(skillsRoot);

    assert.equal(hash1, hash2);
    assert.ok(hash1.startsWith('sha256:'), `hash should start with sha256: but got ${hash1}`);
  });

  test('computeSourceManifestHash changes when a skill is added or removed', async () => {
    const skillsRoot = join(tempDir, 'cat-cafe-skills');
    await makeSkill(skillsRoot, 'tdd');
    const hash1 = await computeSourceManifestHash(skillsRoot);

    await makeSkill(skillsRoot, 'debugging');
    const hash2 = await computeSourceManifestHash(skillsRoot);
    assert.notEqual(hash1, hash2, 'Hash should change when skills are added');

    await rm(join(skillsRoot, 'debugging'), { recursive: true });
    const hash3 = await computeSourceManifestHash(skillsRoot);
    assert.equal(hash3, hash1, 'Hash should return to the original skill set hash');
  });

  test('computeSourceManifestHash ignores dirs without SKILL.md and matches bash parity', async () => {
    const skillsRoot = join(tempDir, 'cat-cafe-skills');
    for (const name of ['debugging', 'tdd', 'worktree']) {
      await makeSkill(skillsRoot, name);
    }
    await mkdir(join(skillsRoot, 'refs'));

    const hash = await computeSourceManifestHash(skillsRoot);
    assert.equal(hash, 'sha256:a2febe6348bb2854', 'Hash must match bash shasum output');
  });

  test('listSourceSkillNames returns sorted skill names', async () => {
    const skillsRoot = join(tempDir, 'cat-cafe-skills');
    await makeSkill(skillsRoot, 'worktree');
    await makeSkill(skillsRoot, 'tdd');
    await mkdir(join(skillsRoot, 'refs'));

    const names = await listSourceSkillNames(skillsRoot);
    assert.deepStrictEqual(names, ['tdd', 'worktree']);
  });

  test('listSourceSkillNames returns empty for missing dir', async () => {
    const names = await listSourceSkillNames(join(tempDir, 'nonexistent'));
    assert.deepStrictEqual(names, []);
  });

  test('checkStaleness reports fresh when skillsSync hash and managed capabilities match source', async () => {
    const skillsRoot = join(tempDir, 'cat-cafe-skills');
    await makeSkill(skillsRoot, 'tdd');
    await writeSyncedCapabilities(tempDir, skillsRoot, ['tdd']);

    const result = await checkStaleness(tempDir, skillsRoot);
    assert.equal(result.stale, false);
    assert.deepStrictEqual(result.newSkills, []);
    assert.deepStrictEqual(result.removedSkills, []);
  });

  test('checkStaleness reports added and removed skills from capabilities source entries', async () => {
    const skillsRoot = join(tempDir, 'cat-cafe-skills');
    await makeSkill(skillsRoot, 'tdd');
    await writeSyncedCapabilities(tempDir, skillsRoot, ['debugging', 'tdd']);

    await makeSkill(skillsRoot, 'worktree');
    const result = await checkStaleness(tempDir, skillsRoot);
    assert.equal(result.stale, true);
    assert.deepStrictEqual(result.newSkills, ['worktree']);
    assert.deepStrictEqual(result.removedSkills, ['debugging']);
  });

  test('checkStaleness ignores plugin-owned skills when detecting removed source skills', async () => {
    const skillsRoot = join(tempDir, 'cat-cafe-skills');
    await makeSkill(skillsRoot, 'tdd');
    const hash = await writeSyncedCapabilities(tempDir, skillsRoot, ['tdd']);
    const config = await readCapabilitiesConfig(tempDir);
    config.capabilities.push({
      id: 'plugin-skill',
      type: 'skill',
      enabled: true,
      source: 'cat-cafe',
      pluginId: 'test-plugin',
    });
    await writeCapabilitiesConfig(tempDir, config);

    const result = await checkStaleness(tempDir, skillsRoot);

    assert.equal(result.stale, false);
    assert.equal(result.recordedHash, hash);
    assert.deepStrictEqual(result.newSkills, []);
    assert.deepStrictEqual(result.removedSkills, []);
  });

  test('checkStaleness reports stale when no capabilities sync state exists', async () => {
    const skillsRoot = join(tempDir, 'cat-cafe-skills');
    await makeSkill(skillsRoot, 'tdd');

    const result = await checkStaleness(tempDir, skillsRoot);
    assert.equal(result.stale, true);
    assert.equal(result.recordedHash, null);
    assert.deepStrictEqual(result.newSkills, ['tdd']);
  });
});
