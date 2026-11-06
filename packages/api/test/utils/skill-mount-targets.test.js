import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { DEFAULT_MOUNT_RULES } from '@cat-cafe/shared';
import {
  buildMountPointDirCandidates,
  buildProjectSkillMountDirs,
  buildProjectSkillMountTargets,
  buildSkillMountTargets,
  symlinkTargetFor,
} from '../../dist/utils/skill-mount.js';

const PROJECT = '/tmp/proj';
const HOME = '/home/user';

describe('buildSkillMountTargets (F228)', () => {
  test('returns 4 standard targets for DEFAULT rules', () => {
    const targets = buildSkillMountTargets(PROJECT, HOME);
    assert.equal(targets.length, 4);
    assert.deepEqual(
      targets.map((t) => t.id),
      ['claude', 'codex', 'gemini', 'kimi'],
    );
    for (const t of targets) {
      assert.equal(t.kind, 'standard');
    }
  });

  test('each standard target has [projectDir, homeDir] candidates in canonical order', () => {
    const targets = buildSkillMountTargets(PROJECT, HOME);
    const claude = targets.find((t) => t.id === 'claude');
    assert.deepEqual(claude.candidates, ['/tmp/proj/.claude/skills', '/home/user/.claude/skills']);
  });

  test('standard HOME candidates stay canonical when project mount path is customized', () => {
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        claude: { enabled: true, path: '.project-claude/skills' },
      },
    };
    const candidates = buildMountPointDirCandidates(PROJECT, HOME, rules);
    assert.deepEqual(candidates.claude, ['/tmp/proj/.project-claude/skills', '/home/user/.claude/skills']);

    const targets = buildSkillMountTargets(PROJECT, HOME, rules);
    const claude = targets.find((t) => t.id === 'claude');
    assert.deepEqual(claude.candidates, ['/tmp/proj/.project-claude/skills', '/home/user/.claude/skills']);
  });

  test('omits disabled standard mount points', () => {
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      mountPoints: {
        ...DEFAULT_MOUNT_RULES.mountPoints,
        kimi: { enabled: false, path: '.kimi/skills' },
      },
    };
    const targets = buildSkillMountTargets(PROJECT, HOME, rules);
    assert.equal(targets.length, 3);
    assert.ok(!targets.some((t) => t.id === 'kimi'));
  });

  test('appends custom targets after standard ones', () => {
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      customPaths: [{ alias: 'opencode', path: '/abs/path/skills' }],
    };
    const targets = buildSkillMountTargets(PROJECT, HOME, rules);
    assert.equal(targets.length, 5);
    const custom = targets[4];
    assert.equal(custom.id, 'opencode');
    assert.equal(custom.kind, 'custom');
    assert.deepEqual(custom.candidates, ['/abs/path/skills']);
  });

  test('expands ~ in custom path against home', () => {
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      customPaths: [{ alias: 'opencode', path: '~/.opencode/skills' }],
    };
    const targets = buildSkillMountTargets(PROJECT, HOME, rules);
    const custom = targets.find((t) => t.id === 'opencode');
    assert.deepEqual(custom.candidates, ['/home/user/.opencode/skills']);
  });

  test('resolves project-relative custom path against project root', () => {
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      customPaths: [{ alias: 'opencode', path: '.opencode/skills' }],
    };
    const targets = buildSkillMountTargets(PROJECT, HOME, rules);
    const custom = targets.find((t) => t.id === 'opencode');
    assert.deepEqual(custom.candidates, ['/tmp/proj/.opencode/skills']);
  });

  test('expands bare ~ to home root', () => {
    const rules = {
      ...DEFAULT_MOUNT_RULES,
      customPaths: [{ alias: 'home-skills', path: '~' }],
    };
    const targets = buildSkillMountTargets(PROJECT, HOME, rules);
    const custom = targets.find((t) => t.id === 'home-skills');
    assert.deepEqual(custom.candidates, ['/home/user']);
  });

  test('dedupes candidates when projectRoot equals home', () => {
    const targets = buildSkillMountTargets(HOME, HOME);
    const claude = targets.find((t) => t.id === 'claude');
    assert.equal(claude.candidates.length, 1, 'project/home overlap should collapse to one candidate');
    assert.equal(claude.candidates[0], '/home/user/.claude/skills');
  });

  test('returns empty array when all standard mount points disabled and no custom paths', () => {
    const rules = {
      version: 1,
      mountPoints: {
        claude: { enabled: false, path: '.claude/skills' },
        codex: { enabled: false, path: '.codex/skills' },
        gemini: { enabled: false, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
      customPaths: [],
    };
    const targets = buildSkillMountTargets(PROJECT, HOME, rules);
    assert.deepEqual(targets, []);
  });
});

describe('project-local skill mount dirs (F314-12: one implementation for mount, sync, drift and plugin sync)', () => {
  const rules = {
    ...DEFAULT_MOUNT_RULES,
    mountPoints: {
      ...DEFAULT_MOUNT_RULES.mountPoints,
      gemini: { enabled: false, path: '.gemini/skills' },
    },
    customPaths: [
      { alias: 'acp', path: 'agents/skills' },
      { alias: 'home-tool', path: '~/tool/skills' },
    ],
  };

  test('groups enabled standard project dirs and custom dirs by mount point; home candidates are left out', () => {
    assert.deepEqual(buildProjectSkillMountTargets(PROJECT, HOME, rules), [
      { id: 'claude', kind: 'standard', dirs: ['/tmp/proj/.claude/skills'] },
      { id: 'codex', kind: 'standard', dirs: ['/tmp/proj/.codex/skills'] },
      { id: 'kimi', kind: 'standard', dirs: ['/tmp/proj/.kimi-code/skills'] },
      { id: 'acp', kind: 'custom', dirs: ['/tmp/proj/agents/skills'] },
      { id: 'home-tool', kind: 'custom', dirs: ['/home/user/tool/skills'] },
    ]);
  });

  test('the grouped targets and the flat dir list name the same directories', () => {
    const grouped = buildProjectSkillMountTargets(PROJECT, HOME, rules).flatMap((t) => t.dirs);
    assert.deepEqual(grouped, buildProjectSkillMountDirs(PROJECT, HOME, rules));
  });

  test('cleanup dirs add the disabled standard mount points, in standard order', () => {
    assert.deepEqual(buildProjectSkillMountDirs(PROJECT, HOME, rules, { includeDisabledStandardMountPoints: true }), [
      '/tmp/proj/.claude/skills',
      '/tmp/proj/.codex/skills',
      '/tmp/proj/.gemini/skills',
      '/tmp/proj/.kimi-code/skills',
      '/tmp/proj/agents/skills',
      '/home/user/tool/skills',
    ]);
  });

  test('skill links are relative on POSIX', { skip: process.platform === 'win32' }, () => {
    assert.equal(
      symlinkTargetFor('/tmp/proj/.claude/skills/tdd', '/tmp/proj/cat-cafe-skills/tdd'),
      '../../cat-cafe-skills/tdd',
    );
  });
});
