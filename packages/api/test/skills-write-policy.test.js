import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { resolveSyncSkillMountPaths } from '../dist/routes/skills-write.js';

describe('skills-write sync-skill mount policy', () => {
  test('inherits global Cat Cafe mountPaths when the external project has no local skill entry', () => {
    const globalSkill = {
      id: 'debugging',
      type: 'skill',
      enabled: true,
      source: 'cat-cafe',
      mountPaths: ['claude'],
    };

    assert.deepEqual(resolveSyncSkillMountPaths(null, globalSkill), ['claude']);
  });

  test('project-local mountPaths is authoritative even when broader than global', () => {
    // F228: Global is a cascade default, NOT a hard constraint.
    // Project-local mountPaths is authoritative when present.
    const projectSkill = {
      id: 'debugging',
      type: 'skill',
      enabled: true,
      source: 'cat-cafe',
      mountPaths: ['claude', 'codex'],
    };
    const globalSkill = {
      id: 'debugging',
      type: 'skill',
      enabled: true,
      source: 'cat-cafe',
      mountPaths: ['claude'],
    };

    assert.deepEqual(resolveSyncSkillMountPaths(projectSkill, globalSkill), ['claude', 'codex']);
  });

  test('preserves an explicit empty project mount policy', () => {
    const projectSkill = {
      id: 'debugging',
      type: 'skill',
      enabled: true,
      source: 'cat-cafe',
      mountPaths: [],
    };
    const globalSkill = {
      id: 'debugging',
      type: 'skill',
      enabled: true,
      source: 'cat-cafe',
      mountPaths: ['claude'],
    };

    assert.deepEqual(resolveSyncSkillMountPaths(projectSkill, globalSkill), []);
  });

  test('falls back to enabled mount rules when no project or global policy exists', () => {
    const globalSkill = {
      id: 'debugging',
      type: 'skill',
      enabled: true,
      source: 'cat-cafe',
    };

    assert.equal(resolveSyncSkillMountPaths(null, globalSkill), undefined);
  });
});
