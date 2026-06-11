import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  type CustomProviderRule,
  DEFAULT_MOUNT_RULES,
  type MountRules,
  STANDARD_PROVIDER_IDS,
  type StandardProviderId,
} from '../types/mount-rules.js';

describe('F228: MountRules type contract', () => {
  it('STANDARD_PROVIDER_IDS lists exactly claude/codex/gemini/kimi in canonical order', () => {
    assert.deepEqual([...STANDARD_PROVIDER_IDS], ['claude', 'codex', 'gemini', 'kimi']);
  });

  it('DEFAULT_MOUNT_RULES uses schema version 1', () => {
    assert.equal(DEFAULT_MOUNT_RULES.version, 1);
  });

  it('DEFAULT_MOUNT_RULES enables every standard provider with its .{provider}/skills path', () => {
    for (const id of STANDARD_PROVIDER_IDS) {
      const rule = DEFAULT_MOUNT_RULES.providers[id];
      assert.equal(rule.enabled, true, `${id} should be enabled by default`);
      assert.equal(rule.path, `.${id}/skills`, `${id} path should be .${id}/skills`);
    }
  });

  it('DEFAULT_MOUNT_RULES starts with empty customPaths', () => {
    assert.deepEqual(DEFAULT_MOUNT_RULES.customPaths, []);
  });

  it('accepts a fully custom MountRules with ACP/A2A custom paths', () => {
    const custom: CustomProviderRule = { alias: 'opencode', path: '.opencode/skills' };
    const rules: MountRules = {
      version: 1,
      providers: {
        claude: { enabled: false, path: '.claude/skills' },
        codex: { enabled: true, path: '.codex/skills' },
        gemini: { enabled: true, path: '.gemini/skills' },
        kimi: { enabled: false, path: '.kimi/skills' },
      },
      customPaths: [custom],
    };
    assert.equal(rules.providers.claude.enabled, false);
    assert.equal(rules.customPaths[0]?.alias, 'opencode');
  });

  it('StandardProviderId union narrows to expected literal set', () => {
    const all: StandardProviderId[] = ['claude', 'codex', 'gemini', 'kimi'];
    assert.equal(all.length, STANDARD_PROVIDER_IDS.length);
  });
});
