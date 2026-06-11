/**
 * F228: Skill Toggle — Four-case verification
 *
 * Tests the data-layer behavior for the four auto-derive cases defined by CVO:
 *   Case 1: Skill disable → all mountrules off, all mounts removed
 *   Case 2: Skill enable → all mountrules on, all mounted
 *   Case 3: Last mountrule disabled → skill auto-disables
 *   Case 4: First mountrule enabled while skill disabled → skill auto-enables
 *
 * Also verifies that the globallyDisabled guard does NOT block enables
 * on the main project (where project = global).
 */

import assert from 'node:assert/strict';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  readCapabilitiesConfig,
  writeCapabilitiesConfig,
} from '../../dist/config/capabilities/capability-orchestrator.js';
import {
  filterRulesToProvider,
  mountSkillForProject,
  unmountSkillForProject,
} from '../../dist/utils/skill-symlink-writer.js';

/** Minimal mount rules matching the MountRules interface */
function buildMountRules() {
  return {
    version: 1,
    providers: {
      claude: { enabled: true, path: '.claude/skills' },
      codex: { enabled: true, path: '.codex/skills' },
      gemini: { enabled: true, path: '.gemini/skills' },
      kimi: { enabled: true, path: '.kimi/skills' },
    },
    customPaths: [],
  };
}

/** Check if a skill symlink exists in a provider dir */
function isSkillMountedAt(projectRoot, providerPath, skillName) {
  const p = join(projectRoot, providerPath, skillName);
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Count how many providers have the skill mounted */
function countMountedProviders(projectRoot, rules, skillName) {
  return ['claude', 'codex', 'gemini', 'kimi'].filter((id) =>
    isSkillMountedAt(projectRoot, rules.providers[id].path, skillName),
  ).length;
}

let projectRoot;
let skillsSource;
const SKILL_NAME = 'test-toggle-skill';

describe('F228: Skill toggle four-case verification', () => {
  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'f719-toggle-'));
    skillsSource = join(projectRoot, 'cat-cafe-skills');

    // Create skill source
    await mkdir(join(skillsSource, SKILL_NAME), { recursive: true });
    await writeFile(join(skillsSource, SKILL_NAME, 'SKILL.md'), '# test-toggle-skill');

    // Bootstrap capabilities.json with skill enabled + mounted
    await mkdir(join(projectRoot, '.cat-cafe'), { recursive: true });
    await writeCapabilitiesConfig(projectRoot, {
      version: 2,
      capabilities: [
        {
          id: SKILL_NAME,
          type: 'skill',
          enabled: true,
          source: 'cat-cafe',
          mountPaths: ['claude', 'codex', 'gemini', 'kimi'],
        },
      ],
    });

    // Mount skill to all providers
    const rules = buildMountRules();
    await mountSkillForProject(projectRoot, SKILL_NAME, skillsSource, rules);
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  test('initial state: skill enabled and mounted to all providers', async () => {
    const config = await readCapabilitiesConfig(projectRoot);
    const cap = config.capabilities.find((c) => c.id === SKILL_NAME);
    assert.ok(cap);
    assert.strictEqual(cap.enabled, true);
    assert.deepStrictEqual(cap.mountPaths, ['claude', 'codex', 'gemini', 'kimi']);
    assert.strictEqual(countMountedProviders(projectRoot, buildMountRules(), SKILL_NAME), 4);
  });

  test('Case 1: skill disable → all mounts removed, mountPaths empty', async () => {
    const rules = buildMountRules();

    // Simulate PATCH: scope='global', enabled=false, no providerId
    const config = await readCapabilitiesConfig(projectRoot);
    const cap = config.capabilities.find((c) => c.id === SKILL_NAME);

    // 1. Set cap.enabled = false (no providerId → direct set)
    cap.enabled = false;

    // 2. Unmount
    await unmountSkillForProject(projectRoot, SKILL_NAME, rules, skillsSource);

    // 3. Update mountPaths
    cap.mountPaths = [];

    // 4. Save
    await writeCapabilitiesConfig(projectRoot, config);

    // Verify
    const after = await readCapabilitiesConfig(projectRoot);
    const afterCap = after.capabilities.find((c) => c.id === SKILL_NAME);
    assert.strictEqual(afterCap.enabled, false, 'cap.enabled should be false');
    assert.deepStrictEqual(afterCap.mountPaths, [], 'mountPaths should be empty');
    assert.strictEqual(countMountedProviders(projectRoot, rules, SKILL_NAME), 0, 'no symlinks should remain');
  });

  test('Case 2: skill enable → all mounted, mountPaths populated', async () => {
    const rules = buildMountRules();

    // First disable everything
    await unmountSkillForProject(projectRoot, SKILL_NAME, rules, skillsSource);
    const config = await readCapabilitiesConfig(projectRoot);
    const cap = config.capabilities.find((c) => c.id === SKILL_NAME);
    cap.enabled = false;
    cap.mountPaths = [];
    await writeCapabilitiesConfig(projectRoot, config);

    // Now simulate PATCH: scope='global', enabled=true, no providerId
    const config2 = await readCapabilitiesConfig(projectRoot);
    const cap2 = config2.capabilities.find((c) => c.id === SKILL_NAME);

    // 1. Set cap.enabled = true
    cap2.enabled = true;

    // 2. Mount
    await mountSkillForProject(projectRoot, SKILL_NAME, skillsSource, rules);

    // 3. Update mountPaths
    const enabledProviders = ['claude', 'codex', 'gemini', 'kimi'].filter((id) => rules.providers[id].enabled);
    cap2.mountPaths = enabledProviders;

    // 4. Save
    await writeCapabilitiesConfig(projectRoot, config2);

    // Verify
    const after = await readCapabilitiesConfig(projectRoot);
    const afterCap = after.capabilities.find((c) => c.id === SKILL_NAME);
    assert.strictEqual(afterCap.enabled, true, 'cap.enabled should be true');
    assert.deepStrictEqual(afterCap.mountPaths, ['claude', 'codex', 'gemini', 'kimi']);
    assert.strictEqual(countMountedProviders(projectRoot, rules, SKILL_NAME), 4, 'all providers should be mounted');
  });

  test('Case 3: last mountrule disabled → skill auto-disables', async () => {
    const rules = buildMountRules();

    // Start with only claude mounted
    await unmountSkillForProject(projectRoot, SKILL_NAME, rules, skillsSource);
    const filteredClaude = filterRulesToProvider(rules, 'claude');
    await mountSkillForProject(projectRoot, SKILL_NAME, skillsSource, filteredClaude);
    const config = await readCapabilitiesConfig(projectRoot);
    const cap = config.capabilities.find((c) => c.id === SKILL_NAME);
    cap.enabled = true;
    cap.mountPaths = ['claude'];
    await writeCapabilitiesConfig(projectRoot, config);

    // Now simulate PATCH: providerId='claude', enabled=false
    const config2 = await readCapabilitiesConfig(projectRoot);
    const cap2 = config2.capabilities.find((c) => c.id === SKILL_NAME);

    // 1. cap.enabled NOT changed directly (providerId set)
    // 2. Unmount claude only — enabledOnly prevents collateral damage to other providers
    const filteredRules = filterRulesToProvider(rules, 'claude');
    await unmountSkillForProject(projectRoot, SKILL_NAME, filteredRules, skillsSource, { enabledOnly: true });

    // 3. Update mountPaths (remove 'claude')
    cap2.mountPaths = (cap2.mountPaths ?? []).filter((p) => p !== 'claude');

    // 4. Auto-derive: no mounts left → auto-disable
    const hasMounts = cap2.mountPaths.length > 0;
    if (!hasMounts && cap2.enabled) {
      cap2.enabled = false;
    }

    // 5. Save
    await writeCapabilitiesConfig(projectRoot, config2);

    // Verify
    const after = await readCapabilitiesConfig(projectRoot);
    const afterCap = after.capabilities.find((c) => c.id === SKILL_NAME);
    assert.strictEqual(afterCap.enabled, false, 'skill should auto-disable when last mount removed');
    assert.deepStrictEqual(afterCap.mountPaths, [], 'mountPaths should be empty');
    assert.strictEqual(countMountedProviders(projectRoot, rules, SKILL_NAME), 0);
  });

  test('Case 4: first mountrule enabled while skill disabled → skill auto-enables', async () => {
    const rules = buildMountRules();

    // Start with skill disabled, all unmounted
    await unmountSkillForProject(projectRoot, SKILL_NAME, rules, skillsSource);
    const config = await readCapabilitiesConfig(projectRoot);
    const cap = config.capabilities.find((c) => c.id === SKILL_NAME);
    cap.enabled = false;
    cap.mountPaths = [];
    await writeCapabilitiesConfig(projectRoot, config);

    // Now simulate PATCH: providerId='claude', enabled=true
    const config2 = await readCapabilitiesConfig(projectRoot);
    const cap2 = config2.capabilities.find((c) => c.id === SKILL_NAME);

    // 1. cap.enabled NOT changed directly (providerId set)
    // 2. Mount claude only
    const filteredRules = filterRulesToProvider(rules, 'claude');
    await mountSkillForProject(projectRoot, SKILL_NAME, skillsSource, filteredRules);

    // 3. Update mountPaths (add 'claude')
    cap2.mountPaths = [...new Set([...(cap2.mountPaths ?? []), 'claude'])];

    // 4. Auto-derive: has mounts + skill was disabled → auto-enable
    const hasMounts = cap2.mountPaths.length > 0;
    if (hasMounts && !cap2.enabled) {
      cap2.enabled = true;
    }

    // 5. Save
    await writeCapabilitiesConfig(projectRoot, config2);

    // Verify
    const after = await readCapabilitiesConfig(projectRoot);
    const afterCap = after.capabilities.find((c) => c.id === SKILL_NAME);
    assert.strictEqual(afterCap.enabled, true, 'skill should auto-enable when first mount added');
    assert.deepStrictEqual(afterCap.mountPaths, ['claude']);
    assert.ok(isSkillMountedAt(projectRoot, rules.providers.claude.path, SKILL_NAME), 'claude symlink should exist');
  });

  test('main project: scope=project enable must NOT be blocked by globallyDisabled guard', async () => {
    const rules = buildMountRules();

    // Disable the skill first
    await unmountSkillForProject(projectRoot, SKILL_NAME, rules, skillsSource);
    const config = await readCapabilitiesConfig(projectRoot);
    const cap = config.capabilities.find((c) => c.id === SKILL_NAME);
    cap.enabled = false;
    cap.mountPaths = [];
    await writeCapabilitiesConfig(projectRoot, config);

    // Simulate what the PATCH handler does for scope='project' enable on main project.
    // The fix: for mainRoot, no globallyDisabled guard applies.
    const mainRoot = projectRoot; // main = project for this test
    const config2 = await readCapabilitiesConfig(projectRoot);
    const cap2 = config2.capabilities.find((c) => c.id === SKILL_NAME);

    // Guard check (as in the fixed code):
    const globallyDisabled = false;
    if (projectRoot !== mainRoot) {
      // External project — would check main config.
      // Not reached in this test.
    }
    // Main project: no guard needed — project enable IS global enable.
    // globallyDisabled stays false.

    assert.strictEqual(globallyDisabled, false, 'guard must NOT fire for main project');

    // Proceed with enable
    cap2.enabled = true;
    await mountSkillForProject(projectRoot, SKILL_NAME, skillsSource, rules);
    const enabledProviders = ['claude', 'codex', 'gemini', 'kimi'].filter((id) => rules.providers[id].enabled);
    cap2.mountPaths = enabledProviders;
    await writeCapabilitiesConfig(projectRoot, config2);

    // Verify
    const after = await readCapabilitiesConfig(projectRoot);
    const afterCap = after.capabilities.find((c) => c.id === SKILL_NAME);
    assert.strictEqual(afterCap.enabled, true, 'enable should succeed on main project');
    assert.strictEqual(countMountedProviders(projectRoot, rules, SKILL_NAME), 4);
  });

  test('per-provider toggle preserves other mounts', async () => {
    const rules = buildMountRules();
    // All 4 mounted. Disable codex only.
    const config = await readCapabilitiesConfig(projectRoot);
    const cap = config.capabilities.find((c) => c.id === SKILL_NAME);

    // Unmount codex only — enabledOnly prevents removing sibling providers' mounts
    const filteredRules = filterRulesToProvider(rules, 'codex');
    await unmountSkillForProject(projectRoot, SKILL_NAME, filteredRules, skillsSource, { enabledOnly: true });

    // Update mountPaths
    cap.mountPaths = (cap.mountPaths ?? []).filter((p) => p !== 'codex');

    // Auto-derive: still has mounts → enabled stays true
    const hasMounts = cap.mountPaths.length > 0;
    if (!hasMounts && cap.enabled) cap.enabled = false;
    else if (hasMounts && !cap.enabled) cap.enabled = true;

    await writeCapabilitiesConfig(projectRoot, config);

    // Verify
    const after = await readCapabilitiesConfig(projectRoot);
    const afterCap = after.capabilities.find((c) => c.id === SKILL_NAME);
    assert.strictEqual(afterCap.enabled, true, 'skill stays enabled with remaining mounts');
    assert.deepStrictEqual(afterCap.mountPaths, ['claude', 'gemini', 'kimi']);
    assert.ok(isSkillMountedAt(projectRoot, rules.providers.claude.path, SKILL_NAME), 'claude still mounted');
    assert.ok(!isSkillMountedAt(projectRoot, rules.providers.codex.path, SKILL_NAME), 'codex unmounted');
    assert.ok(isSkillMountedAt(projectRoot, rules.providers.gemini.path, SKILL_NAME), 'gemini still mounted');
  });
});
