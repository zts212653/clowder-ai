/**
 * F228 / Issue #719 — Skill mount/unmount idempotent writers
 */

import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { DEFAULT_MOUNT_RULES } from '@cat-cafe/shared';
import {
  convertManagedDirectoryLevelSkillMountsForPolicy,
  mountSkillForProject,
  unmountSkillForProject,
} from '../../dist/utils/skill-symlink-writer.js';

let tempDir;
let projectRoot;
let skillsSource;

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

describe('SkillSymlinkWriter (F228 / #719)', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'skill-symlink-writer-'));
    projectRoot = join(tempDir, 'project');
    skillsSource = join(tempDir, 'cat-cafe-skills');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(join(skillsSource, 'tdd'), { recursive: true });
    await writeFile(join(skillsSource, 'tdd', 'SKILL.md'), '# TDD');
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('mountSkillForProject creates symlinks in all 4 enabled standard providers', async () => {
    const result = await mountSkillForProject(projectRoot, 'tdd', skillsSource, DEFAULT_MOUNT_RULES);
    assert.equal(result.mounted.length, 4);
    for (const p of ['claude', 'codex', 'gemini', 'kimi']) {
      const link = join(projectRoot, `.${p}/skills/tdd`);
      assert.ok(await exists(link), `${p} symlink should exist`);
      assert.equal(await readlink(link), expectedSymlinkTarget(link, join(skillsSource, 'tdd')));
    }
  });

  test('mountSkillForProject skips disabled providers', async () => {
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      providers: {
        ...DEFAULT_MOUNT_RULES.providers,
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };
    const result = await mountSkillForProject(projectRoot, 'tdd', skillsSource, rules);
    assert.equal(result.mounted.length, 3);
    assert.equal(await exists(join(projectRoot, '.kimi/skills/tdd')), false);
    assert.equal(await exists(join(projectRoot, '.kimi')), false, 'no .kimi dir created');
  });

  test('mountSkillForProject is idempotent — running twice yields same result', async () => {
    const first = await mountSkillForProject(projectRoot, 'tdd', skillsSource, DEFAULT_MOUNT_RULES);
    const second = await mountSkillForProject(projectRoot, 'tdd', skillsSource, DEFAULT_MOUNT_RULES);
    assert.deepEqual(first.mounted.sort(), second.mounted.sort());
  });

  test('unmountSkillForProject removes all symlinks created by mount', async () => {
    await mountSkillForProject(projectRoot, 'tdd', skillsSource, DEFAULT_MOUNT_RULES);
    const result = await unmountSkillForProject(projectRoot, 'tdd', DEFAULT_MOUNT_RULES, skillsSource);
    assert.equal(result.unmounted.length, 4);
    for (const p of ['claude', 'codex', 'gemini', 'kimi']) {
      assert.equal(await exists(join(projectRoot, `.${p}/skills/tdd`)), false, `${p} symlink should be removed`);
    }
  });

  test('unmountSkillForProject preserves same-name user symlinks outside the managed source', async () => {
    const userSource = join(tempDir, 'user-skills');
    await mkdir(join(userSource, 'tdd'), { recursive: true });
    await writeFile(join(userSource, 'tdd', 'SKILL.md'), '# User TDD');
    const linkPath = join(projectRoot, '.claude/skills/tdd');
    const userTarget = expectedSymlinkTarget(linkPath, join(userSource, 'tdd'));
    await mkdir(dirname(linkPath), { recursive: true });
    await symlink(userTarget, linkPath);

    const result = await unmountSkillForProject(projectRoot, 'tdd', DEFAULT_MOUNT_RULES, skillsSource);

    assert.deepEqual(result.unmounted, []);
    assert.equal(await readlink(linkPath), userTarget, 'user-owned symlink must not be removed');
  });

  test('unmountSkillForProject is idempotent — running twice does not error', async () => {
    await mountSkillForProject(projectRoot, 'tdd', skillsSource, DEFAULT_MOUNT_RULES);
    const first = await unmountSkillForProject(projectRoot, 'tdd', DEFAULT_MOUNT_RULES, skillsSource);
    const second = await unmountSkillForProject(projectRoot, 'tdd', DEFAULT_MOUNT_RULES, skillsSource);
    assert.equal(first.unmounted.length, 4);
    assert.equal(second.unmounted.length, 0, 'second call finds nothing to remove');
  });

  test('unmountSkillForProject removes stale links from disabled providers too', async () => {
    // pre-create symlinks in ALL providers, including kimi
    await mountSkillForProject(projectRoot, 'tdd', skillsSource, DEFAULT_MOUNT_RULES);
    // now unmount with kimi disabled
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      providers: {
        ...DEFAULT_MOUNT_RULES.providers,
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };
    const result = await unmountSkillForProject(projectRoot, 'tdd', rules, skillsSource);
    assert.equal(result.unmounted.length, 4);
    assert.equal(
      await exists(join(projectRoot, '.kimi/skills/tdd')),
      false,
      'disabled provider symlink should be removed',
    );
  });

  test('unmountSkillForProject fails when a symlink cannot be deleted', async (t) => {
    if (process.platform === 'win32') {
      t.skip('directory mode bits do not reliably block unlink on Windows');
      return;
    }
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      providers: {
        ...DEFAULT_MOUNT_RULES.providers,
        codex: { ...DEFAULT_MOUNT_RULES.providers.codex, enabled: false },
        gemini: { ...DEFAULT_MOUNT_RULES.providers.gemini, enabled: false },
        kimi: { ...DEFAULT_MOUNT_RULES.providers.kimi, enabled: false },
      },
    };
    await mountSkillForProject(projectRoot, 'tdd', skillsSource, rules);
    const skillsDir = join(projectRoot, '.claude/skills');
    const linkPath = join(skillsDir, 'tdd');
    await chmod(skillsDir, 0o555);

    try {
      await assert.rejects(
        () => unmountSkillForProject(projectRoot, 'tdd', rules, skillsSource),
        /EACCES|EPERM/,
        'failed unlink must make unmount fail instead of reporting success',
      );
      assert.equal((await lstat(linkPath)).isSymbolicLink(), true, 'link should still be present after failed unlink');
    } finally {
      await chmod(skillsDir, 0o755).catch(() => {});
    }
  });

  test('mountSkillForProject rejects a user-owned directory at the target path', async () => {
    const localSkillDir = join(projectRoot, '.claude/skills/tdd');
    await mkdir(localSkillDir, { recursive: true });
    await writeFile(join(localSkillDir, 'old-file.txt'), 'old');

    await assert.rejects(() => mountSkillForProject(projectRoot, 'tdd', skillsSource, DEFAULT_MOUNT_RULES), /Refusing/);

    const stat = await lstat(localSkillDir);
    assert.equal(stat.isDirectory(), true, 'pre-existing user directory should be preserved');
    assert.equal(await readFile(join(localSkillDir, 'old-file.txt'), 'utf8'), 'old');
    assert.equal(await exists(join(projectRoot, '.codex/skills/tdd')), false, 'later providers should not be mounted');
  });

  test('mountSkillForProject rejects a same-name user symlink at the target path', async () => {
    const userSource = join(tempDir, 'user-skills');
    await mkdir(join(userSource, 'tdd'), { recursive: true });
    await writeFile(join(userSource, 'tdd', 'SKILL.md'), '# User TDD');
    const linkPath = join(projectRoot, '.claude/skills/tdd');
    const userTarget = expectedSymlinkTarget(linkPath, join(userSource, 'tdd'));
    await mkdir(dirname(linkPath), { recursive: true });
    await symlink(userTarget, linkPath);

    await assert.rejects(() => mountSkillForProject(projectRoot, 'tdd', skillsSource, DEFAULT_MOUNT_RULES), /Refusing/);

    assert.equal(await readlink(linkPath), userTarget, 'pre-existing user symlink should be preserved');
    assert.equal(await exists(join(projectRoot, '.codex/skills/tdd')), false, 'later providers should not be mounted');
  });

  test('mountSkillForProject does NOT remove a stale matching symlink, just confirms it', async () => {
    // mount once
    await mountSkillForProject(projectRoot, 'tdd', skillsSource, DEFAULT_MOUNT_RULES);
    const before = await readlink(join(projectRoot, '.claude/skills/tdd'));
    // mount again — should be no-op since symlink target matches
    await mountSkillForProject(projectRoot, 'tdd', skillsSource, DEFAULT_MOUNT_RULES);
    const after = await readlink(join(projectRoot, '.claude/skills/tdd'));
    assert.equal(before, after);
  });

  test('mountSkillForProject preserves sync-style relative symlink targets', async () => {
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      providers: {
        ...DEFAULT_MOUNT_RULES.providers,
        codex: { ...DEFAULT_MOUNT_RULES.providers.codex, enabled: false },
        gemini: { ...DEFAULT_MOUNT_RULES.providers.gemini, enabled: false },
        kimi: { ...DEFAULT_MOUNT_RULES.providers.kimi, enabled: false },
      },
    };
    const skillsDir = join(projectRoot, '.claude/skills');
    const linkPath = join(skillsDir, 'tdd');
    const relativeTarget = relative(skillsDir, join(skillsSource, 'tdd'));
    await mkdir(skillsDir, { recursive: true });
    await symlink(relativeTarget, linkPath);

    await mountSkillForProject(projectRoot, 'tdd', skillsSource, rules);

    assert.equal(await readlink(linkPath), relativeTarget);
  });

  test('mountSkillForProject rolls back earlier provider mounts when a later provider fails', async () => {
    await mkdir(join(projectRoot, '.codex'), { recursive: true });
    await symlink(join(tempDir, 'missing-skills-source'), join(projectRoot, '.codex/skills'));

    await assert.rejects(() => mountSkillForProject(projectRoot, 'tdd', skillsSource, DEFAULT_MOUNT_RULES));

    assert.equal(
      await exists(join(projectRoot, '.claude/skills/tdd')),
      false,
      'partial mount created before a later provider failure should be rolled back',
    );
  });

  test('mountSkillForProject restores replaced local entries when a later provider fails', async () => {
    const localSkillDir = join(projectRoot, '.claude/skills/tdd');
    await mkdir(localSkillDir, { recursive: true });
    await writeFile(join(localSkillDir, 'local.txt'), 'keep local skill');
    await mkdir(join(projectRoot, '.codex'), { recursive: true });
    await symlink(join(tempDir, 'missing-skills-source'), join(projectRoot, '.codex/skills'));

    await assert.rejects(() => mountSkillForProject(projectRoot, 'tdd', skillsSource, DEFAULT_MOUNT_RULES));

    const restored = await lstat(localSkillDir);
    assert.equal(restored.isDirectory(), true, 'pre-existing local skill directory should be restored');
    assert.equal(await readFile(join(localSkillDir, 'local.txt'), 'utf8'), 'keep local skill');
  });

  test('mountSkillForProject skips legacy directory-level source symlink without deleting source skill', async () => {
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
    await symlink(skillsSource, join(projectRoot, '.claude/skills'));

    await mountSkillForProject(projectRoot, 'tdd', skillsSource, rules);

    const sourceStat = await lstat(join(skillsSource, 'tdd'));
    assert.equal(sourceStat.isDirectory(), true, 'source skill directory must remain intact');
    assert.equal(await exists(join(skillsSource, 'tdd/SKILL.md')), true);
    const rootStat = await lstat(join(projectRoot, '.claude/skills'));
    assert.equal(rootStat.isSymbolicLink(), true, 'legacy directory-level mount should be preserved');
    assert.equal(await readlink(join(projectRoot, '.claude/skills')), skillsSource);
  });

  test('convertManagedDirectoryLevelSkillMountsForPolicy ignores non-managed root symlinks', async () => {
    const userSkillsRoot = join(tempDir, 'user-skills');
    const claudeSkills = join(projectRoot, '.claude/skills');
    const codexSkills = join(projectRoot, '.codex/skills');
    await mkdir(join(projectRoot, '.claude'), { recursive: true });
    await mkdir(join(projectRoot, '.codex'), { recursive: true });
    await mkdir(userSkillsRoot, { recursive: true });
    await symlink(skillsSource, claudeSkills);
    await symlink(userSkillsRoot, codexSkills);

    const result = await convertManagedDirectoryLevelSkillMountsForPolicy(
      projectRoot,
      skillsSource,
      DEFAULT_MOUNT_RULES,
      ['claude', 'codex'],
      () => ['tdd'],
    );

    assert.deepEqual(result.converted, [claudeSkills]);
    assert.equal((await lstat(claudeSkills)).isDirectory(), true, 'managed root should be converted');
    assert.equal(await exists(join(claudeSkills, 'tdd')), true, 'managed root should get per-skill link');
    assert.equal(await readlink(codexSkills), userSkillsRoot, 'user-owned directory-level symlink should be preserved');
  });
});
