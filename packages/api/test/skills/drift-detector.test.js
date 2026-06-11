import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { DEFAULT_MOUNT_RULES } from '@cat-cafe/shared';
import { markDriftIgnored } from '../../dist/config/mount/project-state-store.js';
import { detectDrift } from '../../dist/skills/drift-detector.js';

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
    const result = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.deepEqual(result.newSkills, []);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.stale, []);
  });

  test('newSkills: source has skill, project has no symlink anywhere', async () => {
    await makeSkill('tdd');
    const result = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.deepEqual(result.newSkills, ['tdd']);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.stale, []);
  });

  test('mounted: source has skill + only enabled provider has managed symlink → no drift', async () => {
    await makeSkill('tdd');
    await mountManagedLink('claude', 'tdd');
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      providers: {
        ...DEFAULT_MOUNT_RULES.providers,
        codex: { ...DEFAULT_MOUNT_RULES.providers.codex, enabled: false },
        gemini: { ...DEFAULT_MOUNT_RULES.providers.gemini, enabled: false },
        kimi: { ...DEFAULT_MOUNT_RULES.providers.kimi, enabled: false },
      },
    };
    const result = await detectDrift(projectRoot, skillsSource, rules);
    assert.deepEqual(result.newSkills, [], 'the only enabled provider is mounted');
    assert.deepEqual(result.conflicts, []);
  });

  test('newSkills: missing from an enabled provider even when another provider is mounted', async () => {
    await makeSkill('tdd');
    await mountManagedLink('claude', 'tdd');
    const result = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.deepEqual(result.newSkills, ['tdd']);
    assert.deepEqual(result.conflicts, []);
  });

  test('mounted: relative managed symlink target is resolved before classification', async () => {
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
    await mountManagedRelativeLink('claude', 'tdd');
    const result = await detectDrift(projectRoot, skillsSource, rules);
    assert.deepEqual(result.newSkills, [], 'relative managed symlink target should count as mounted');
    assert.deepEqual(result.conflicts, []);
  });

  test('mounted: symlink target through path alias is canonicalized before classification', async () => {
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
    const skillsAlias = join(tempDir, 'cat-cafe-skills-alias');
    await symlink(skillsSource, skillsAlias);
    const dir = join(projectRoot, '.claude/skills');
    await mkdir(dir, { recursive: true });
    await symlink(join(skillsAlias, 'tdd'), join(dir, 'tdd'));

    const result = await detectDrift(projectRoot, skillsSource, rules);

    assert.deepEqual(result.newSkills, [], 'path aliases to the same real skill source should count as mounted');
    assert.deepEqual(result.conflicts, []);
  });

  test('mounted: Windows managed symlink path comparison is case-insensitive', async () => {
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
    const dir = join(projectRoot, '.claude/skills');
    await mkdir(dir, { recursive: true });
    await symlink(join(skillsSource, 'tdd').toUpperCase(), join(dir, 'tdd'));
    const result = await detectDrift(projectRoot, skillsSource, rules, { platformName: 'win32' });
    assert.deepEqual(result.newSkills, []);
    assert.deepEqual(result.conflicts, []);
  });

  test('mounted: legacy directory-level provider symlink counts as managed', async () => {
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
    await mountLegacySkillsRoot('claude');
    const result = await detectDrift(projectRoot, skillsSource, rules);
    assert.deepEqual(result.newSkills, []);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.stale, []);
  });

  test('conflict: invalid directory-level provider symlink is actionable drift', async () => {
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
    const missingSource = join(tempDir, 'missing-skills-source');
    await mkdir(join(projectRoot, '.claude'), { recursive: true });
    await symlink(missingSource, join(projectRoot, '.claude', 'skills'));

    const result = await detectDrift(projectRoot, skillsSource, rules);

    assert.deepEqual(result.newSkills, []);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].skill, 'tdd');
    assert.equal(result.conflicts[0].kind, 'other-symlink');
    assert.equal(result.conflicts[0].provider, 'claude');
    assert.equal(result.conflicts[0].pointsTo, missingSource);
  });

  test('conflict: wrong provider symlink is reported even when another provider is mounted', async () => {
    await makeSkill('tdd');
    await mountManagedLink('claude', 'tdd');
    const altSource = join(tempDir, 'other-skills/tdd');
    await mkdir(altSource, { recursive: true });
    await mkdir(join(projectRoot, '.codex/skills'), { recursive: true });
    await symlink(altSource, join(projectRoot, '.codex/skills/tdd'));
    const result = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.deepEqual(result.newSkills, []);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].skill, 'tdd');
    assert.equal(result.conflicts[0].kind, 'other-symlink');
    assert.equal(result.conflicts[0].provider, 'codex');
  });

  test('conflict: project has same-name local directory blocking the mount', async () => {
    await makeSkill('tdd');
    await mkdir(join(projectRoot, '.claude/skills/tdd'), { recursive: true });
    await writeFile(join(projectRoot, '.claude/skills/tdd/local.md'), 'user file');
    const result = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.deepEqual(result.newSkills, []);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].skill, 'tdd');
    assert.equal(result.conflicts[0].kind, 'directory');
    assert.equal(result.conflicts[0].provider, 'claude');
  });

  test('conflict: provider skills root file blocks mount instead of reporting missing', async () => {
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

    const result = await detectDrift(projectRoot, skillsSource, rules);

    assert.deepEqual(result.newSkills, []);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].skill, 'tdd');
    assert.equal(result.conflicts[0].kind, 'file');
    assert.equal(result.conflicts[0].provider, 'claude');
  });

  test('conflict: same-name symlink pointing elsewhere', async () => {
    await makeSkill('tdd');
    // user-owned alternative skill source
    const altSource = join(tempDir, 'other-skills/tdd');
    await mkdir(altSource, { recursive: true });
    await mkdir(join(projectRoot, '.claude/skills'), { recursive: true });
    await symlink(altSource, join(projectRoot, '.claude/skills/tdd'));
    const result = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].kind, 'other-symlink');
    assert.equal(result.conflicts[0].pointsTo, altSource);
  });

  test('stale: managed symlink for a skill no longer in source', async () => {
    await makeSkill('tdd');
    await mountManagedLink('claude', 'tdd');
    await mountManagedLink('claude', 'old-skill'); // points to nowhere — still managed pattern
    const result = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.deepEqual(result.stale, ['old-skill']);
  });

  test('stale: managed symlink for a now-disabled skill', async () => {
    await makeSkill('tdd');
    await makeSkill('debugging');
    for (const provider of ['claude', 'codex', 'gemini', 'kimi']) {
      await mountManagedLink(provider, 'tdd');
    }
    await mountManagedLink('claude', 'debugging');
    const result = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {
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
      providers: {
        ...DEFAULT_MOUNT_RULES.providers,
        codex: { ...DEFAULT_MOUNT_RULES.providers.codex, enabled: false },
        gemini: { ...DEFAULT_MOUNT_RULES.providers.gemini, enabled: false },
        kimi: { ...DEFAULT_MOUNT_RULES.providers.kimi, enabled: false },
      },
    };

    const result = await detectDrift(projectRoot, skillsSource, rules, { disabledSkills: ['tdd'] });

    assert.deepEqual(result.newSkills, []);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.stale, ['tdd']);
  });

  test('disabled skill is NOT reported as newSkill even when missing', async () => {
    await makeSkill('tdd');
    await makeSkill('debugging');
    const result = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {
      disabledSkills: ['debugging'],
    });
    assert.deepEqual(result.newSkills, ['tdd']);
  });

  test('driftHash stable across runs with same input', async () => {
    await makeSkill('tdd');
    const a = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    const b = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.equal(a.driftHash, b.driftHash);
  });

  test('driftHash differs when source set changes', async () => {
    await makeSkill('tdd');
    const a = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    await makeSkill('debugging');
    const b = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.notEqual(a.driftHash, b.driftHash);
  });

  test('driftHash differs when disabled set changes', async () => {
    await makeSkill('tdd');
    await makeSkill('debugging');
    const a = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    const b = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES, {
      disabledSkills: ['debugging'],
    });
    assert.notEqual(a.driftHash, b.driftHash);
  });

  test('driftHash differs when mount policy changes', async () => {
    await makeSkill('tdd');
    const a = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    const changedRules = {
      ...DEFAULT_MOUNT_RULES,
      providers: {
        ...DEFAULT_MOUNT_RULES.providers,
        claude: { enabled: true, path: '.custom-claude/skills' },
      },
    };
    const b = await detectDrift(projectRoot, skillsSource, changedRules);
    assert.notEqual(a.driftHash, b.driftHash);
  });

  test('isIgnored=true when projectState.ignoredDriftHash matches current driftHash', async () => {
    await makeSkill('tdd');
    const first = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    await markDriftIgnored(projectRoot, first.driftHash);
    const second = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.equal(second.isIgnored, true);
  });

  test('isIgnored=false after source changes (hash diverges)', async () => {
    await makeSkill('tdd');
    const first = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    await markDriftIgnored(projectRoot, first.driftHash);
    await makeSkill('debugging');
    const second = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    assert.equal(second.isIgnored, false, 'new source skill should reset ignore');
  });

  test('isIgnored=false after filesystem drift details change without source or policy changes', async () => {
    await makeSkill('tdd');
    const missing = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);
    await markDriftIgnored(projectRoot, missing.driftHash);

    await mkdir(join(projectRoot, '.claude/skills/tdd'), { recursive: true });
    await writeFile(join(projectRoot, '.claude/skills/tdd/local.md'), 'local blocker');

    const blocked = await detectDrift(projectRoot, skillsSource, DEFAULT_MOUNT_RULES);

    assert.notEqual(blocked.driftHash, missing.driftHash);
    assert.equal(blocked.isIgnored, false, 'new filesystem blocker should reset ignore');
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
      providers: {
        ...DEFAULT_MOUNT_RULES.providers,
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };
    const result = await detectDrift(projectRoot, skillsSource, rules);
    // claude/codex/gemini have no managed symlinks → newSkill
    // kimi has one but it's disabled, so not counted
    assert.deepEqual(result.newSkills, ['tdd']);
  });

  test('all standard providers disabled reports no newSkills', async () => {
    await makeSkill('tdd');
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      providers: Object.fromEntries(
        Object.entries(DEFAULT_MOUNT_RULES.providers).map(([id, provider]) => [id, { ...provider, enabled: false }]),
      ),
    };
    const result = await detectDrift(projectRoot, skillsSource, rules);
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
      providers: Object.fromEntries(
        Object.entries(DEFAULT_MOUNT_RULES.providers).map(([id, provider]) => [id, { ...provider, enabled: false }]),
      ),
      customPaths: [{ alias: 'acp', path: customDir }],
    };

    const result = await detectDrift(projectRoot, skillsSource, rules);

    assert.deepEqual(result.newSkills, ['tdd']);
    assert.equal(result.conflicts.length, 1);
    assert.equal(result.conflicts[0].skill, 'debugging');
    assert.equal(result.conflicts[0].kind, 'directory');
    assert.equal(result.conflicts[0].provider, 'acp');
    assert.deepEqual(result.stale, ['old-skill']);
  });

  test('driftHash differs when custom mount paths change', async () => {
    await makeSkill('tdd');
    const baseRules = {
      ...DEFAULT_MOUNT_RULES,
      providers: Object.fromEntries(
        Object.entries(DEFAULT_MOUNT_RULES.providers).map(([id, provider]) => [id, { ...provider, enabled: false }]),
      ),
      customPaths: [{ alias: 'acp', path: join(projectRoot, 'custom-a', 'skills') }],
    };
    const changedRules = {
      ...baseRules,
      customPaths: [{ alias: 'acp', path: join(projectRoot, 'custom-b', 'skills') }],
    };

    const a = await detectDrift(projectRoot, skillsSource, baseRules);
    const b = await detectDrift(projectRoot, skillsSource, changedRules);

    assert.notEqual(a.driftHash, b.driftHash);
  });
});
