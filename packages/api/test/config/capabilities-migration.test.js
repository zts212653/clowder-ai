/**
 * F228 Task 0B: capabilities.json v1→v2 auto-migration
 *
 * Tests the migration of:
 * - version 1 → 2
 * - CapabilityEntry mountPaths population from filesystem symlinks
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  migrateAndPersistCapabilities,
  readCapabilitiesConfig,
} from '../../dist/config/capabilities/capability-orchestrator.js';
import { migrateCapabilitiesV1ToV2 } from '../../dist/config/governance/capabilities-migration.js';

let tempDir;
let skillsSource;

describe('capabilities-migration (F228 Task 0B)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cap-migration-'));
    // Create a minimal skills source directory with 2 skills
    skillsSource = join(tempDir, 'cat-cafe-skills');
    await mkdir(join(skillsSource, 'tech-writing'), { recursive: true });
    await writeFile(join(skillsSource, 'tech-writing', 'SKILL.md'), '---\ncategory: writing\n---');
    await mkdir(join(skillsSource, 'tdd'), { recursive: true });
    await writeFile(join(skillsSource, 'tdd', 'SKILL.md'), '---\ncategory: dev\n---');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // --- readCapabilitiesConfig accepts v2 ---

  test('readCapabilitiesConfig accepts version 2 config', async () => {
    const catCafe = join(tempDir, '.cat-cafe');
    await mkdir(catCafe, { recursive: true });
    const config = {
      version: 2,
      capabilities: [{ id: 'tech-writing', type: 'skill', enabled: true, source: 'cat-cafe', mountPaths: ['claude'] }],
      skillsSync: {
        sourceRoot: 'cat-cafe-skills',
        sourceManifestHash: 'sha256:abc123',
        lastSyncedAt: '2026-05-29T12:00:00.000Z',
      },
    };
    await writeFile(join(catCafe, 'capabilities.json'), JSON.stringify(config));
    const result = await readCapabilitiesConfig(tempDir);
    assert.notEqual(result, null, 'v2 config should not be rejected');
    assert.equal(result.version, 2);
    assert.equal(result.capabilities[0].mountPaths[0], 'claude');
  });

  test('readCapabilitiesConfig returns v2 in memory without writing back (pure read)', async () => {
    const catCafe = join(tempDir, '.cat-cafe');
    await mkdir(catCafe, { recursive: true });
    await writeFile(
      join(catCafe, 'capabilities.json'),
      JSON.stringify({
        version: 1,
        capabilities: [{ id: 'tech-writing', type: 'skill', enabled: true, source: 'cat-cafe' }],
      }),
    );

    const result = await readCapabilitiesConfig(tempDir);
    assert.notEqual(result, null, 'v1 config should be migrated in memory');
    assert.equal(result.version, 2);
    const cap = result.capabilities.find((c) => c.id === 'tech-writing');
    assert.deepEqual(cap?.mountPaths, [], 'skill mountPaths should be populated during in-memory migration');

    // Pure read must NOT write back — file on disk should still be v1
    const persisted = JSON.parse(await readFile(join(catCafe, 'capabilities.json'), 'utf-8'));
    assert.equal(persisted.version, 1, 'pure read must not write back v2 to disk');
  });

  test('migrateAndPersistCapabilities migrates v1 and writes back v2', async () => {
    const catCafe = join(tempDir, '.cat-cafe');
    await mkdir(catCafe, { recursive: true });
    await writeFile(
      join(catCafe, 'capabilities.json'),
      JSON.stringify({
        version: 1,
        capabilities: [{ id: 'tech-writing', type: 'skill', enabled: true, source: 'cat-cafe' }],
      }),
    );

    const result = await migrateAndPersistCapabilities(tempDir);
    assert.notEqual(result, null, 'v1 config should be migrated');
    assert.equal(result.version, 2);
    const cap = result.capabilities.find((c) => c.id === 'tech-writing');
    assert.deepEqual(cap?.mountPaths, [], 'skill mountPaths should be populated during migration');

    // Explicit migration must persist v2 to disk
    const persisted = JSON.parse(await readFile(join(catCafe, 'capabilities.json'), 'utf-8'));
    assert.equal(persisted.version, 2, 'explicit migration should persist v2');
    assert.deepEqual(persisted.capabilities[0].mountPaths, []);
  });

  // --- v1 → v2 migration ---

  test('v1 config → version bumped to 2', async () => {
    const v1 = {
      version: 1,
      capabilities: [{ id: 'tech-writing', type: 'skill', enabled: true, source: 'cat-cafe' }],
    };
    const result = await migrateCapabilitiesV1ToV2(tempDir, v1, skillsSource);
    assert.equal(result.version, 2);
  });

  test('already v2 → no-op (returned as-is)', async () => {
    const v2 = {
      version: 2,
      capabilities: [{ id: 'tech-writing', type: 'skill', enabled: true, source: 'cat-cafe', mountPaths: ['claude'] }],
      skillsSync: {
        sourceRoot: 'cat-cafe-skills',
        sourceManifestHash: 'sha256:abc',
        lastSyncedAt: '2026-01-01T00:00:00Z',
      },
    };
    const result = await migrateCapabilitiesV1ToV2(tempDir, v2, skillsSource);
    assert.equal(result.version, 2);
    assert.deepEqual(result.capabilities[0].mountPaths, ['claude'], 'existing mountPaths preserved');
    assert.equal(result.skillsSync.sourceManifestHash, 'sha256:abc', 'existing skillsSync preserved');
  });

  test('v1 migration leaves skillsSync unset until first sync', async () => {
    const v1 = { version: 1, capabilities: [] };
    const result = await migrateCapabilitiesV1ToV2(tempDir, v1, skillsSource);
    assert.equal(result.skillsSync, undefined);
  });

  test('v1 migration does not set mountRules (uses default fallback at runtime)', async () => {
    const v1 = { version: 1, capabilities: [] };
    const result = await migrateCapabilitiesV1ToV2(tempDir, v1, skillsSource);
    assert.equal(result.mountRules, undefined);
  });

  // --- mountPaths populated from filesystem ---

  test('skill with existing symlinks → mountPaths populated', async () => {
    // Create provider skill directories with symlinks
    const claudeSkills = join(tempDir, '.claude', 'skills');
    const codexSkills = join(tempDir, '.codex', 'skills');
    await mkdir(claudeSkills, { recursive: true });
    await mkdir(codexSkills, { recursive: true });

    // Create symlinks for 'tech-writing' in claude and codex
    const techSrc = join(skillsSource, 'tech-writing');
    await symlink(relative(claudeSkills, techSrc), join(claudeSkills, 'tech-writing'));
    await symlink(relative(codexSkills, techSrc), join(codexSkills, 'tech-writing'));

    const v1 = {
      version: 1,
      capabilities: [
        { id: 'tech-writing', type: 'skill', enabled: true, source: 'cat-cafe' },
        { id: 'tdd', type: 'skill', enabled: true, source: 'cat-cafe' },
      ],
    };
    const result = await migrateCapabilitiesV1ToV2(tempDir, v1, skillsSource);

    const tw = result.capabilities.find((c) => c.id === 'tech-writing');
    assert.ok(tw.mountPaths, 'tech-writing should have mountPaths');
    assert.ok(tw.mountPaths.includes('claude'), 'should include claude');
    assert.ok(tw.mountPaths.includes('codex'), 'should include codex');

    const tdd = result.capabilities.find((c) => c.id === 'tdd');
    assert.ok(tdd.mountPaths, 'tdd should have mountPaths');
    assert.equal(tdd.mountPaths.length, 0, 'tdd has no symlinks → empty mountPaths');
  });

  test('v1 migration preserves plugin-owned skill implicit mount policy', async () => {
    const v1 = {
      version: 1,
      capabilities: [
        {
          id: 'tech-writing',
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          pluginId: 'legacy-plugin',
        },
      ],
    };

    const result = await migrateCapabilitiesV1ToV2(tempDir, v1, skillsSource);

    const pluginSkill = result.capabilities.find((c) => c.id === 'tech-writing' && c.pluginId === 'legacy-plugin');
    assert.equal(
      pluginSkill?.mountPaths,
      undefined,
      'legacy plugin-owned skills should keep implicit mount policy until plugin lifecycle updates them',
    );
  });

  test('directory-level provider skill symlink → mountPaths populated for source skills', async () => {
    const claudeRoot = join(tempDir, '.claude');
    await mkdir(claudeRoot, { recursive: true });
    await symlink(relative(claudeRoot, skillsSource), join(claudeRoot, 'skills'));

    const v1 = {
      version: 1,
      capabilities: [
        { id: 'tech-writing', type: 'skill', enabled: true, source: 'cat-cafe' },
        { id: 'tdd', type: 'skill', enabled: true, source: 'cat-cafe' },
      ],
    };
    const result = await migrateCapabilitiesV1ToV2(tempDir, v1, skillsSource);

    const tw = result.capabilities.find((c) => c.id === 'tech-writing');
    assert.deepEqual(tw.mountPaths, ['claude'], 'directory-level claude skill mount should cover tech-writing');
    const tdd = result.capabilities.find((c) => c.id === 'tdd');
    assert.deepEqual(tdd.mountPaths, ['claude'], 'directory-level claude skill mount should cover tdd');
  });

  test('skill symlink outside skills source with matching prefix → not treated as managed', async () => {
    const claudeSkills = join(tempDir, '.claude', 'skills');
    const backupSkill = join(tempDir, 'cat-cafe-skills-backup', 'tech-writing');
    await mkdir(claudeSkills, { recursive: true });
    await mkdir(backupSkill, { recursive: true });
    await writeFile(join(backupSkill, 'SKILL.md'), '---\ncategory: backup\n---');
    await symlink(relative(claudeSkills, backupSkill), join(claudeSkills, 'tech-writing'));

    const v1 = {
      version: 1,
      capabilities: [{ id: 'tech-writing', type: 'skill', enabled: true, source: 'cat-cafe' }],
    };
    const result = await migrateCapabilitiesV1ToV2(tempDir, v1, skillsSource);

    const tw = result.capabilities.find((c) => c.id === 'tech-writing');
    assert.deepEqual(tw.mountPaths, [], 'prefix-adjacent symlink should remain user-owned');
  });

  test('skill with mountPaths already set → not overwritten', async () => {
    const v1 = {
      version: 1,
      capabilities: [{ id: 'tech-writing', type: 'skill', enabled: true, source: 'cat-cafe', mountPaths: ['gemini'] }],
    };
    const result = await migrateCapabilitiesV1ToV2(tempDir, v1, skillsSource);
    const tw = result.capabilities.find((c) => c.id === 'tech-writing');
    assert.deepEqual(tw.mountPaths, ['gemini'], 'existing mountPaths should be preserved');
  });

  test('disabled skill → mountPaths set to [] regardless of stale symlinks', async () => {
    // Even if stale symlinks exist, disabled skills should not backfill mountPaths
    const claudeSkills = join(tempDir, '.claude', 'skills');
    await mkdir(claudeSkills, { recursive: true });
    await symlink(relative(claudeSkills, join(skillsSource, 'tdd')), join(claudeSkills, 'tdd'));

    const v1 = {
      version: 1,
      capabilities: [{ id: 'tdd', type: 'skill', enabled: false, source: 'cat-cafe' }],
    };
    const result = await migrateCapabilitiesV1ToV2(tempDir, v1, skillsSource);
    const tdd = result.capabilities.find((c) => c.id === 'tdd');
    assert.deepEqual(tdd.mountPaths, [], 'disabled skill must not backfill mountPaths from stale symlinks');
    assert.equal(tdd.enabled, false, 'enabled must stay false');
  });

  test('wrong-skill symlink under same source → not accepted as valid mount (maintainer P1)', async () => {
    // Scenario: .claude/skills/tech-writing -> cat-cafe-skills/tdd (wrong skill)
    const claudeSkills = join(tempDir, '.claude', 'skills');
    await mkdir(claudeSkills, { recursive: true });
    await symlink(relative(claudeSkills, join(skillsSource, 'tdd')), join(claudeSkills, 'tech-writing'));

    const v1 = {
      version: 1,
      capabilities: [{ id: 'tech-writing', type: 'skill', enabled: true, source: 'cat-cafe' }],
    };
    const result = await migrateCapabilitiesV1ToV2(tempDir, v1, skillsSource);
    const tw = result.capabilities.find((c) => c.id === 'tech-writing');
    assert.deepEqual(tw.mountPaths, [], 'wrong-skill symlink must not be recorded as a valid mount');
  });

  test('MCP entries not given mountPaths', async () => {
    const v1 = {
      version: 1,
      capabilities: [{ id: 'cat-cafe-collab', type: 'mcp', enabled: true, source: 'cat-cafe' }],
    };
    const result = await migrateCapabilitiesV1ToV2(tempDir, v1, skillsSource);
    const mcp = result.capabilities.find((c) => c.id === 'cat-cafe-collab');
    assert.equal(mcp.mountPaths, undefined, 'MCP entries should not get mountPaths');
  });
});
