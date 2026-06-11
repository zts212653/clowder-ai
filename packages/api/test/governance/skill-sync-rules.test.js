/**
 * F228 Phase 1.5 — Skill Sync with MountRules
 *
 * Verifies that syncSkills and resolveConflict honor the MountRules
 * `providers[id].enabled` flag: disabled standard providers must not
 * receive symlinks; enabled ones behave as before.
 */

import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { DEFAULT_MOUNT_RULES } from '@cat-cafe/shared';
import {
  readCapabilitiesConfig,
  writeCapabilitiesConfig,
} from '../../dist/config/capabilities/capability-orchestrator.js';
import { resolveConflict, syncSkills } from '../../dist/config/governance/skill-sync.js';

let tempDir;
let projectRoot;
let skillsSource;

async function pathExists(p) {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

describe('Skill Sync — MountRules-driven provider selection (F228)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-sync-rules-'));
    projectRoot = join(tempDir, 'project');
    skillsSource = join(tempDir, 'cat-cafe-skills');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(join(skillsSource, 'tdd'), { recursive: true });
    await writeFile(join(skillsSource, 'tdd', 'SKILL.md'), '# TDD');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('syncSkills with DEFAULT rules creates symlink in all 4 standard provider dirs', async () => {
    await syncSkills(projectRoot, skillsSource);
    for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
      const link = join(projectRoot, `.${provider}`, 'skills', 'tdd');
      assert.ok(await pathExists(link), `${provider} symlink should exist`);
    }
  });

  test('syncSkills with kimi disabled skips .kimi/skills dir', async () => {
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      providers: {
        ...DEFAULT_MOUNT_RULES.providers,
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };
    await syncSkills(projectRoot, skillsSource, rules);
    assert.ok(await pathExists(join(projectRoot, '.claude/skills/tdd')));
    assert.ok(await pathExists(join(projectRoot, '.codex/skills/tdd')));
    assert.ok(await pathExists(join(projectRoot, '.gemini/skills/tdd')));
    assert.equal(await pathExists(join(projectRoot, '.kimi/skills')), false, 'kimi dir must not be created');
  });

  test('syncSkills mounts configured custom paths even when standard providers are disabled', async () => {
    const customDir = join(tempDir, 'custom-client', 'skills');
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      providers: Object.fromEntries(
        Object.entries(DEFAULT_MOUNT_RULES.providers).map(([id, provider]) => [id, { ...provider, enabled: false }]),
      ),
      customPaths: [{ alias: 'acp', path: customDir }],
    };

    await syncSkills(projectRoot, skillsSource, rules);

    assert.ok(await pathExists(join(customDir, 'tdd')), 'custom provider dir should receive managed skill symlink');
    assert.equal(
      await pathExists(join(projectRoot, '.claude/skills')),
      false,
      'disabled standard dirs must remain untouched',
    );
  });

  test('syncSkills skips disabled provider legacy roots during disabled-skill conversion', async () => {
    await mkdir(join(skillsSource, 'debugging'), { recursive: true });
    await writeFile(join(skillsSource, 'debugging', 'SKILL.md'), '# Debugging');
    await mkdir(join(projectRoot, '.claude'), { recursive: true });
    await mkdir(join(projectRoot, '.kimi'), { recursive: true });
    const claudeRoot = join(projectRoot, '.claude/skills');
    const kimiRoot = join(projectRoot, '.kimi/skills');
    await symlink(skillsSource, claudeRoot);
    await symlink(skillsSource, kimiRoot);

    const rules = {
      ...DEFAULT_MOUNT_RULES,
      providers: {
        ...DEFAULT_MOUNT_RULES.providers,
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };

    await syncSkills(projectRoot, skillsSource, rules, { disabledSkills: ['tdd'] });

    const claudeStat = await lstat(claudeRoot);
    assert.equal(claudeStat.isDirectory(), true, 'enabled provider legacy root should still be converted');
    assert.equal(claudeStat.isSymbolicLink(), false, 'enabled provider root symlink should be removed');
    assert.ok(await pathExists(join(claudeRoot, 'debugging')), 'enabled provider should mount non-disabled skills');
    assert.equal(await pathExists(join(claudeRoot, 'tdd')), false, 'enabled provider should not mount disabled skill');

    const kimiStat = await lstat(kimiRoot);
    assert.equal(kimiStat.isSymbolicLink(), true, 'disabled provider root symlink should remain untouched');
    assert.equal(await readlink(kimiRoot), skillsSource, 'disabled provider root must not be converted');
  });

  test('syncSkills preserves stale disabled-provider symlinks for later cleanup', async () => {
    await mkdir(join(skillsSource, 'old-skill'), { recursive: true });
    await writeFile(join(skillsSource, 'old-skill', 'SKILL.md'), '# Old Skill');
    await syncSkills(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    await rm(join(skillsSource, 'old-skill'), { recursive: true, force: true });

    const kimiDisabled = {
      ...DEFAULT_MOUNT_RULES,
      providers: {
        ...DEFAULT_MOUNT_RULES.providers,
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };
    await syncSkills(projectRoot, skillsSource, kimiDisabled);

    assert.ok(
      await pathExists(join(projectRoot, '.kimi/skills/old-skill')),
      'disabled provider stale symlink remains until the provider is enabled again',
    );
    let config = await readCapabilitiesConfig(projectRoot);
    assert.ok(
      config?.capabilities.some((cap) => cap.type === 'skill' && cap.id === 'old-skill'),
      'source-deleted skill policy should be retained while a disabled-provider stale link still needs cleanup',
    );

    await syncSkills(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);

    assert.equal(
      await pathExists(join(projectRoot, '.kimi/skills/old-skill')),
      false,
      're-enabled provider should remove stale symlink from the previous managed set',
    );
    config = await readCapabilitiesConfig(projectRoot);
    assert.equal(
      config?.capabilities.some((cap) => cap.type === 'skill' && cap.id === 'old-skill'),
      false,
      'source-deleted skill policy should be pruned after deferred stale links are cleaned',
    );
  });

  test('syncSkills with only claude enabled creates exactly one provider dir', async () => {
    const rules = {
      version: 1,
      providers: {
        claude: { enabled: true, path: '.claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
      customPaths: [],
    };
    await syncSkills(projectRoot, skillsSource, rules);
    assert.ok(await pathExists(join(projectRoot, '.claude/skills/tdd')));
    for (const provider of ['codex', 'gemini', 'kimi']) {
      assert.equal(await pathExists(join(projectRoot, `.${provider}`)), false, `${provider} dir must not be created`);
    }
  });

  test('syncSkills preserves per-skill mountPaths during source sync', async () => {
    await writeCapabilitiesConfig(projectRoot, {
      version: 2,
      capabilities: [
        {
          id: 'tdd',
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          mountPaths: ['claude'],
        },
      ],
    });
    await mkdir(join(projectRoot, '.codex/skills'), { recursive: true });
    await symlink(join(skillsSource, 'tdd'), join(projectRoot, '.codex/skills/tdd'));

    await syncSkills(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);

    assert.ok(await pathExists(join(projectRoot, '.claude/skills/tdd')), 'declared provider should stay mounted');
    for (const provider of ['codex', 'gemini', 'kimi']) {
      assert.equal(
        await pathExists(join(projectRoot, `.${provider}/skills/tdd`)),
        false,
        `${provider} must not be mounted outside tdd.mountPaths`,
      );
    }
    const config = await readCapabilitiesConfig(projectRoot);
    const tdd = config?.capabilities.find((cap) => cap.type === 'skill' && cap.id === 'tdd');
    assert.deepStrictEqual(tdd?.mountPaths, ['claude']);
  });

  test('syncSkills persists globally disabled source skills without a local project entry', async () => {
    await syncSkills(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, { globalDisabledSkills: ['tdd'] });

    for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
      assert.equal(
        await pathExists(join(projectRoot, `.${provider}/skills/tdd`)),
        false,
        `${provider} must not mount a globally disabled source skill`,
      );
    }

    const config = await readCapabilitiesConfig(projectRoot);
    const tdd = config?.capabilities.find((cap) => cap.type === 'skill' && cap.id === 'tdd');
    assert.ok(tdd, 'globally disabled source skill should be persisted as an intentional disabled policy');
    assert.equal(tdd.enabled, false, 'globally disabled source skill must be disabled in project policy');
    assert.deepStrictEqual(tdd.mountPaths, [], 'globally disabled source skill must persist empty mountPaths');
  });

  test('syncSkills preserves project-level enable when globally disabled (project-local authority)', async () => {
    // F228: Project-local policy is authoritative. When the project has explicitly
    // configured a skill (enabled=true), global disable does NOT cascade during sync —
    // the project's decision takes precedence. The global cascade is a default, not
    // a hard constraint.
    await writeCapabilitiesConfig(projectRoot, {
      version: 2,
      capabilities: [
        {
          id: 'tdd',
          type: 'skill',
          source: 'cat-cafe',
          enabled: true,
          mountPaths: ['claude', 'codex', 'gemini', 'kimi'],
        },
      ],
    });

    await syncSkills(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, { globalDisabledSkills: ['tdd'] });

    // Project-local enable preserved — symlinks stay mounted
    for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
      assert.ok(
        await pathExists(join(projectRoot, `.${provider}/skills/tdd`)),
        `${provider} must remain mounted when project explicitly enabled the skill`,
      );
    }

    // Capabilities entry must remain enabled
    const config = await readCapabilitiesConfig(projectRoot);
    const tdd = config?.capabilities.find((cap) => cap.type === 'skill' && cap.id === 'tdd');
    assert.ok(tdd, 'entry should still exist');
    assert.equal(tdd.enabled, true, 'project-local enable must be preserved over global cascade');
    assert.deepStrictEqual(tdd.mountPaths, ['claude', 'codex', 'gemini', 'kimi']);
  });

  test('syncSkills inherits global mountPaths when project has no local skill policy', async () => {
    await syncSkills(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {
      globalMountPathsBySkill: new Map([['tdd', ['claude']]]),
    });

    assert.ok(await pathExists(join(projectRoot, '.claude/skills/tdd')), 'global allowed provider should mount');
    for (const provider of ['codex', 'gemini', 'kimi']) {
      assert.equal(
        await pathExists(join(projectRoot, `.${provider}/skills/tdd`)),
        false,
        `${provider} must not mount outside global mountPaths`,
      );
    }
    const config = await readCapabilitiesConfig(projectRoot);
    const tdd = config?.capabilities.find((cap) => cap.type === 'skill' && cap.id === 'tdd');
    assert.deepStrictEqual(tdd?.mountPaths, ['claude']);
  });

  test('syncSkills preserves project mountPaths even when broader than global (project-local authority)', async () => {
    // F228: Project-local mountPaths is authoritative — global mountPaths is only
    // a fallback when the project has no local policy. When the project explicitly
    // declares mountPaths: ['claude', 'codex'], that takes precedence even if the
    // global policy only says ['claude'].
    await writeCapabilitiesConfig(projectRoot, {
      version: 2,
      capabilities: [
        {
          id: 'tdd',
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          mountPaths: ['claude', 'codex'],
        },
      ],
    });
    await mkdir(join(projectRoot, '.codex/skills'), { recursive: true });
    await symlink(join(skillsSource, 'tdd'), join(projectRoot, '.codex/skills/tdd'));

    await syncSkills(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {
      globalMountPathsBySkill: new Map([['tdd', ['claude']]]),
    });

    assert.ok(await pathExists(join(projectRoot, '.claude/skills/tdd')), 'declared provider should stay mounted');
    assert.ok(
      await pathExists(join(projectRoot, '.codex/skills/tdd')),
      'project-local codex mount must be preserved — project policy is authoritative over global cascade',
    );
    const config = await readCapabilitiesConfig(projectRoot);
    const tdd = config?.capabilities.find((cap) => cap.type === 'skill' && cap.id === 'tdd');
    assert.deepStrictEqual(tdd?.mountPaths, ['claude', 'codex']);
  });

  test('syncSkills re-enables cascade-disabled skill when global re-enables (P1-1 regression)', async () => {
    // Step 1: Sync with global disabled — tdd cascade-disabled
    await syncSkills(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, { globalDisabledSkills: ['tdd'] });

    let config = await readCapabilitiesConfig(projectRoot);
    let tdd = config?.capabilities.find((cap) => cap.type === 'skill' && cap.id === 'tdd');
    assert.equal(tdd?.enabled, false, 'cascade-disabled skill must be disabled after first sync');
    assert.deepStrictEqual(tdd?.mountPaths, [], 'cascade-disabled skill must have empty mountPaths');
    for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
      assert.equal(await pathExists(join(projectRoot, `.${provider}/skills/tdd`)), false);
    }

    // Step 2: Sync WITHOUT global disabled — global re-enables tdd
    await syncSkills(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);

    for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
      assert.ok(
        await pathExists(join(projectRoot, `.${provider}/skills/tdd`)),
        `${provider} symlink must be created after global re-enable`,
      );
    }
    config = await readCapabilitiesConfig(projectRoot);
    tdd = config?.capabilities.find((cap) => cap.type === 'skill' && cap.id === 'tdd');
    assert.equal(tdd?.enabled, true, 'cascade-disabled skill must re-enable when global re-enables');
    // F228: cascade re-enable writes explicit list of all available mount points.
    assert.deepStrictEqual(
      tdd?.mountPaths,
      ['claude', 'codex', 'gemini', 'kimi'],
      'cascade re-enable must write all available mount points',
    );
  });

  test('syncSkills preserves user re-enable over cascade on next sync with global still disabled', async () => {
    // Step 1: Global disables tdd (cascade)
    await syncSkills(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, { globalDisabledSkills: ['tdd'] });

    // Step 2: User explicitly re-enables tdd in project config
    const config1 = await readCapabilitiesConfig(projectRoot);
    const cap1 = config1?.capabilities.find((c) => c.type === 'skill' && c.id === 'tdd');
    cap1.enabled = true;
    cap1.mountPaths = ['claude', 'codex', 'gemini', 'kimi'];
    await writeCapabilitiesConfig(projectRoot, config1);
    // Create the symlinks that would exist after user enable
    for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
      await mkdir(join(projectRoot, `.${provider}/skills`), { recursive: true });
      const link = join(projectRoot, `.${provider}/skills/tdd`);
      if (!(await pathExists(link))) {
        await symlink(join(skillsSource, 'tdd'), link);
      }
    }

    // Step 3: Sync again with global still disabled — user's re-enable must survive
    await syncSkills(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, { globalDisabledSkills: ['tdd'] });

    for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
      assert.ok(
        await pathExists(join(projectRoot, `.${provider}/skills/tdd`)),
        `${provider} must remain mounted — user explicitly re-enabled over cascade`,
      );
    }
    const config2 = await readCapabilitiesConfig(projectRoot);
    const tdd2 = config2?.capabilities.find((c) => c.type === 'skill' && c.id === 'tdd');
    assert.equal(tdd2?.enabled, true, 'user re-enable must be preserved even with global still disabled');
  });

  test('resolveConflict honors disabled provider — leaves disabled user-level symlink untouched', async () => {
    const home = join(tempDir, 'home');
    await mkdir(join(home, '.kimi/skills'), { recursive: true });
    await mkdir(join(home, '.claude/skills'), { recursive: true });
    // pre-existing user symlinks across both providers
    await symlink(join(skillsSource, 'tdd'), join(home, '.kimi/skills/tdd'));
    await symlink(join(skillsSource, 'tdd'), join(home, '.claude/skills/tdd'));

    const rules = {
      ...DEFAULT_MOUNT_RULES,
      providers: {
        ...DEFAULT_MOUNT_RULES.providers,
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };
    await resolveConflict(projectRoot, home, 'tdd', 'official', rules);

    assert.equal(
      await pathExists(join(home, '.claude/skills/tdd')),
      false,
      'enabled provider symlink should be removed by official choice',
    );
    assert.ok(await pathExists(join(home, '.kimi/skills/tdd')), 'disabled provider symlink should remain untouched');
  });

  test('resolveConflict official removes canonical home path when project provider path is customized', async () => {
    const home = join(tempDir, 'home');
    const canonicalHomeLink = join(home, '.claude/skills/tdd');
    const projectPathDecoyHomeLink = join(home, '.project-claude/skills/tdd');
    await mkdir(join(home, '.claude/skills'), { recursive: true });
    await mkdir(join(home, '.project-claude/skills'), { recursive: true });
    await symlink(join(skillsSource, 'tdd'), canonicalHomeLink);
    await symlink(join(skillsSource, 'tdd'), projectPathDecoyHomeLink);

    const rules = {
      version: 1,
      providers: {
        claude: { enabled: true, path: '.project-claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
      customPaths: [],
    };

    await resolveConflict(projectRoot, home, 'tdd', 'official', rules);

    assert.equal(
      await pathExists(canonicalHomeLink),
      false,
      'official choice should remove the real user-level provider path',
    );
    assert.ok(
      await pathExists(projectPathDecoyHomeLink),
      'official choice must not treat project custom mount paths as HOME-level provider paths',
    );
  });
});
