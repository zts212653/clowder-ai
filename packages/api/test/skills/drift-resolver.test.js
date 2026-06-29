import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { DEFAULT_MOUNT_RULES } from '@cat-cafe/shared';
import {
  readCapabilitiesConfig,
  withCapabilityLock,
  writeCapabilitiesConfig,
} from '../../dist/config/capabilities/capability-orchestrator.js';
import { checkGlobal } from '../../dist/skills/drift-detector.js';
import { syncDrift } from '../../dist/skills/drift-resolver.js';
import { syncProject } from '../../dist/skills/skill-sync-engine.js';
import { checkStaleness, listSourceSkillNames } from '../../dist/utils/skill-source.js';

/**
 * Test helper: wraps checkGlobal for mount-level drift detection.
 * Assumes all source skills are registered and mount to all enabled providers.
 */
async function checkMount(projectRoot, skillsSource, mountRules, opts = {}) {
  const sourceNames = await listSourceSkillNames(skillsSource);
  const disabled = new Set(opts.disabledSkills ?? []);
  const enabledProviderIds = Object.entries(mountRules.mountPoints)
    .filter(([, v]) => v.enabled)
    .map(([k]) => k);
  const customIds = (mountRules.customPaths ?? []).map((p) => p.alias);
  const allProviderIds = [...enabledProviderIds, ...customIds];
  const skillMountPaths = {};
  for (const name of sourceNames) {
    if (disabled.has(name)) continue;
    skillMountPaths[name] = opts.skillMountPaths?.[name] ?? allProviderIds;
  }
  return checkGlobal(projectRoot, skillsSource, mountRules, {
    globalConfigSkills: new Set(sourceNames),
    disabledSkills: opts.disabledSkills ?? [],
    skillMountPaths,
    platformName: opts.platformName,
  });
}

// F228 compat wrapper: new syncDrift takes a pre-computed DriftResult.
async function syncDriftCompat(projectRoot, skillsSource, mountRules, _conflictChoices, opts) {
  const drift = await checkMount(projectRoot, skillsSource, mountRules, opts);
  return syncDrift(projectRoot, skillsSource, mountRules, drift, opts);
}

let tempDir;
let projectRoot;
let skillsSource;

async function makeSkill(name) {
  await mkdir(join(skillsSource, name), { recursive: true });
  await writeFile(join(skillsSource, name, 'SKILL.md'), `# ${name}`);
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

function expectedSymlinkTarget(linkPath, sourcePath) {
  return process.platform === 'win32' ? sourcePath : relative(dirname(linkPath), sourcePath);
}

describe('DriftResolver (F228 Phase 2B)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'drift-resolver-'));
    projectRoot = join(tempDir, 'project');
    skillsSource = join(tempDir, 'cat-cafe-skills');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(skillsSource, { recursive: true });
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('syncDrift mounts newSkills across all enabled providers', async () => {
    await makeSkill('tdd');
    const report = await syncDriftCompat(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});
    assert.deepEqual(report.mounted, ['tdd']);
    for (const p of ['claude', 'codex', 'gemini', 'kimi']) {
      assert.ok(await exists(join(projectRoot, `.${p}/skills/tdd`)));
    }
    // post-sync drift should be empty
    const after = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.deepEqual(after.newSkills, []);
  });

  test('syncDrift respects per-skill mountPaths when mounting new skills', async () => {
    await makeSkill('tdd');

    const report = await syncDriftCompat(
      projectRoot,
      skillsSource,
      DEFAULT_MOUNT_RULES,
      {},
      {
        skillMountPaths: { tdd: ['claude'] },
      },
    );

    assert.deepEqual(report.mounted, ['tdd']);
    const claudeLink = join(projectRoot, '.claude/skills/tdd');
    assert.equal(await readlink(claudeLink), expectedSymlinkTarget(claudeLink, join(skillsSource, 'tdd')));
    for (const provider of ['codex', 'gemini', 'kimi']) {
      assert.equal(
        await exists(join(projectRoot, `.${provider}/skills/tdd`)),
        false,
        `${provider} should not be remounted outside tdd.mountPaths`,
      );
    }

    const config = await readCapabilitiesConfig(projectRoot);
    const cap = config?.capabilities.find((entry) => entry.type === 'skill' && entry.id === 'tdd');
    assert.deepEqual(cap?.mountPaths, ['claude']);
    const after = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {
      skillMountPaths: { tdd: ['claude'] },
    });
    assert.deepEqual(after.newSkills, []);
  });

  test('syncDrift stale cleanup preserves allowed per-skill mountPaths', async () => {
    await makeSkill('tdd');
    const claudeLink = join(projectRoot, '.claude/skills/tdd');
    const codexLink = join(projectRoot, '.codex/skills/tdd');
    await Promise.all([
      mkdir(dirname(claudeLink), { recursive: true }),
      mkdir(dirname(codexLink), { recursive: true }),
    ]);
    await Promise.all([
      symlink(expectedSymlinkTarget(claudeLink, join(skillsSource, 'tdd')), claudeLink),
      symlink(expectedSymlinkTarget(codexLink, join(skillsSource, 'tdd')), codexLink),
    ]);

    const report = await syncDriftCompat(
      projectRoot,
      skillsSource,
      DEFAULT_MOUNT_RULES,
      {},
      { skillMountPaths: { tdd: ['claude'] } },
    );

    assert.deepEqual(report.unmounted, ['tdd']);
    assert.equal((await lstat(claudeLink)).isSymbolicLink(), true, 'allowed provider mount should be preserved');
    assert.equal(await readlink(claudeLink), expectedSymlinkTarget(claudeLink, join(skillsSource, 'tdd')));
    assert.equal(await exists(codexLink), false, 'out-of-policy managed provider mount should be removed');

    const config = await readCapabilitiesConfig(projectRoot);
    const cap = config?.capabilities.find((entry) => entry.type === 'skill' && entry.id === 'tdd');
    assert.deepEqual(cap?.mountPaths, ['claude']);
  });

  test('syncDrift converts legacy directory mount before provider-policy stale unmount', async () => {
    await makeSkill('tdd');
    const claudeLink = join(projectRoot, '.claude/skills/tdd');
    const codexSkills = join(projectRoot, '.codex/skills');
    const codexLink = join(codexSkills, 'tdd');
    await mkdir(dirname(claudeLink), { recursive: true });
    await symlink(expectedSymlinkTarget(claudeLink, join(skillsSource, 'tdd')), claudeLink);
    await mkdir(dirname(codexSkills), { recursive: true });
    await symlink(skillsSource, codexSkills);

    const report = await syncDriftCompat(
      projectRoot,
      skillsSource,
      DEFAULT_MOUNT_RULES,
      {},
      { skillMountPaths: { tdd: ['claude'] } },
    );

    assert.deepEqual(report.unmounted, ['tdd']);
    assert.equal((await lstat(claudeLink)).isSymbolicLink(), true, 'allowed provider mount should be preserved');
    assert.equal(await readlink(claudeLink), expectedSymlinkTarget(claudeLink, join(skillsSource, 'tdd')));
    const codexRootStat = await lstat(codexSkills);
    assert.equal(codexRootStat.isDirectory(), true, 'legacy root should be converted to a real provider dir');
    assert.equal(codexRootStat.isSymbolicLink(), false, 'legacy directory-level symlink should be removed');
    assert.equal(await exists(codexLink), false, 'out-of-policy skill should not remain loadable through legacy root');
    assert.equal(await exists(join(skillsSource, 'tdd/SKILL.md')), true, 'source skill must not be deleted');

    const after = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {
      skillMountPaths: { tdd: ['claude'] },
    });
    assert.deepEqual(after.stale, []);
  });

  test('syncDrift rolls back mounted new skills when final state write fails', async () => {
    await makeSkill('alpha');
    await writeFile(join(projectRoot, '.cat-cafe'), 'not a directory');

    await assert.rejects(() => syncDriftCompat(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {}));

    for (const p of ['claude', 'codex', 'gemini', 'kimi']) {
      assert.equal(
        await exists(join(projectRoot, `.${p}/skills/alpha`)),
        false,
        `${p} mount should be rolled back when sync does not complete`,
      );
    }
  });

  test('syncDrift unmounts stale symlinks', async () => {
    await makeSkill('tdd');
    // pre-create a stale managed symlink (skill not in source)
    await mkdir(join(projectRoot, '.claude/skills'), { recursive: true });
    await symlink(join(skillsSource, 'old-skill'), join(projectRoot, '.claude/skills/old-skill'));
    const report = await syncDriftCompat(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});
    assert.deepEqual(report.unmounted, ['old-skill']);
    assert.equal(await exists(join(projectRoot, '.claude/skills/old-skill')), false);
  });

  test('syncDrift overrides conflict when choice is "override"', async () => {
    await makeSkill('tdd');
    // pre-create user's own directory blocking the mount
    await mkdir(join(projectRoot, '.claude/skills/tdd'), { recursive: true });
    await writeFile(join(projectRoot, '.claude/skills/tdd/user.md'), 'user version');
    const report = await syncDriftCompat(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {
      'tdd:claude': 'override',
    });
    assert.deepEqual(report.overridden, ['tdd']);
    const stat = await lstat(join(projectRoot, '.claude/skills/tdd'));
    assert.equal(stat.isSymbolicLink(), true, 'user dir was replaced by managed symlink');
    const linkPath = join(projectRoot, '.claude/skills/tdd');
    assert.equal(await readlink(linkPath), expectedSymlinkTarget(linkPath, join(skillsSource, 'tdd')));
  });

  test('syncDrift override preserves blockers outside per-skill mountPaths', async () => {
    await makeSkill('tdd');
    await mkdir(join(projectRoot, '.claude/skills/tdd'), { recursive: true });
    await writeFile(join(projectRoot, '.claude/skills/tdd/user.md'), 'allowed-provider user version');
    await mkdir(join(projectRoot, '.codex/skills/tdd'), { recursive: true });
    await writeFile(join(projectRoot, '.codex/skills/tdd/user.md'), 'excluded-provider user version');

    const report = await syncDriftCompat(
      projectRoot,
      skillsSource,
      DEFAULT_MOUNT_RULES,
      { 'tdd:claude': 'override' },
      { skillMountPaths: { tdd: ['claude'] } },
    );

    assert.deepEqual(report.overridden, ['tdd']);
    const claudeLink = join(projectRoot, '.claude/skills/tdd');
    assert.equal((await lstat(claudeLink)).isSymbolicLink(), true, 'allowed provider conflict should be replaced');
    assert.equal(await readlink(claudeLink), expectedSymlinkTarget(claudeLink, join(skillsSource, 'tdd')));
    assert.equal(
      await exists(join(projectRoot, '.codex/skills/tdd/user.md')),
      true,
      'excluded provider user-owned skill path must be preserved',
    );
  });

  test('syncDrift overrides conflict (all conflicts are overridden)', async () => {
    await makeSkill('tdd');
    await mkdir(join(projectRoot, '.claude/skills/tdd'), { recursive: true });
    await writeFile(join(projectRoot, '.claude/skills/tdd/user.md'), 'user version');
    const report = await syncDriftCompat(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});
    assert.deepEqual(report.overridden, ['tdd']);
    // User's dir is replaced by managed symlink
    const stat = await lstat(join(projectRoot, '.claude/skills/tdd'));
    assert.equal(stat.isSymbolicLink(), true, 'user dir is replaced by managed symlink');
  });

  test('syncDrift respects disabledSkills — disabled skills are unmounted, not new-mounted', async () => {
    await makeSkill('tdd');
    await makeSkill('debugging');
    // Initial mount: both
    await syncDriftCompat(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});
    // Now disable debugging
    const report = await syncDriftCompat(
      projectRoot,
      skillsSource,
      DEFAULT_MOUNT_RULES,
      {},
      {
        disabledSkills: ['debugging'],
      },
    );
    assert.deepEqual(report.unmounted, ['debugging']);
    assert.deepEqual(report.mounted, []);
    assert.equal(await exists(join(projectRoot, '.claude/skills/debugging')), false);
    assert.ok(await exists(join(projectRoot, '.claude/skills/tdd')));
  });

  test('syncDrift converts legacy directory-level mount when a disabled skill is stale', async () => {
    await makeSkill('tdd');
    await makeSkill('debugging');
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        codex: { ...DEFAULT_MOUNT_RULES.mountPoints.codex, enabled: false },
        gemini: { ...DEFAULT_MOUNT_RULES.mountPoints.gemini, enabled: false },
        kimi: { ...DEFAULT_MOUNT_RULES.mountPoints.kimi, enabled: false },
      },
    };
    const claudeSkills = join(projectRoot, '.claude/skills');
    await mkdir(dirname(claudeSkills), { recursive: true });
    await symlink(skillsSource, claudeSkills);

    const report = await syncDriftCompat(projectRoot, skillsSource, rules, {}, { disabledSkills: ['debugging'] });

    assert.deepEqual(report.unmounted, ['debugging']);
    const rootStat = await lstat(claudeSkills);
    assert.equal(rootStat.isDirectory(), true, 'legacy root should be converted to a real provider dir');
    assert.equal(rootStat.isSymbolicLink(), false, 'legacy directory-level symlink should be removed');
    const tddLink = join(claudeSkills, 'tdd');
    assert.equal((await lstat(tddLink)).isSymbolicLink(), true, 'enabled skill should remain mounted');
    assert.equal(await readlink(tddLink), expectedSymlinkTarget(tddLink, join(skillsSource, 'tdd')));
    await assert.rejects(() => lstat(join(claudeSkills, 'debugging')), /ENOENT/);
    assert.equal(await exists(join(skillsSource, 'debugging/SKILL.md')), true, 'source skill must not be deleted');

    const after = await checkMount(projectRoot, skillsSource, rules, { disabledSkills: ['debugging'] });
    assert.deepEqual(after.newSkills, []);
    assert.deepEqual(after.conflicts, []);
    assert.deepEqual(after.stale, []);
  });

  test('syncDrift restores disabled-provider stale links when final state write fails', async () => {
    await makeSkill('debugging');
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        codex: { ...DEFAULT_MOUNT_RULES.mountPoints.codex, enabled: false },
        gemini: { ...DEFAULT_MOUNT_RULES.mountPoints.gemini, enabled: false },
        kimi: { ...DEFAULT_MOUNT_RULES.mountPoints.kimi, enabled: false },
      },
    };
    const claudeLink = join(projectRoot, '.claude/skills/debugging');
    const codexLink = join(projectRoot, '.codex/skills/debugging');
    await Promise.all([
      mkdir(dirname(claudeLink), { recursive: true }),
      mkdir(dirname(codexLink), { recursive: true }),
    ]);
    await Promise.all([
      symlink(expectedSymlinkTarget(claudeLink, join(skillsSource, 'debugging')), claudeLink),
      symlink(expectedSymlinkTarget(codexLink, join(skillsSource, 'debugging')), codexLink),
    ]);
    await writeFile(join(projectRoot, '.cat-cafe'), 'not a directory');

    await assert.rejects(() =>
      syncDriftCompat(projectRoot, skillsSource, rules, {}, { disabledSkills: ['debugging'] }),
    );

    assert.equal((await lstat(claudeLink)).isSymbolicLink(), true, 'enabled-provider link should be restored');
    assert.equal((await lstat(codexLink)).isSymbolicLink(), true, 'disabled-provider link should be restored');
  });

  test('syncDrift overrides all conflicts (multiple skills)', async () => {
    await makeSkill('a');
    await makeSkill('b');
    await mkdir(join(projectRoot, '.claude/skills/a'), { recursive: true });
    await mkdir(join(projectRoot, '.claude/skills/b'), { recursive: true });
    const report = await syncDriftCompat(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});
    assert.deepEqual(report.overridden, ['a', 'b']);
    const aStat = await lstat(join(projectRoot, '.claude/skills/a'));
    const bStat = await lstat(join(projectRoot, '.claude/skills/b'));
    assert.equal(aStat.isSymbolicLink(), true, 'conflict a should be overridden');
    assert.equal(bStat.isSymbolicLink(), true, 'conflict b should be overridden');
  });

  test('syncDrift override does not remove source skill through legacy directory-level mount', async () => {
    await makeSkill('tdd');
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        gemini: { ...DEFAULT_MOUNT_RULES.mountPoints.gemini, enabled: false },
        kimi: { ...DEFAULT_MOUNT_RULES.mountPoints.kimi, enabled: false },
      },
    };
    await mkdir(join(projectRoot, '.claude'), { recursive: true });
    await symlink(skillsSource, join(projectRoot, '.claude/skills'));
    await mkdir(join(projectRoot, '.codex/skills/tdd'), { recursive: true });
    await writeFile(join(projectRoot, '.codex/skills/tdd/local.md'), 'user version');

    const report = await syncDriftCompat(projectRoot, skillsSource, rules, { 'tdd:codex': 'override' });

    assert.deepEqual(report.overridden, ['tdd']);
    const sourceStat = await lstat(join(skillsSource, 'tdd'));
    assert.equal(sourceStat.isDirectory(), true, 'source skill directory must remain intact');
    assert.equal(await exists(join(skillsSource, 'tdd/SKILL.md')), true);
    const codexStat = await lstat(join(projectRoot, '.codex/skills/tdd'));
    assert.equal(codexStat.isSymbolicLink(), true, 'conflicting provider should still be remounted');
  });

  test('syncDrift override replaces invalid provider root symlink', async () => {
    await makeSkill('tdd');
    const missingSource = join(tempDir, 'missing-skills-source');
    await mkdir(join(projectRoot, '.claude'), { recursive: true });
    await symlink(missingSource, join(projectRoot, '.claude/skills'));

    const report = await syncDriftCompat(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, { 'tdd:claude': 'override' });

    assert.deepEqual(report.overridden, ['tdd']);
    for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
      const linkPath = join(projectRoot, `.${provider}/skills/tdd`);
      const stat = await lstat(linkPath);
      assert.equal(stat.isSymbolicLink(), true, `${provider} should be remounted`);
      assert.equal(await readlink(linkPath), expectedSymlinkTarget(linkPath, join(skillsSource, 'tdd')));
    }
    const after = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.deepEqual(after.newSkills, []);
    assert.deepEqual(after.conflicts, []);
    assert.deepEqual(after.stale, []);
  });

  test('syncDrift override replaces provider skills root file blocker', async () => {
    await makeSkill('tdd');
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        codex: { ...DEFAULT_MOUNT_RULES.mountPoints.codex, enabled: false },
        gemini: { ...DEFAULT_MOUNT_RULES.mountPoints.gemini, enabled: false },
        kimi: { ...DEFAULT_MOUNT_RULES.mountPoints.kimi, enabled: false },
      },
    };
    await mkdir(join(projectRoot, '.claude'), { recursive: true });
    await writeFile(join(projectRoot, '.claude/skills'), 'not a directory');

    const report = await syncDriftCompat(projectRoot, skillsSource, rules, { 'tdd:claude': 'override' });

    assert.deepEqual(report.overridden, ['tdd']);
    const linkPath = join(projectRoot, '.claude/skills/tdd');
    const stat = await lstat(linkPath);
    assert.equal(stat.isSymbolicLink(), true, 'provider root file should be replaced by a managed mount dir');
    assert.equal(await readlink(linkPath), expectedSymlinkTarget(linkPath, join(skillsSource, 'tdd')));
  });

  test('syncDrift override replaces custom mount path conflicts', async () => {
    await makeSkill('tdd');
    const customDir = join(projectRoot, 'custom-client', 'skills');
    await mkdir(join(customDir, 'tdd'), { recursive: true });
    await writeFile(join(customDir, 'tdd', 'local.md'), 'user version');
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: Object.fromEntries(
        Object.entries(DEFAULT_MOUNT_RULES.mountPoints).map(([id, provider]) => [id, { ...provider, enabled: false }]),
      ),
      customPaths: [{ alias: 'acp', path: customDir }],
    };

    const report = await syncDriftCompat(projectRoot, skillsSource, rules, { 'tdd:acp': 'override' });

    assert.deepEqual(report.overridden, ['tdd']);
    const linkPath = join(customDir, 'tdd');
    const stat = await lstat(linkPath);
    assert.equal(stat.isSymbolicLink(), true, 'custom conflict should be replaced by managed symlink');
    assert.equal(await readlink(linkPath), expectedSymlinkTarget(linkPath, join(skillsSource, 'tdd')));
    const after = await checkMount(projectRoot, skillsSource, rules);
    assert.deepEqual(after.newSkills, []);
    assert.deepEqual(after.conflicts, []);
    assert.deepEqual(after.stale, []);
  });

  test('syncDrift same skill conflicting in two providers — all overridden', async () => {
    await makeSkill('tdd');
    // Create user-owned blockers in both claude and codex
    await mkdir(join(projectRoot, '.claude/skills/tdd'), { recursive: true });
    await writeFile(join(projectRoot, '.claude/skills/tdd/user.md'), 'claude user version');
    await mkdir(join(projectRoot, '.codex/skills/tdd'), { recursive: true });
    await writeFile(join(projectRoot, '.codex/skills/tdd/user.md'), 'codex user version');

    // Detect drift — should report two separate conflicts
    const drift = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    const tddConflicts = drift.conflicts.filter((c) => c.skill === 'tdd');
    assert.ok(tddConflicts.length >= 2, 'should report per-provider conflicts');
    const providers = tddConflicts.map((c) => c.mountPointId);
    assert.ok(providers.includes('claude'), 'claude conflict should be reported');
    assert.ok(providers.includes('codex'), 'codex conflict should be reported');

    // All conflicts are overridden (no skip/override choice)
    const report = await syncDriftCompat(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});

    assert.deepEqual(report.overridden, ['tdd']);
    // Claude should be replaced by managed symlink
    const claudeStat = await lstat(join(projectRoot, '.claude/skills/tdd'));
    assert.equal(claudeStat.isSymbolicLink(), true, 'overridden claude should be managed symlink');
    // Codex should also be replaced by managed symlink
    const codexStat = await lstat(join(projectRoot, '.codex/skills/tdd'));
    assert.equal(codexStat.isSymbolicLink(), true, 'overridden codex should be managed symlink');
    // Gemini and kimi should also be mounted
    for (const provider of ['gemini', 'kimi']) {
      const linkPath = join(projectRoot, `.${provider}/skills/tdd`);
      assert.equal((await lstat(linkPath)).isSymbolicLink(), true, `${provider} should be auto-mounted`);
    }
  });

  test('syncDrift mounts all providers when conflict is overridden', async () => {
    await makeSkill('tdd');
    // Create a user-owned blocker only in claude (conflict).
    // codex/gemini/kimi are merely missing (no conflict).
    await mkdir(join(projectRoot, '.claude/skills/tdd'), { recursive: true });
    await writeFile(join(projectRoot, '.claude/skills/tdd/user.md'), 'user version');

    const drift = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    // tdd should appear in conflicts (claude) but NOT in newSkills
    assert.ok(drift.conflicts.some((c) => c.skill === 'tdd' && c.mountPointId === 'claude'));
    assert.ok(!drift.newSkills.includes('tdd'), 'detector suppresses newSkills when conflicts exist');

    // Override the claude conflict — all providers should be mounted
    const report = await syncDriftCompat(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});

    assert.ok(report.overridden.includes('tdd'), 'skill should be in overridden');
    // Claude user dir should be replaced by managed symlink
    assert.equal(
      (await lstat(join(projectRoot, '.claude/skills/tdd'))).isSymbolicLink(),
      true,
      'overridden claude should be a symlink',
    );
    // Non-conflicting providers should be mounted
    for (const provider of ['codex', 'gemini', 'kimi']) {
      const linkPath = join(projectRoot, `.${provider}/skills/tdd`);
      assert.equal(
        (await lstat(linkPath)).isSymbolicLink(),
        true,
        `non-conflicting ${provider} should be auto-mounted even when conflict is skipped`,
      );
    }
  });

  test('syncDrift rolls back custom mounted new skills when final state write fails', async () => {
    await makeSkill('alpha');
    const customDir = join(projectRoot, 'custom-client', 'skills');
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: Object.fromEntries(
        Object.entries(DEFAULT_MOUNT_RULES.mountPoints).map(([id, provider]) => [id, { ...provider, enabled: false }]),
      ),
      customPaths: [{ alias: 'acp', path: customDir }],
    };
    await writeFile(join(projectRoot, '.cat-cafe'), 'not a directory');

    await assert.rejects(() => syncDriftCompat(projectRoot, skillsSource, rules, {}));

    assert.equal(
      await exists(join(customDir, 'alpha')),
      false,
      'custom mount should be rolled back when sync does not complete',
    );
  });

  test('syncDrift updates capabilities.json#skillsSync so checkStaleness reports stale=false', async () => {
    await makeSkill('tdd');
    await makeSkill('debugging');

    // Before sync: no state file → checkStaleness reports stale
    const before = await checkStaleness(projectRoot, skillsSource);
    assert.equal(before.stale, true, 'should be stale before sync');

    await syncDriftCompat(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});

    // After sync: capabilities.json#skillsSync written → checkStaleness reports not stale
    const after = await checkStaleness(projectRoot, skillsSource);
    assert.equal(after.stale, false, 'should not be stale after sync');
    assert.deepEqual(after.newSkills, [], 'no new skills after sync');
    assert.deepEqual(after.removedSkills, [], 'no removed skills after sync');

    // Verify capabilities.json has v2 skill entries with source='cat-cafe'
    const config = await readCapabilitiesConfig(projectRoot);
    assert.ok(config, 'capabilities.json should exist after sync');
    assert.equal(config.version, 2, 'should be v2 config');
    const skillEntries = config.capabilities.filter((c) => c.type === 'skill' && c.source === 'cat-cafe');
    const managedNames = skillEntries.map((c) => c.id).sort();
    assert.deepEqual(managedNames, ['debugging', 'tdd']);
  });

  test('syncDrift removes Clowder AI capabilities for source-deleted stale skills', async () => {
    await makeSkill('tdd');
    await makeSkill('old-skill');
    await syncDriftCompat(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});

    await rm(join(skillsSource, 'old-skill'), { recursive: true, force: true });

    const report = await syncDriftCompat(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});

    assert.deepEqual(report.unmounted, ['old-skill']);
    const config = await readCapabilitiesConfig(projectRoot);
    assert.ok(config, 'capabilities.json should exist after drift sync');
    const managedIds = config.capabilities
      .filter((c) => c.type === 'skill' && c.source === 'cat-cafe')
      .map((c) => c.id)
      .sort();
    assert.deepEqual(managedIds, ['tdd'], 'source-deleted skill capability should be pruned');

    const after = await checkStaleness(projectRoot, skillsSource);
    assert.deepEqual(after.removedSkills, [], 'deleted skill should not remain as a phantom capability');
  });

  test('syncDrift disables stale capabilities when a managed source skill is policy-disabled', async () => {
    await makeSkill('tdd');
    await makeSkill('debugging');
    await syncDriftCompat(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});

    await syncDriftCompat(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {}, { disabledSkills: ['debugging'] });

    const config = await readCapabilitiesConfig(projectRoot);
    assert.ok(config, 'capabilities.json should exist after drift sync');
    const debugging = config.capabilities.find((c) => c.type === 'skill' && c.id === 'debugging');
    const tdd = config.capabilities.find((c) => c.type === 'skill' && c.id === 'tdd');
    assert.equal(debugging?.enabled, true, 'project-policy disabled skill must not change enabled');
    assert.equal(debugging?.globalEnabled, true, 'project-policy disabled skill must not change globalEnabled');
    assert.deepEqual(debugging?.mountPaths, [], 'project-policy disabled skill should have no mounts');
    assert.equal(tdd?.enabled, true, 'other managed skills should stay enabled');
    // F228: mountPaths = target mount policy.
    // No-policy skills get all available mount points written explicitly.
    assert.deepStrictEqual(
      tdd?.mountPaths,
      ['claude', 'codex', 'gemini', 'kimi'],
      'no-policy skill should list all available mount points',
    );
  });

  test('syncDrift does not disable same-id plugin capabilities for disabled source skills', async () => {
    await makeSkill('debugging');
    await syncDriftCompat(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});

    const before = await readCapabilitiesConfig(projectRoot);
    assert.ok(before, 'capabilities.json should exist before injecting plugin capability');
    before.capabilities.push({
      id: 'debugging',
      type: 'skill',
      source: 'cat-cafe',
      enabled: true,
      pluginId: 'same-id-plugin',
      mountPaths: ['claude'],
    });
    await writeCapabilitiesConfig(projectRoot, before);

    await syncDriftCompat(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {}, { disabledSkills: ['debugging'] });

    const after = await readCapabilitiesConfig(projectRoot);
    assert.ok(after, 'capabilities.json should exist after drift sync');
    const firstParty = after.capabilities.find(
      (cap) => cap.type === 'skill' && cap.id === 'debugging' && !cap.pluginId,
    );
    const pluginOwned = after.capabilities.find(
      (cap) => cap.type === 'skill' && cap.id === 'debugging' && cap.pluginId === 'same-id-plugin',
    );
    assert.equal(firstParty?.enabled, true, 'project-policy disabled source skill must not change enabled');
    assert.equal(firstParty?.globalEnabled, true, 'project-policy disabled source skill must not change globalEnabled');
    assert.deepEqual(firstParty?.mountPaths, [], 'disabled source skill should have no mounts');
    assert.equal(pluginOwned?.enabled, true, 'same-id plugin skill must keep its enabled state');
    assert.deepEqual(pluginOwned?.mountPaths, ['claude'], 'same-id plugin mount policy must be preserved');
  });

  test('syncProject with disabledSkills directly controls disabled state (F228 unconditional cascade)', async () => {
    await makeSkill('tdd');

    // Step 1: syncProject with tdd disabled (simulates global cascade disable — scenario 6)
    await syncProject(projectRoot, skillsSource, {
      mountRules: DEFAULT_MOUNT_RULES,
      disabledSkills: new Set(['tdd']),
    });
    let config = await readCapabilitiesConfig(projectRoot);
    let tdd = config?.capabilities.find((c) => c.type === 'skill' && c.id === 'tdd');
    assert.deepEqual(tdd?.mountPaths, [], 'tdd should have empty mountPaths after disable');

    // Step 2: syncProject with empty disabledSkills — global re-enables (scenario 7, unconditional)
    await syncProject(projectRoot, skillsSource, {
      mountRules: DEFAULT_MOUNT_RULES,
      disabledSkills: new Set(),
    });

    // tdd must re-enable — no cascade tracking needed, disabledSkills is authoritative
    for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
      assert.ok(
        await exists(join(projectRoot, `.${provider}/skills/tdd`)),
        `${provider} symlink must exist after global re-enable`,
      );
    }
    config = await readCapabilitiesConfig(projectRoot);
    tdd = config?.capabilities.find((c) => c.type === 'skill' && c.id === 'tdd');
    assert.ok(tdd?.mountPaths?.length > 0, 'tdd must have non-empty mountPaths after re-enable');
  });

  test('mergeSkillMountPolicies cascades global disabled to unconfigured project skills', async () => {
    const { mergeSkillMountPolicies } = await import('../../dist/routes/skills-drift.js');

    const projectPolicy = {
      disabledSkills: [],
      skillMountPaths: {},
      configuredSkills: new Set(),
    };
    const globalPolicy = {
      disabledSkills: ['tdd'],
      skillMountPaths: {},
      configuredSkills: new Set(['tdd']),
    };

    const merged = mergeSkillMountPolicies(projectPolicy, globalPolicy);

    // tdd is globally disabled and not configured in project → cascaded to disabled
    assert.ok(merged.disabledSkills.includes('tdd'), 'globally disabled skill must cascade to unconfigured project');
  });

  test('mergeSkillMountPolicies preserves project disabled even when global is enabled', async () => {
    const { mergeSkillMountPolicies } = await import('../../dist/routes/skills-drift.js');

    // Project has tdd disabled locally; global has tdd enabled
    const projectPolicy = {
      disabledSkills: ['tdd'],
      skillMountPaths: {},
      configuredSkills: new Set(['tdd']),
    };
    const globalPolicy = {
      disabledSkills: [],
      skillMountPaths: { tdd: ['claude', 'codex'] },
      configuredSkills: new Set(['tdd']),
    };

    const merged = mergeSkillMountPolicies(projectPolicy, globalPolicy);

    // In drift context: project's local disabled state is preserved (project config is truth for this project)
    assert.ok(merged.disabledSkills.includes('tdd'), 'project-disabled skill stays disabled in drift merge');
  });

  test('mergeSkillMountPolicies cascades global disabled to CONFIGURED project skills (P1-2 regression)', async () => {
    const { mergeSkillMountPolicies } = await import('../../dist/routes/skills-drift.js');

    // Project has tdd configured AND enabled; global disables it.
    // Per F228 scenarios 6/7: global disable is UNCONDITIONAL — must cascade
    // regardless of whether the project has configured that skill.
    // Regression: 97c522e6a2 introduced a configuredSkills.has() guard that
    // blocked cascade for configured skills; fixed in 70d78194c.
    const projectPolicy = {
      disabledSkills: [],
      skillMountPaths: { tdd: ['claude', 'codex'] },
      configuredSkills: new Set(['tdd']),
    };
    const globalPolicy = {
      disabledSkills: ['tdd'],
      skillMountPaths: {},
      configuredSkills: new Set(['tdd']),
    };

    const merged = mergeSkillMountPolicies(projectPolicy, globalPolicy);

    assert.ok(
      merged.disabledSkills.includes('tdd'),
      'globally disabled skill must cascade even when project has it configured and enabled',
    );
  });

  test('readCatCafeSkillMountPolicy treats non-empty mountPaths as desired mounts even with enabled:false (maintainer P1)', async () => {
    const { readCatCafeSkillMountPolicy } = await import('../../dist/routes/skills-drift.js');

    // Scenario: v1 migration or manual repair produces { enabled:false, mountPaths:['claude'] }
    const config = {
      version: 2,
      capabilities: [
        { id: 'debugging', type: 'skill', source: 'cat-cafe', enabled: false, mountPaths: ['claude'] },
        { id: 'tdd', type: 'skill', source: 'cat-cafe', enabled: true, mountPaths: [] },
        { id: 'review', type: 'skill', source: 'cat-cafe', enabled: false },
      ],
    };

    const policy = readCatCafeSkillMountPolicy(config);

    // debugging: non-empty mountPaths = desired mounts, NOT disabled
    assert.ok(!policy.disabledSkills.includes('debugging'), 'non-empty mountPaths must not be classified as disabled');
    assert.deepEqual(policy.skillMountPaths.debugging, ['claude'], 'mountPaths must be preserved');

    // tdd: empty mountPaths = disabled
    assert.ok(policy.disabledSkills.includes('tdd'), 'empty mountPaths must be classified as disabled');

    // review: no mountPaths + enabled:false = disabled
    assert.ok(policy.disabledSkills.includes('review'), 'no mountPaths + enabled:false must be disabled');
  });

  test('syncDrift includes overridden conflicts in managed capability entries', async () => {
    await makeSkill('managed');
    await makeSkill('user-owned');
    // Create a blocking user dir for user-owned skill
    await mkdir(join(projectRoot, '.claude/skills/user-owned'), { recursive: true });
    await writeFile(join(projectRoot, '.claude/skills/user-owned/local.md'), 'my version');

    const report = await syncDriftCompat(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});
    assert.ok(report.overridden.includes('user-owned'), 'user-owned conflict should be overridden');

    // Verify capabilities.json has both mounted and overridden skills as managed
    const config = await readCapabilitiesConfig(projectRoot);
    assert.ok(config, 'capabilities.json should exist');
    const managedIds = config.capabilities
      .filter((c) => c.type === 'skill' && c.source === 'cat-cafe')
      .map((c) => c.id);
    assert.ok(managedIds.includes('managed'), 'mounted skill should be in capabilities');
    assert.ok(managedIds.includes('user-owned'), 'overridden skill should be in capabilities');
    const userOwnedEntry = config.capabilities.find((c) => c.type === 'skill' && c.id === 'user-owned');
    assert.ok(userOwnedEntry, 'overridden skill should appear in config');
    assert.ok(userOwnedEntry.enabled !== false, 'overridden conflict must NOT disable the skill');
    const mp = userOwnedEntry.mountPaths ?? [];
    assert.ok(mp.length > 0, 'overridden skill should have mountPaths (all active providers)');
  });

  test('syncDrift preserves mountPaths for non-stale skills — prune is reconciliation job (F228 state-record)', async () => {
    await makeSkill('tdd');
    // Initial sync: tdd mounted to claude and kimi
    const partialRules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        claude: { enabled: true, path: '.claude/skills' },
        kimi: { enabled: true, path: '.kimi/skills' },
      },
    };
    await syncProject(projectRoot, skillsSource, {
      mountRules: partialRules,
      mountPathsBySkill: new Map([['tdd', ['claude', 'kimi']]]),
    });

    let config = await readCapabilitiesConfig(projectRoot);
    let tdd = config?.capabilities.find((c) => c.id === 'tdd');
    assert.deepEqual(tdd?.mountPaths, ['claude', 'kimi'], 'initial mount state should be [claude, kimi]');

    // Now kimi disabled — syncDrift with kimi disabled
    const kimiDisabledRules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        claude: { enabled: true, path: '.claude/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };
    // Add a new skill to trigger drift
    await makeSkill('debugging');
    await syncDriftCompat(
      projectRoot,
      skillsSource,
      kimiDisabledRules,
      {},
      { skillMountPaths: { tdd: ['claude', 'kimi'] } },
    );

    config = await readCapabilitiesConfig(projectRoot);
    tdd = config?.capabilities.find((c) => c.id === 'tdd');
    // F228: syncDrift only updates mountPaths for skills it actually mounts/unmounts
    // (newSkills, stale, conflicts). Non-stale existing skills keep their mountPaths.
    // Mount point disable → prune is reconcileSkillMountsAfterRuleChange's job.
    assert.deepStrictEqual(
      tdd?.mountPaths,
      ['claude', 'kimi'],
      'syncDrift must not modify mountPaths for non-stale, non-new skills',
    );
    assert.equal(tdd?.enabled, true, 'skill must remain enabled');
  });

  test('syncDrift persists declared mount policy for new skills, not active intersection (R2 P1)', async () => {
    await makeSkill('tdd');
    // kimi is DISABLED in mount rules, but declared in skill mount policy
    const kimiDisabledRules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };

    const report = await syncDriftCompat(
      projectRoot,
      skillsSource,
      kimiDisabledRules,
      {},
      {
        skillMountPaths: { tdd: ['claude', 'kimi'] },
      },
    );

    assert.deepEqual(report.mounted, ['tdd']);

    // Symlinks: only claude should be mounted (kimi disabled)
    assert.ok(await exists(join(projectRoot, '.claude/skills/tdd')), 'active provider should be mounted');
    assert.equal(await exists(join(projectRoot, '.kimi/skills/tdd')), false, 'disabled provider should NOT be mounted');

    // Config: mountPaths must preserve declared policy including disabled kimi
    const config = await readCapabilitiesConfig(projectRoot);
    const cap = config?.capabilities.find((c) => c.type === 'skill' && c.id === 'tdd');
    assert.ok(cap, 'capability entry should exist');
    assert.equal(cap.enabled, true, 'skill should be enabled');
    assert.deepStrictEqual(
      cap.mountPaths?.sort(),
      ['claude', 'kimi'],
      'mountPaths must preserve declared policy — kimi is disabled but still part of the target policy',
    );
  });

  // ── P1-2b regression: config orphan must be cleaned from capabilities.json after drift-resolve ──

  test('syncDrift removes config orphan from project capabilities.json (P1-2b)', async () => {
    await makeSkill('tdd');
    // Step 1: Initial sync to create a project config with tdd
    await syncDriftCompat(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});
    let config = await readCapabilitiesConfig(projectRoot);
    assert.ok(
      config?.capabilities.some((c) => c.type === 'skill' && c.id === 'tdd'),
      'tdd should be in project config after initial sync',
    );

    // Step 2: Simulate orphan scenario — tdd is in project config but NOT in global config.
    // Use checkProject directly to get a DriftResult with tdd in stale.
    const { checkProject } = await import('../../dist/skills/drift-detector.js');
    const allProviders = ['claude', 'codex', 'gemini', 'kimi'];
    const drift = await checkProject(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {
      globalConfigSkills: new Set(), // global has NOTHING → tdd is orphan
      projectConfigSkills: new Set(['tdd']),
      disabledSkills: [],
      skillMountPaths: { tdd: allProviders },
    });

    assert.ok(drift.stale.includes('tdd'), 'tdd should be stale (config orphan)');
    assert.ok(!drift.newSkills.includes('tdd'), 'tdd must not be in newSkills');

    // Step 3: syncDrift with configOrphans — should clean tdd from project config
    await syncDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, drift, {
      configOrphans: ['tdd'],
    });

    // Step 4: Verify tdd is gone from capabilities.json
    config = await readCapabilitiesConfig(projectRoot);
    const tddEntry = config?.capabilities.find((c) => c.type === 'skill' && c.source === 'cat-cafe' && c.id === 'tdd');
    assert.ok(
      !tddEntry || tddEntry.enabled === false,
      'config orphan tdd should be removed or disabled after drift-resolve',
    );
  });

  test('syncDrift with all providers disabled: no drift detected, no phantom entries (R2 P1 edge)', async () => {
    await makeSkill('tdd');
    // ALL standard providers disabled — drift detection has no mount dirs to scan
    const allDisabledRules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: Object.fromEntries(
        Object.entries(DEFAULT_MOUNT_RULES.mountPoints).map(([id, p]) => [id, { ...p, enabled: false }]),
      ),
    };

    const drift = await checkMount(projectRoot, skillsSource, allDisabledRules, {
      skillMountPaths: { tdd: ['claude', 'kimi'] },
    });
    // All providers disabled → no mount dirs → no drift
    assert.deepEqual(drift.newSkills, [], 'no new skills when all providers disabled');
    assert.deepEqual(drift.stale, [], 'no stale when all providers disabled');
    assert.deepEqual(drift.conflicts, [], 'no conflicts when all providers disabled');

    const report = await syncDriftCompat(
      projectRoot,
      skillsSource,
      allDisabledRules,
      {},
      { skillMountPaths: { tdd: ['claude', 'kimi'] } },
    );

    // syncDrift correctly does nothing — this case is handled by syncProject
    assert.deepEqual(report.mounted, [], 'no drift = nothing mounted');
    assert.deepEqual(report.unmounted, [], 'no drift = nothing unmounted');
  });

  test('syncDrift skips conflicts with path-traversal skill names', async () => {
    await makeSkill('tdd');
    await syncProject(projectRoot, skillsSource, { mountRules: DEFAULT_MOUNT_RULES });

    // ../../traversal-decoy from .claude/skills/ resolves to projectRoot/traversal-decoy
    const decoyPath = join(projectRoot, 'traversal-decoy');
    await writeFile(decoyPath, 'decoy-must-survive');

    // Fabricate a drift with a path-traversal conflict
    const fakeDrift = {
      driftHash: 'fake-hash',
      newSkills: [],
      stale: [],
      conflicts: [{ skill: '../../traversal-decoy', kind: 'foreign-file', mountPointId: 'claude' }],
      staleMounts: [],
      sourceManifestHash: 'sha256:fake',
    };

    await syncDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, fakeDrift);

    // Decoy file must survive — invalid skill id must not reach rm
    assert.equal(await exists(decoyPath), true, 'path-traversal decoy must survive syncDrift conflict cleanup');
  });

  test('syncDrift skips configOrphans with path-traversal names via additionalRemovedSkills', async () => {
    await makeSkill('tdd');
    await syncProject(projectRoot, skillsSource, { mountRules: DEFAULT_MOUNT_RULES });

    // ../../traversal-victim from .claude/skills/ resolves to projectRoot/traversal-victim
    const victimPath = join(projectRoot, 'traversal-victim');
    // Create a managed-looking symlink at the traversal target so classifyMountPath returns 'managed'
    const claudeSkillsDir = join(projectRoot, '.claude', 'skills');
    const traversalLink = join(claudeSkillsDir, '../../traversal-victim');
    await symlink(expectedSymlinkTarget(victimPath, join(skillsSource, '../../traversal-victim')), victimPath);

    // Invoke syncDrift with configOrphans containing the traversal name
    const fakeDrift = {
      driftHash: 'fake-hash',
      newSkills: [],
      stale: [],
      conflicts: [],
      staleMounts: [],
      sourceManifestHash: 'sha256:fake',
    };

    await syncDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, fakeDrift, {
      configOrphans: ['../../traversal-victim'],
    });

    // Victim must survive — invalid additionalRemovedSkills must be filtered
    assert.equal(await exists(victimPath), true, 'path-traversal victim via configOrphans must survive syncDrift');
  });

  test('syncDrift restores conflict blocker when final state write fails (P1-2 regression)', async () => {
    await makeSkill('tdd');

    // Create user-owned file at conflict path — this is the data we must not lose
    const userDir = join(projectRoot, '.claude/skills/tdd');
    await mkdir(userDir, { recursive: true });
    await writeFile(join(userDir, 'local.txt'), 'user content that must survive');

    // Pre-write a valid capabilities.json so syncProject can read config
    await writeCapabilitiesConfig(projectRoot, { version: 2, capabilities: [] });

    // Make .cat-cafe/ directory read-only so atomic writeCapabilitiesConfig fails.
    // With atomic write (temp file + rename), file-level chmod is insufficient —
    // rename() needs only directory write permission on POSIX, so we must block
    // the directory to prevent temp file creation.
    const catCafeDir = join(projectRoot, '.cat-cafe');
    const capPath = join(catCafeDir, 'capabilities.json');
    await chmod(catCafeDir, 0o555);

    // syncDrift should fail because final config write is blocked
    await assert.rejects(() => syncDriftCompat(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {}));

    // Restore write permission for cleanup
    await chmod(catCafeDir, 0o755).catch(() => {});
    await chmod(capPath, 0o644).catch(() => {});

    // THE KEY ASSERTION: user-owned conflict blocker must be restored
    assert.equal(
      await exists(join(userDir, 'local.txt')),
      true,
      'user-owned conflict blocker must be restored when sync fails',
    );
    // Verify content integrity, not just existence
    const restored = await readFile(join(userDir, 'local.txt'), 'utf8');
    assert.equal(restored, 'user content that must survive', 'restored content must match original');
  });

  test('syncDrift waits for capability lock before moving conflict blockers', async () => {
    await makeSkill('tdd');

    const userDir = join(projectRoot, '.claude/skills/tdd');
    const userFile = join(userDir, 'local.txt');
    await mkdir(userDir, { recursive: true });
    await writeFile(userFile, 'user content');

    const drift = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.ok(
      drift.conflicts.some((conflict) => conflict.skill === 'tdd' && conflict.mountPointId === 'claude'),
      'fixture must create a tdd conflict',
    );

    let releaseLock = () => {};
    let enteredLock = () => {};
    const releasePromise = new Promise((resolve) => {
      releaseLock = resolve;
    });
    const enteredPromise = new Promise((resolve) => {
      enteredLock = resolve;
    });
    const lockPromise = withCapabilityLock(projectRoot, async () => {
      enteredLock();
      await releasePromise;
    });

    await enteredPromise;
    const syncPromise = syncDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, drift);

    try {
      await sleep(50);
      assert.equal(await exists(userFile), true, 'conflict blocker must not move while capability lock is held');

      releaseLock();
      const report = await syncPromise;
      await lockPromise;
      assert.ok(report.overridden.includes('tdd'), 'conflict should resolve after lock release');
    } finally {
      releaseLock();
      await Promise.allSettled([lockPromise, syncPromise]);
    }
  });
});
