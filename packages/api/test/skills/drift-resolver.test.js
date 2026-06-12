import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { DEFAULT_MOUNT_RULES } from '@cat-cafe/shared';
import {
  readCapabilitiesConfig,
  writeCapabilitiesConfig,
} from '../../dist/config/capabilities/capability-orchestrator.js';
import { syncProject } from '../../dist/skills/skill-sync-engine.js';
import { checkStaleness } from '../../dist/config/governance/skills-state.js';
import { detectDrift } from '../../dist/skills/drift-detector.js';
import { ignoreDrift, syncDrift } from '../../dist/skills/drift-resolver.js';

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
    const report = await syncDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});
    assert.deepEqual(report.mounted, ['tdd']);
    for (const p of ['claude', 'codex', 'gemini', 'kimi']) {
      assert.ok(await exists(join(projectRoot, `.${p}/skills/tdd`)));
    }
    // post-sync drift should be empty
    const after = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.deepEqual(after.newSkills, []);
  });

  test('syncDrift respects per-skill mountPaths when mounting new skills', async () => {
    await makeSkill('tdd');

    const report = await syncDrift(
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
    const after = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {
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

    const report = await syncDrift(
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

    const report = await syncDrift(
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

    const after = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {
      skillMountPaths: { tdd: ['claude'] },
    });
    assert.deepEqual(after.stale, []);
  });

  test('syncDrift rolls back mounted new skills when final state write fails', async () => {
    await makeSkill('alpha');
    await writeFile(join(projectRoot, '.cat-cafe'), 'not a directory');

    await assert.rejects(() => syncDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {}));

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
    const report = await syncDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});
    assert.deepEqual(report.unmounted, ['old-skill']);
    assert.equal(await exists(join(projectRoot, '.claude/skills/old-skill')), false);
  });

  test('syncDrift overrides conflict when choice is "override"', async () => {
    await makeSkill('tdd');
    // pre-create user's own directory blocking the mount
    await mkdir(join(projectRoot, '.claude/skills/tdd'), { recursive: true });
    await writeFile(join(projectRoot, '.claude/skills/tdd/user.md'), 'user version');
    const report = await syncDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {
      'tdd:claude': 'override',
    });
    assert.deepEqual(report.overridden, ['tdd']);
    assert.deepEqual(report.skipped, []);
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

    const report = await syncDrift(
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

  test('syncDrift skips conflict when choice is "skip" (default)', async () => {
    await makeSkill('tdd');
    await mkdir(join(projectRoot, '.claude/skills/tdd'), { recursive: true });
    await writeFile(join(projectRoot, '.claude/skills/tdd/user.md'), 'user version');
    const report = await syncDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});
    assert.deepEqual(report.skipped, ['tdd']);
    assert.deepEqual(report.overridden, []);
    // User's dir is preserved
    const stat = await lstat(join(projectRoot, '.claude/skills/tdd'));
    assert.equal(stat.isSymbolicLink(), false, 'user dir is preserved when skipped');
    assert.ok(await exists(join(projectRoot, '.claude/skills/tdd/user.md')));
  });

  test('syncDrift clears ignoredDriftHash after sync', async () => {
    await makeSkill('tdd');
    await ignoreDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    const beforeSync = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.equal(beforeSync.isIgnored, true);

    await syncDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});

    // After sync, even if new drift hash is the same, isIgnored should be false
    const afterSync = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.equal(afterSync.isIgnored, false);
  });

  test('ignoreDrift records current hash as ignored', async () => {
    await makeSkill('tdd');
    const report = await ignoreDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.ok(report.ignoredHash);
    assert.equal(report.ignoredHash, report.ignoredSnapshot.driftHash);

    const check = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.equal(check.isIgnored, true);
  });

  test('ignoreDrift then source change → isIgnored=false again', async () => {
    await makeSkill('tdd');
    await ignoreDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    // add a new skill — hash changes
    await makeSkill('debugging');
    const check = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.equal(check.isIgnored, false);
  });

  test('syncDrift respects disabledSkills — disabled skills are unmounted, not new-mounted', async () => {
    await makeSkill('tdd');
    await makeSkill('debugging');
    // Initial mount: both
    await syncDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});
    // Now disable debugging
    const report = await syncDrift(
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
      providers: {
        ...DEFAULT_MOUNT_RULES.providers,
        codex: { ...DEFAULT_MOUNT_RULES.providers.codex, enabled: false },
        gemini: { ...DEFAULT_MOUNT_RULES.providers.gemini, enabled: false },
        kimi: { ...DEFAULT_MOUNT_RULES.providers.kimi, enabled: false },
      },
    };
    const claudeSkills = join(projectRoot, '.claude/skills');
    await mkdir(dirname(claudeSkills), { recursive: true });
    await symlink(skillsSource, claudeSkills);

    const report = await syncDrift(projectRoot, skillsSource, rules, {}, { disabledSkills: ['debugging'] });

    assert.deepEqual(report.unmounted, ['debugging']);
    const rootStat = await lstat(claudeSkills);
    assert.equal(rootStat.isDirectory(), true, 'legacy root should be converted to a real provider dir');
    assert.equal(rootStat.isSymbolicLink(), false, 'legacy directory-level symlink should be removed');
    const tddLink = join(claudeSkills, 'tdd');
    assert.equal((await lstat(tddLink)).isSymbolicLink(), true, 'enabled skill should remain mounted');
    assert.equal(await readlink(tddLink), expectedSymlinkTarget(tddLink, join(skillsSource, 'tdd')));
    await assert.rejects(() => lstat(join(claudeSkills, 'debugging')), /ENOENT/);
    assert.equal(await exists(join(skillsSource, 'debugging/SKILL.md')), true, 'source skill must not be deleted');

    const after = await detectDrift(projectRoot, skillsSource, rules, { disabledSkills: ['debugging'] });
    assert.deepEqual(after.newSkills, []);
    assert.deepEqual(after.conflicts, []);
    assert.deepEqual(after.stale, []);
  });

  test('syncDrift restores disabled-provider stale links when final state write fails', async () => {
    await makeSkill('debugging');
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      providers: {
        ...DEFAULT_MOUNT_RULES.providers,
        codex: { ...DEFAULT_MOUNT_RULES.providers.codex, enabled: false },
        gemini: { ...DEFAULT_MOUNT_RULES.providers.gemini, enabled: false },
        kimi: { ...DEFAULT_MOUNT_RULES.providers.kimi, enabled: false },
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

    await assert.rejects(() => syncDrift(projectRoot, skillsSource, rules, {}, { disabledSkills: ['debugging'] }));

    assert.equal((await lstat(claudeLink)).isSymbolicLink(), true, 'enabled-provider link should be restored');
    assert.equal((await lstat(codexLink)).isSymbolicLink(), true, 'disabled-provider link should be restored');
  });

  test('syncDrift handles mixed conflicts: one override + one skip', async () => {
    await makeSkill('a');
    await makeSkill('b');
    await mkdir(join(projectRoot, '.claude/skills/a'), { recursive: true });
    await mkdir(join(projectRoot, '.claude/skills/b'), { recursive: true });
    const report = await syncDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {
      'a:claude': 'override',
      // b:claude defaults to skip
    });
    assert.deepEqual(report.overridden, ['a']);
    assert.deepEqual(report.skipped, ['b']);
    const aStat = await lstat(join(projectRoot, '.claude/skills/a'));
    const bStat = await lstat(join(projectRoot, '.claude/skills/b'));
    assert.equal(aStat.isSymbolicLink(), true);
    assert.equal(bStat.isSymbolicLink(), false);
  });

  test('syncDrift override does not remove source skill through legacy directory-level mount', async () => {
    await makeSkill('tdd');
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      providers: {
        ...DEFAULT_MOUNT_RULES.providers,
        gemini: { ...DEFAULT_MOUNT_RULES.providers.gemini, enabled: false },
        kimi: { ...DEFAULT_MOUNT_RULES.providers.kimi, enabled: false },
      },
    };
    await mkdir(join(projectRoot, '.claude'), { recursive: true });
    await symlink(skillsSource, join(projectRoot, '.claude/skills'));
    await mkdir(join(projectRoot, '.codex/skills/tdd'), { recursive: true });
    await writeFile(join(projectRoot, '.codex/skills/tdd/local.md'), 'user version');

    const report = await syncDrift(projectRoot, skillsSource, rules, { 'tdd:codex': 'override' });

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

    const report = await syncDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, { 'tdd:claude': 'override' });

    assert.deepEqual(report.overridden, ['tdd']);
    for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
      const linkPath = join(projectRoot, `.${provider}/skills/tdd`);
      const stat = await lstat(linkPath);
      assert.equal(stat.isSymbolicLink(), true, `${provider} should be remounted`);
      assert.equal(await readlink(linkPath), expectedSymlinkTarget(linkPath, join(skillsSource, 'tdd')));
    }
    const after = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.deepEqual(after.newSkills, []);
    assert.deepEqual(after.conflicts, []);
    assert.deepEqual(after.stale, []);
  });

  test('syncDrift override replaces provider skills root file blocker', async () => {
    await makeSkill('tdd');
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      providers: {
        ...DEFAULT_MOUNT_RULES.providers,
        codex: { ...DEFAULT_MOUNT_RULES.providers.codex, enabled: false },
        gemini: { ...DEFAULT_MOUNT_RULES.providers.gemini, enabled: false },
        kimi: { ...DEFAULT_MOUNT_RULES.providers.kimi, enabled: false },
      },
    };
    await mkdir(join(projectRoot, '.claude'), { recursive: true });
    await writeFile(join(projectRoot, '.claude/skills'), 'not a directory');

    const report = await syncDrift(projectRoot, skillsSource, rules, { 'tdd:claude': 'override' });

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
      providers: Object.fromEntries(
        Object.entries(DEFAULT_MOUNT_RULES.providers).map(([id, provider]) => [id, { ...provider, enabled: false }]),
      ),
      customPaths: [{ alias: 'acp', path: customDir }],
    };

    const report = await syncDrift(projectRoot, skillsSource, rules, { 'tdd:acp': 'override' });

    assert.deepEqual(report.overridden, ['tdd']);
    const linkPath = join(customDir, 'tdd');
    const stat = await lstat(linkPath);
    assert.equal(stat.isSymbolicLink(), true, 'custom conflict should be replaced by managed symlink');
    assert.equal(await readlink(linkPath), expectedSymlinkTarget(linkPath, join(skillsSource, 'tdd')));
    const after = await detectDrift(projectRoot, skillsSource, rules);
    assert.deepEqual(after.newSkills, []);
    assert.deepEqual(after.conflicts, []);
    assert.deepEqual(after.stale, []);
  });

  test('syncDrift same skill conflicting in two providers — per-provider override', async () => {
    await makeSkill('tdd');
    // Create user-owned blockers in both claude and codex
    await mkdir(join(projectRoot, '.claude/skills/tdd'), { recursive: true });
    await writeFile(join(projectRoot, '.claude/skills/tdd/user.md'), 'claude user version');
    await mkdir(join(projectRoot, '.codex/skills/tdd'), { recursive: true });
    await writeFile(join(projectRoot, '.codex/skills/tdd/user.md'), 'codex user version');

    // Detect drift — should report two separate conflicts
    const drift = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    const tddConflicts = drift.conflicts.filter((c) => c.skill === 'tdd');
    assert.ok(tddConflicts.length >= 2, 'should report per-provider conflicts');
    const providers = tddConflicts.map((c) => c.provider);
    assert.ok(providers.includes('claude'), 'claude conflict should be reported');
    assert.ok(providers.includes('codex'), 'codex conflict should be reported');

    // Override claude, skip codex
    const report = await syncDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {
      'tdd:claude': 'override',
      // tdd:codex defaults to skip
    });

    assert.deepEqual(report.overridden, ['tdd']);
    // Claude should be replaced by managed symlink
    const claudeStat = await lstat(join(projectRoot, '.claude/skills/tdd'));
    assert.equal(claudeStat.isSymbolicLink(), true, 'overridden claude should be managed symlink');
    // Codex user dir should be preserved
    assert.equal(
      await exists(join(projectRoot, '.codex/skills/tdd/user.md')),
      true,
      'skipped codex user file should be preserved',
    );
    assert.equal(
      (await lstat(join(projectRoot, '.codex/skills/tdd'))).isSymbolicLink(),
      false,
      'skipped codex should not be a symlink',
    );
    // Gemini and kimi (non-conflicting) should be auto-mounted
    for (const provider of ['gemini', 'kimi']) {
      const linkPath = join(projectRoot, `.${provider}/skills/tdd`);
      assert.equal(
        (await lstat(linkPath)).isSymbolicLink(),
        true,
        `non-conflicting ${provider} should be auto-mounted`,
      );
    }
  });

  test('syncDrift mounts non-conflicting providers when conflict is skipped', async () => {
    await makeSkill('tdd');
    // Create a user-owned blocker only in claude (conflict).
    // codex/gemini/kimi are merely missing (no conflict).
    await mkdir(join(projectRoot, '.claude/skills/tdd'), { recursive: true });
    await writeFile(join(projectRoot, '.claude/skills/tdd/user.md'), 'user version');

    const drift = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    // tdd should appear in conflicts (claude) but NOT in newSkills
    assert.ok(drift.conflicts.some((c) => c.skill === 'tdd' && c.provider === 'claude'));
    assert.ok(!drift.newSkills.includes('tdd'), 'detector suppresses newSkills when conflicts exist');

    // Skip the claude conflict — non-conflicting providers should still be mounted
    const report = await syncDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {
      // tdd:claude defaults to skip
    });

    assert.ok(report.skipped.includes('tdd'), 'skill should be in skipped');
    // Claude user dir should be preserved
    assert.equal(
      (await lstat(join(projectRoot, '.claude/skills/tdd'))).isSymbolicLink(),
      false,
      'skipped claude should not be a symlink',
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
      providers: Object.fromEntries(
        Object.entries(DEFAULT_MOUNT_RULES.providers).map(([id, provider]) => [id, { ...provider, enabled: false }]),
      ),
      customPaths: [{ alias: 'acp', path: customDir }],
    };
    await writeFile(join(projectRoot, '.cat-cafe'), 'not a directory');

    await assert.rejects(() => syncDrift(projectRoot, skillsSource, rules, {}));

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

    await syncDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});

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

  test('syncDrift removes Cat Cafe capabilities for source-deleted stale skills', async () => {
    await makeSkill('tdd');
    await makeSkill('old-skill');
    await syncDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});

    await rm(join(skillsSource, 'old-skill'), { recursive: true, force: true });

    const report = await syncDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});

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
    await syncDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});

    await syncDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {}, { disabledSkills: ['debugging'] });

    const config = await readCapabilitiesConfig(projectRoot);
    assert.ok(config, 'capabilities.json should exist after drift sync');
    const debugging = config.capabilities.find((c) => c.type === 'skill' && c.id === 'debugging');
    const tdd = config.capabilities.find((c) => c.type === 'skill' && c.id === 'tdd');
    assert.equal(debugging?.enabled, false, 'policy-disabled stale skill should be globally disabled');
    assert.deepEqual(debugging?.mountPaths, [], 'policy-disabled stale skill should have no mounts');
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
    await syncDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {});

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

    await syncDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {}, { disabledSkills: ['debugging'] });

    const after = await readCapabilitiesConfig(projectRoot);
    assert.ok(after, 'capabilities.json should exist after drift sync');
    const firstParty = after.capabilities.find(
      (cap) => cap.type === 'skill' && cap.id === 'debugging' && !cap.pluginId,
    );
    const pluginOwned = after.capabilities.find(
      (cap) => cap.type === 'skill' && cap.id === 'debugging' && cap.pluginId === 'same-id-plugin',
    );
    assert.equal(firstParty?.enabled, false, 'disabled source skill should be disabled');
    assert.deepEqual(firstParty?.mountPaths, [], 'disabled source skill should have no mounts');
    assert.equal(pluginOwned?.enabled, true, 'same-id plugin skill must keep its enabled state');
    assert.deepEqual(pluginOwned?.mountPaths, ['claude'], 'same-id plugin mount policy must be preserved');
  });

  test('syncDrift preserves cascade tracking so syncProject can re-enable on global re-enable (P1-1 cross-path)', async () => {
    await makeSkill('tdd');

    // Step 1: syncProject with cascade disabled — writes cascadeDisabledSkills
    await syncProject(projectRoot, skillsSource, { mountRules: DEFAULT_MOUNT_RULES, cascadeDisabledSkills: new Set(['tdd']) });
    let config = await readCapabilitiesConfig(projectRoot);
    let tdd = config?.capabilities.find((c) => c.type === 'skill' && c.id === 'tdd');
    assert.equal(tdd?.enabled, false, 'tdd should be cascade-disabled after syncProject');

    // Step 2: syncDrift with disabled (simulates drift-resolve while global still disables)
    await syncDrift(
      projectRoot,
      skillsSource,
      DEFAULT_MOUNT_RULES,
      {},
      { disabledSkills: ['tdd'], cascadeDisabledSkills: ['tdd'] },
    );
    config = await readCapabilitiesConfig(projectRoot);
    tdd = config?.capabilities.find((c) => c.type === 'skill' && c.id === 'tdd');
    assert.equal(tdd?.enabled, false, 'tdd should remain disabled after syncDrift');

    // Step 3: syncProject WITHOUT cascade disabled — global re-enables
    await syncProject(projectRoot, skillsSource, { mountRules: DEFAULT_MOUNT_RULES });

    // tdd must re-enable — cascade tracking preserved across syncDrift
    for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
      assert.ok(
        await exists(join(projectRoot, `.${provider}/skills/tdd`)),
        `${provider} symlink must exist after global re-enable (cross-path cascade tracking)`,
      );
    }
    config = await readCapabilitiesConfig(projectRoot);
    tdd = config?.capabilities.find((c) => c.type === 'skill' && c.id === 'tdd');
    assert.equal(tdd?.enabled, true, 'cascade-disabled skill must re-enable after syncDrift + syncProject');
  });

  test('mergeSkillMountPolicies preserves cascade marker when skill already in project disabledSkills (R4 P1)', async () => {
    // Directly test the merge function that drift-check route uses.
    // Bug: when a skill is in both project disabledSkills (from prev cascade)
    // AND global disabledSkills, the second loop skipped cascade tracking.
    const { mergeSkillMountPolicies } = await import('../../dist/routes/skills-drift.js');

    const projectPolicy = {
      disabledSkills: ['tdd'],
      skillMountPaths: {},
      configuredSkills: new Set(['tdd']),
    };
    const globalPolicy = {
      disabledSkills: ['tdd'],
      skillMountPaths: {},
      configuredSkills: new Set(['tdd']),
    };
    const prevCascadeDisabled = new Set(['tdd']);

    const merged = mergeSkillMountPolicies(projectPolicy, globalPolicy, prevCascadeDisabled);

    // tdd must appear in cascadeDisabledSkills even though first loop already
    // added it to disabledSkills — otherwise next syncProject can't detect
    // cascade origin and the skill stays permanently disabled.
    assert.ok(
      merged.cascadeDisabledSkills?.includes('tdd'),
      'cascade marker must be preserved when skill is in both project and global disabled lists',
    );
    assert.ok(merged.disabledSkills.includes('tdd'), 'tdd must still be in disabledSkills (disabled by both layers)');
  });

  test('mergeSkillMountPolicies drops stale cascade entry when global re-enables', async () => {
    const { mergeSkillMountPolicies } = await import('../../dist/routes/skills-drift.js');

    // Scenario: tdd was previously cascade-disabled, now global re-enables
    const projectPolicy = {
      disabledSkills: ['tdd'],
      skillMountPaths: {},
      configuredSkills: new Set(['tdd']),
    };
    const globalPolicy = {
      disabledSkills: [],
      skillMountPaths: {},
      configuredSkills: new Set(),
    };
    const prevCascadeDisabled = new Set(['tdd']);

    const merged = mergeSkillMountPolicies(projectPolicy, globalPolicy, prevCascadeDisabled);

    // Stale cascade entry must be dropped — global re-enabled
    assert.ok(!merged.disabledSkills.includes('tdd'), 'stale cascade entry must be dropped when global re-enables');
    assert.deepEqual(merged.cascadeDisabledSkills ?? [], [], 'no cascade entries when global has no disabled skills');
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

  test('syncDrift excludes skipped conflicts from managed capability entries', async () => {
    await makeSkill('managed');
    await makeSkill('user-owned');
    // Create a blocking user dir for user-owned skill
    await mkdir(join(projectRoot, '.claude/skills/user-owned'), { recursive: true });
    await writeFile(join(projectRoot, '.claude/skills/user-owned/local.md'), 'my version');

    await syncDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {
      // user-owned defaults to 'skip'
    });

    // Verify capabilities.json has mounted skill as managed, skipped skill absent
    const config = await readCapabilitiesConfig(projectRoot);
    assert.ok(config, 'capabilities.json should exist');
    const managedIds = config.capabilities
      .filter((c) => c.type === 'skill' && c.source === 'cat-cafe')
      .map((c) => c.id);
    assert.ok(managedIds.includes('managed'), 'mounted skill should be in capabilities');
    // Skipped conflict: user-owned has a blocking dir, defaults to 'skip' so it should
    // NOT have mountPaths (it was never successfully mounted as a managed skill)
    const userOwnedEntry = config.capabilities.find((c) => c.type === 'skill' && c.id === 'user-owned');
    // user-owned may or may not appear; if it does, its mountPaths should be empty
    if (userOwnedEntry) {
      assert.deepEqual(userOwnedEntry.mountPaths ?? [], [], 'skipped conflict should have empty mountPaths');
    }
  });

  test('syncDrift preserves mountPaths for non-stale skills — prune is reconciliation job (F228 state-record)', async () => {
    await makeSkill('tdd');
    // Initial sync: tdd mounted to claude and kimi
    const partialRules = {
      ...DEFAULT_MOUNT_RULES,
      providers: {
        ...DEFAULT_MOUNT_RULES.providers,
        claude: { enabled: true, path: '.claude/skills' },
        kimi: { enabled: true, path: '.kimi/skills' },
      },
    };
    await syncProject(projectRoot, skillsSource, {
      mountRules: partialRules,
      globalMountPathsBySkill: new Map([['tdd', ['claude', 'kimi']]]),
    });

    let config = await readCapabilitiesConfig(projectRoot);
    let tdd = config?.capabilities.find((c) => c.id === 'tdd');
    assert.deepEqual(tdd?.mountPaths, ['claude', 'kimi'], 'initial mount state should be [claude, kimi]');

    // Now kimi disabled — syncDrift with kimi disabled
    const kimiDisabledRules = {
      ...DEFAULT_MOUNT_RULES,
      providers: {
        ...DEFAULT_MOUNT_RULES.providers,
        claude: { enabled: true, path: '.claude/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };
    // Add a new skill to trigger drift
    await makeSkill('debugging');
    await syncDrift(
      projectRoot,
      skillsSource,
      kimiDisabledRules,
      {},
      {
        skillMountPaths: { tdd: ['claude', 'kimi'] },
      },
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
      providers: {
        ...DEFAULT_MOUNT_RULES.providers,
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };

    const report = await syncDrift(
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

  test('syncDrift with all providers disabled: no drift detected, no phantom entries (R2 P1 edge)', async () => {
    await makeSkill('tdd');
    // ALL standard providers disabled — drift detection has no mount dirs to scan
    const allDisabledRules = {
      ...DEFAULT_MOUNT_RULES,
      providers: Object.fromEntries(
        Object.entries(DEFAULT_MOUNT_RULES.providers).map(([id, p]) => [id, { ...p, enabled: false }]),
      ),
    };

    const drift = await detectDrift(projectRoot, skillsSource, allDisabledRules, {
      skillMountPaths: { tdd: ['claude', 'kimi'] },
    });
    // All providers disabled → no mount dirs → no drift
    assert.deepEqual(drift.newSkills, [], 'no new skills when all providers disabled');
    assert.deepEqual(drift.stale, [], 'no stale when all providers disabled');
    assert.deepEqual(drift.conflicts, [], 'no conflicts when all providers disabled');

    const report = await syncDrift(
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
});
