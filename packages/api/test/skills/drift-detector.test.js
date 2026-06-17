import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { DEFAULT_MOUNT_RULES } from '@cat-cafe/shared';
import { checkGlobal, checkProject } from '../../dist/skills/drift-detector.js';
import { listSourceSkillNames } from '../../dist/utils/skill-source.js';

/**
 * Test helper: wraps checkGlobal for mount-level drift testing.
 * Assumes all source skills are registered and mount to all enabled providers,
 * isolating mount drift detection from config-level concerns.
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

let tempDir;
let projectRoot;
let skillsSource;

async function makeSkill(name) {
  await mkdir(join(skillsSource, name), { recursive: true });
  await writeFile(join(skillsSource, name, 'SKILL.md'), `# ${name}`);
}

async function mountManagedLink(provider, skillName) {
  const dir = join(projectRoot, `.${provider}`, 'skills');
  await mkdir(dir, { recursive: true });
  await symlink(join(skillsSource, skillName), join(dir, skillName));
}

async function mountManagedRelativeLink(provider, skillName) {
  const dir = join(projectRoot, `.${provider}`, 'skills');
  await mkdir(dir, { recursive: true });
  await symlink(relative(dir, join(skillsSource, skillName)), join(dir, skillName));
}

async function mountLegacySkillsRoot(provider) {
  await mkdir(join(projectRoot, `.${provider}`), { recursive: true });
  await symlink(skillsSource, join(projectRoot, `.${provider}`, 'skills'));
}

describe('DriftDetector (F228 Phase 2)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'drift-detector-'));
    projectRoot = join(tempDir, 'project');
    skillsSource = join(tempDir, 'cat-cafe-skills');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(skillsSource, { recursive: true });
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('clean state: source empty, project empty → no drift', async () => {
    const result = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.deepEqual(result.newSkills, []);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.stale, []);
  });

  test('newSkills: source has skill, project has no symlink anywhere', async () => {
    await makeSkill('tdd');
    const result = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.deepEqual(result.newSkills, ['tdd']);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.stale, []);
  });

  test('mounted: source has skill + only enabled provider has managed symlink → no drift', async () => {
    await makeSkill('tdd');
    await mountManagedLink('claude', 'tdd');
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        codex: { ...DEFAULT_MOUNT_RULES.mountPoints.codex, enabled: false },
        gemini: { ...DEFAULT_MOUNT_RULES.mountPoints.gemini, enabled: false },
        kimi: { ...DEFAULT_MOUNT_RULES.mountPoints.kimi, enabled: false },
      },
    };
    const result = await checkMount(projectRoot, skillsSource, rules);
    assert.deepEqual(result.newSkills, [], 'the only enabled provider is mounted');
    assert.deepEqual(result.conflicts, []);
  });

  test('newSkills: missing from an enabled provider even when another provider is mounted', async () => {
    await makeSkill('tdd');
    await mountManagedLink('claude', 'tdd');
    const result = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.deepEqual(result.newSkills, ['tdd']);
    assert.deepEqual(result.conflicts, []);
  });

  test('mounted: relative managed symlink target is resolved before classification', async () => {
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
    await mountManagedRelativeLink('claude', 'tdd');
    const result = await checkMount(projectRoot, skillsSource, rules);
    assert.deepEqual(result.newSkills, [], 'relative managed symlink target should count as mounted');
    assert.deepEqual(result.conflicts, []);
  });

  test('mounted: symlink target through path alias is canonicalized before classification', async () => {
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
    const skillsAlias = join(tempDir, 'cat-cafe-skills-alias');
    await symlink(skillsSource, skillsAlias);
    const dir = join(projectRoot, '.claude/skills');
    await mkdir(dir, { recursive: true });
    await symlink(join(skillsAlias, 'tdd'), join(dir, 'tdd'));

    const result = await checkMount(projectRoot, skillsSource, rules);

    assert.deepEqual(result.newSkills, [], 'path aliases to the same real skill source should count as mounted');
    assert.deepEqual(result.conflicts, []);
  });

  test('mounted: Windows managed symlink path comparison is case-insensitive', async () => {
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
    const dir = join(projectRoot, '.claude/skills');
    await mkdir(dir, { recursive: true });
    await symlink(join(skillsSource, 'tdd').toUpperCase(), join(dir, 'tdd'));
    const result = await checkMount(projectRoot, skillsSource, rules, { platformName: 'win32' });
    assert.deepEqual(result.newSkills, []);
    assert.deepEqual(result.conflicts, []);
  });

  test('mounted: legacy directory-level provider symlink counts as managed', async () => {
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
    await mountLegacySkillsRoot('claude');
    const result = await checkMount(projectRoot, skillsSource, rules);
    assert.deepEqual(result.newSkills, []);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.stale, []);
  });

  test('conflict: invalid directory-level provider symlink is actionable drift', async () => {
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
    const missingSource = join(tempDir, 'missing-skills-source');
    await mkdir(join(projectRoot, '.claude'), { recursive: true });
    await symlink(missingSource, join(projectRoot, '.claude', 'skills'));

    const result = await checkMount(projectRoot, skillsSource, rules);

    assert.deepEqual(result.newSkills, []);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].skill, 'tdd');
    assert.equal(result.conflicts[0].kind, 'other-symlink');
    assert.equal(result.conflicts[0].mountPointId, 'claude');
    assert.equal(result.conflicts[0].pointsTo, missingSource);
  });

  test('conflict: wrong provider symlink is reported even when another provider is mounted', async () => {
    await makeSkill('tdd');
    await mountManagedLink('claude', 'tdd');
    const altSource = join(tempDir, 'other-skills/tdd');
    await mkdir(altSource, { recursive: true });
    await mkdir(join(projectRoot, '.codex/skills'), { recursive: true });
    await symlink(altSource, join(projectRoot, '.codex/skills/tdd'));
    const result = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.deepEqual(result.newSkills, []);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].skill, 'tdd');
    assert.equal(result.conflicts[0].kind, 'other-symlink');
    assert.equal(result.conflicts[0].mountPointId, 'codex');
  });

  test('conflict: project has same-name local directory blocking the mount', async () => {
    await makeSkill('tdd');
    await mkdir(join(projectRoot, '.claude/skills/tdd'), { recursive: true });
    await writeFile(join(projectRoot, '.claude/skills/tdd/local.md'), 'user file');
    const result = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.deepEqual(result.newSkills, []);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].skill, 'tdd');
    assert.equal(result.conflicts[0].kind, 'directory');
    assert.equal(result.conflicts[0].mountPointId, 'claude');
  });

  test('issues: directory conflict yields one conflict issue with backup warning, no mount-missing dup', async () => {
    await makeSkill('worktree');
    await mkdir(join(projectRoot, '.claude/skills/worktree'), { recursive: true });
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        codex: { ...DEFAULT_MOUNT_RULES.mountPoints.codex, enabled: false },
        gemini: { ...DEFAULT_MOUNT_RULES.mountPoints.gemini, enabled: false },
        kimi: { ...DEFAULT_MOUNT_RULES.mountPoints.kimi, enabled: false },
      },
    };
    const result = await checkMount(projectRoot, skillsSource, rules);

    // F228: backend emits a single display-ready issue per (skill, scenario).
    // A directory-conflicted skill must NOT also surface as mount-missing.
    assert.equal(result.issues.length, 1, 'exactly one issue for the conflicted skill');
    const issue = result.issues[0];
    assert.equal(issue.skill, 'worktree');
    assert.equal(issue.type, 'conflict');
    assert.equal(issue.mountPointId, 'claude');
    assert.match(issue.message, /存在同名目录占用/);
    assert.match(issue.message, /立即同步会覆盖和清理已有内容，请先确认是否需要进行备份/);
    assert.ok(
      !result.issues.some((i) => i.type === 'mount-missing'),
      'conflicted provider must not also appear as mount-missing',
    );
  });

  test('issues: partial mount surfaces mount-missing with the missing provider', async () => {
    await makeSkill('tdd');
    await mountManagedLink('claude', 'tdd'); // mounted on claude, missing on codex/gemini/kimi
    const result = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);

    const missing = result.issues.filter((i) => i.type === 'mount-missing');
    assert.equal(missing.length, 1);
    assert.equal(missing[0].skill, 'tdd');
    assert.match(missing[0].message, /未挂载/);
    // claude is mounted, so it must not be listed as missing
    assert.ok(!missing[0].message.includes('claude'));
  });

  test('conflict: provider skills root file blocks mount instead of reporting missing', async () => {
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

    const result = await checkMount(projectRoot, skillsSource, rules);

    assert.deepEqual(result.newSkills, []);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].skill, 'tdd');
    assert.equal(result.conflicts[0].kind, 'file');
    assert.equal(result.conflicts[0].mountPointId, 'claude');
  });

  test('conflict: same-name symlink pointing elsewhere', async () => {
    await makeSkill('tdd');
    // user-owned alternative skill source
    const altSource = join(tempDir, 'other-skills/tdd');
    await mkdir(altSource, { recursive: true });
    await mkdir(join(projectRoot, '.claude/skills'), { recursive: true });
    await symlink(altSource, join(projectRoot, '.claude/skills/tdd'));
    const result = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].kind, 'other-symlink');
    assert.equal(result.conflicts[0].pointsTo, altSource);
  });

  test('stale: managed symlink for a skill no longer in source', async () => {
    await makeSkill('tdd');
    await mountManagedLink('claude', 'tdd');
    await mountManagedLink('claude', 'old-skill'); // points to nowhere — still managed pattern
    const result = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.deepEqual(result.stale, ['old-skill']);
  });

  test('stale: managed symlink for a now-disabled skill', async () => {
    await makeSkill('tdd');
    await makeSkill('debugging');
    for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
      await mountManagedLink(provider, 'tdd');
    }
    await mountManagedLink('claude', 'debugging');
    const result = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {
      disabledSkills: ['debugging'],
    });
    assert.deepEqual(result.stale, ['debugging']);
    assert.deepEqual(result.newSkills, []);
  });

  test('stale: disabled skill remains loadable through legacy directory-level provider symlink', async () => {
    await makeSkill('tdd');
    await mountLegacySkillsRoot('claude');
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        codex: { ...DEFAULT_MOUNT_RULES.mountPoints.codex, enabled: false },
        gemini: { ...DEFAULT_MOUNT_RULES.mountPoints.gemini, enabled: false },
        kimi: { ...DEFAULT_MOUNT_RULES.mountPoints.kimi, enabled: false },
      },
    };

    const result = await checkMount(projectRoot, skillsSource, rules, { disabledSkills: ['tdd'] });

    assert.deepEqual(result.newSkills, []);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.stale, ['tdd']);
  });

  test('disabled skill is NOT reported as newSkill even when missing', async () => {
    await makeSkill('tdd');
    await makeSkill('debugging');
    const result = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {
      disabledSkills: ['debugging'],
    });
    assert.deepEqual(result.newSkills, ['tdd']);
  });

  test('driftHash stable across runs with same input', async () => {
    await makeSkill('tdd');
    const a = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    const b = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.equal(a.driftHash, b.driftHash);
  });

  test('driftHash differs when source set changes', async () => {
    await makeSkill('tdd');
    const a = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    await makeSkill('debugging');
    const b = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.notEqual(a.driftHash, b.driftHash);
  });

  test('driftHash differs when disabled set changes', async () => {
    await makeSkill('tdd');
    await makeSkill('debugging');
    const a = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    const b = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {
      disabledSkills: ['debugging'],
    });
    assert.notEqual(a.driftHash, b.driftHash);
  });

  test('driftHash differs when mount policy changes', async () => {
    await makeSkill('tdd');
    const a = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    const changedRules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        claude: { enabled: true, path: '.custom-claude/skills' },
      },
    };
    const b = await checkMount(projectRoot, skillsSource, changedRules);
    assert.notEqual(a.driftHash, b.driftHash);
  });

  test('driftHash diverges when a filesystem blocker appears (no source/policy change)', async () => {
    await makeSkill('tdd');
    const missing = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);

    await mkdir(join(projectRoot, '.claude/skills/tdd'), { recursive: true });
    await writeFile(join(projectRoot, '.claude/skills/tdd/local.md'), 'local blocker');

    const blocked = await checkMount(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);

    assert.notEqual(blocked.driftHash, missing.driftHash);
    assert.deepEqual(blocked.newSkills, []);
    assert.equal(blocked.conflicts.length, 1);
    assert.equal(blocked.conflicts[0].kind, 'directory');
  });

  test('disabled standard provider is not scanned (skill in .kimi/skills/ ignored)', async () => {
    await makeSkill('tdd');
    await mountManagedLink('kimi', 'tdd');
    // disable kimi — only claude/codex/gemini matter
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };
    const result = await checkMount(projectRoot, skillsSource, rules);
    // claude/codex/gemini have no managed symlinks → newSkill
    // kimi has one but it's disabled, so not counted
    assert.deepEqual(result.newSkills, ['tdd']);
  });

  test('all standard providers disabled reports no newSkills', async () => {
    await makeSkill('tdd');
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: Object.fromEntries(
        Object.entries(DEFAULT_MOUNT_RULES.mountPoints).map(([id, rule]) => [id, { ...rule, enabled: false }]),
      ),
    };
    const result = await checkMount(projectRoot, skillsSource, rules);
    assert.deepEqual(result.newSkills, []);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.stale, []);
  });

  test('custom mount paths participate in missing, conflict, and stale drift detection', async () => {
    await makeSkill('tdd');
    await makeSkill('debugging');
    const customDir = join(projectRoot, 'custom-client', 'skills');
    await mkdir(join(customDir, 'debugging'), { recursive: true });
    await symlink(join(skillsSource, 'old-skill'), join(customDir, 'old-skill'));
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: Object.fromEntries(
        Object.entries(DEFAULT_MOUNT_RULES.mountPoints).map(([id, rule]) => [id, { ...rule, enabled: false }]),
      ),
      customPaths: [{ alias: 'acp', path: customDir }],
    };

    const result = await checkMount(projectRoot, skillsSource, rules);

    assert.deepEqual(result.newSkills, ['tdd']);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].skill, 'debugging');
    assert.equal(result.conflicts[0].kind, 'directory');
    assert.equal(result.conflicts[0].mountPointId, 'acp');
    assert.deepEqual(result.stale, ['old-skill']);
  });

  // ── P1-2 regression: orphan must NOT appear in both newSkills and stale ──

  test('checkProject: config orphan appears only in stale, not in newSkills (P1-2)', async () => {
    await makeSkill('tdd');
    await makeSkill('orphan-skill');
    // Mount tdd so it's clean
    await mountManagedLink('claude', 'tdd');
    await mountManagedLink('codex', 'tdd');
    await mountManagedLink('gemini', 'tdd');
    await mountManagedLink('kimi', 'tdd');

    // orphan-skill is in project config but NOT in global config
    const allProviders = ['claude', 'codex', 'gemini', 'kimi'];
    const result = await checkProject(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {
      globalConfigSkills: new Set(['tdd']),
      projectConfigSkills: new Set(['tdd', 'orphan-skill']),
      disabledSkills: [],
      skillMountPaths: {
        tdd: allProviders,
        'orphan-skill': allProviders,
      },
    });

    // orphan-skill should be in stale (config orphan) but NOT in newSkills
    assert.ok(result.stale.includes('orphan-skill'), 'orphan should be in stale');
    assert.ok(!result.newSkills.includes('orphan-skill'), 'orphan must NOT be in newSkills');
  });

  test('checkProject: config-new skill (in global, not project) appears only in newSkills (P1-2)', async () => {
    await makeSkill('tdd');
    await makeSkill('new-global-skill');

    const allProviders = ['claude', 'codex', 'gemini', 'kimi'];
    const result = await checkProject(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {
      globalConfigSkills: new Set(['tdd', 'new-global-skill']),
      projectConfigSkills: new Set(['tdd']),
      disabledSkills: [],
      skillMountPaths: {
        tdd: allProviders,
        'new-global-skill': allProviders,
      },
    });

    assert.ok(result.newSkills.includes('new-global-skill'), 'new global skill should be in newSkills');
    assert.ok(!result.stale.includes('new-global-skill'), 'new global skill must NOT be in stale');
  });

  test('driftHash differs when custom mount paths change', async () => {
    await makeSkill('tdd');
    const baseRules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: Object.fromEntries(
        Object.entries(DEFAULT_MOUNT_RULES.mountPoints).map(([id, rule]) => [id, { ...rule, enabled: false }]),
      ),
      customPaths: [{ alias: 'acp', path: join(projectRoot, 'custom-a', 'skills') }],
    };
    const changedRules = {
      ...baseRules,
      customPaths: [{ alias: 'acp', path: join(projectRoot, 'custom-b', 'skills') }],
    };

    const a = await checkMount(projectRoot, skillsSource, baseRules);
    const b = await checkMount(projectRoot, skillsSource, changedRules);

    assert.notEqual(a.driftHash, b.driftHash);
  });
});
