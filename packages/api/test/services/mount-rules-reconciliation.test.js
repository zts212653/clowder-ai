/**
 * F228: mountPaths state-record model — prune + restore through reconciliation.
 *
 * Tests the prune and restore behavior through the exported
 * reconcileSkillMountsAfterRuleChange (internal helpers are not exported).
 *
 * Scenarios covered:
 *   - Scenario 8/10: mount point disable → prune from all skills' mountPaths
 *   - Scenario 9/11: mount point re-enable → restore to all enabled skills' mountPaths
 *   - Edge: prune to empty when all mount points disabled (skill stays enabled:true)
 *   - Edge: restore only adds standard mount points, not custom ones
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { DEFAULT_MOUNT_RULES } from '@cat-cafe/shared';

import {
  readCapabilitiesConfig,
  writeCapabilitiesConfig,
} from '../../dist/config/capabilities/capability-orchestrator.js';
import { reconcileSkillMountsAfterRuleChange } from '../../dist/services/mount-rules-reconciliation.js';

let tempDir;
let projectDir;
let skillsSource;
let pluginsDir;

async function makeSkillSource(name) {
  await mkdir(join(skillsSource, name), { recursive: true });
  await writeFile(join(skillsSource, name, 'SKILL.md'), `# ${name}`);
}

async function mountSkillSymlink(providerPath, skillName) {
  const linkDir = join(projectDir, providerPath);
  await mkdir(linkDir, { recursive: true });
  // Use relative path so isManagedCatCafeSkillSymlink recognizes it
  const target = relative(linkDir, join(skillsSource, skillName));
  await symlink(target, join(linkDir, skillName));
}

describe('mount-rules-reconciliation prune + restore (F228 state-record)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mount-rules-prune-'));
    projectDir = tempDir;
    skillsSource = join(tempDir, 'cat-cafe-skills');
    pluginsDir = join(tempDir, 'plugins');
    await mkdir(skillsSource, { recursive: true });
    await mkdir(pluginsDir, { recursive: true });
    // Set env so resolveCatCafeSkillsSource finds our test source
    process.env.CAT_CAFE_SKILLS_SOURCE = skillsSource;
  });

  afterEach(async () => {
    delete process.env.CAT_CAFE_SKILLS_SOURCE;
    await rm(tempDir, { recursive: true, force: true });
  });

  test('pruneCapabilityMountPaths prunes to empty when all mount points disabled (F228 state-record)', async () => {
    await makeSkillSource('debugging');
    // Skill is enabled with claude mount
    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [
        {
          id: 'debugging',
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          mountPaths: ['claude'],
        },
      ],
    });
    await mountSkillSymlink('.claude/skills', 'debugging');

    const previousRules = {
      ...DEFAULT_MOUNT_RULES,
      providers: {
        claude: { enabled: true, path: '.claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };
    // Disable claude — now no mount points are mountable
    const nextRules = {
      ...DEFAULT_MOUNT_RULES,
      providers: {
        claude: { enabled: false, path: '.claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };

    await reconcileSkillMountsAfterRuleChange(projectDir, previousRules, nextRules, pluginsDir);

    const config = await readCapabilitiesConfig(projectDir);
    const cap = config?.capabilities.find((c) => c.id === 'debugging');
    assert.ok(cap, 'debugging capability should still exist');
    // F228: mountPaths = faithful record of current state.
    // When all mount points are disabled, mountPaths prunes to [].
    // The skill stays enabled:true (not disabled by user/cascade).
    // When mount points are re-enabled, the restore logic adds them back.
    assert.equal(cap.enabled, true, 'enabled should remain true — mount point disable ≠ skill disable');
    assert.deepStrictEqual(cap.mountPaths, [], 'mountPaths should prune to empty when all mount points are disabled');
  });

  test('restoreNewlyEnabledMountPoints adds re-enabled standard mount point to all enabled skills (F228 scenario 9)', async () => {
    // Use synthetic skill names that don't exist in the real cat-cafe-skills source.
    // This way reconciliation's mount loop skips symlink creation (skill not in source),
    // and we test only the config-level restore logic (the important part).
    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [
        {
          id: 'test-restore-skill-a',
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          mountPaths: ['claude'],
        },
        {
          id: 'test-restore-skill-b',
          type: 'skill',
          enabled: false,
          source: 'cat-cafe',
          mountPaths: [],
        },
      ],
    });

    // Previous: only claude enabled. Next: claude + codex enabled
    const previousRules = {
      ...DEFAULT_MOUNT_RULES,
      providers: {
        claude: { enabled: true, path: '.claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };
    const nextRules = {
      ...DEFAULT_MOUNT_RULES,
      providers: {
        claude: { enabled: true, path: '.claude/skills' },
        codex: { enabled: true, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };

    await reconcileSkillMountsAfterRuleChange(projectDir, previousRules, nextRules, pluginsDir);

    const config = await readCapabilitiesConfig(projectDir);
    const skillA = config?.capabilities.find((c) => c.id === 'test-restore-skill-a');
    const skillB = config?.capabilities.find((c) => c.id === 'test-restore-skill-b');

    // Enabled skill gets the newly-enabled mount point added
    assert.deepStrictEqual(
      skillA?.mountPaths,
      ['claude', 'codex'],
      'enabled skill must gain newly-enabled mount point',
    );
    assert.equal(skillA?.enabled, true);

    // Disabled skill does NOT get the mount point added
    assert.deepStrictEqual(skillB?.mountPaths, [], 'disabled skill must not gain mount points');
    assert.equal(skillB?.enabled, false);
  });

  test('restoreNewlyEnabledMountPoints does not add custom paths (F228 standard-only restore)', async () => {
    await writeCapabilitiesConfig(projectDir, {
      version: 2,
      capabilities: [
        {
          id: 'test-custom-path-skill',
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          mountPaths: ['claude'],
        },
      ],
    });

    // Previous: claude only. Next: claude + custom-client
    const previousRules = {
      ...DEFAULT_MOUNT_RULES,
      providers: {
        claude: { enabled: true, path: '.claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };
    const nextRules = {
      ...DEFAULT_MOUNT_RULES,
      providers: {
        claude: { enabled: true, path: '.claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
      customPaths: [{ id: 'custom-client', path: '.custom-client/skills', enabled: true }],
    };

    await reconcileSkillMountsAfterRuleChange(projectDir, previousRules, nextRules, pluginsDir);

    const config = await readCapabilitiesConfig(projectDir);
    const skill = config?.capabilities.find((c) => c.id === 'test-custom-path-skill');

    // Custom path should NOT be auto-added — only standard provider IDs are restored
    assert.deepStrictEqual(
      skill?.mountPaths,
      ['claude'],
      'custom mount points must not be auto-added to existing skills',
    );
  });
});
