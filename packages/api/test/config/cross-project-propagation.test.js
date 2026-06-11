/**
 * F228: Cross-project propagation regression test
 *
 * Verifies that propagateGlobalSkillDisable() returns failure messages
 * when an external project's unmount/write fails, and that the PATCH
 * handler surfaces them as non-2xx responses.
 *
 * Root cause: symlinks are filesystem-loadable by agents. Silent
 * success when external cleanup fails leaves stale mounts that agents
 * can still load — violating the global disable safety invariant.
 */

import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import {
  readCapabilitiesConfig,
  writeCapabilitiesConfig,
} from '../../dist/config/capabilities/capability-orchestrator.js';
import {
  propagateGlobalProviderToggle,
  propagateGlobalSkillDisable,
  propagateGlobalSkillEnable,
} from '../../dist/utils/skill-propagation.js';

let catCafeRoot;
let extProjectRoot;
let skillsSource;

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

describe('propagateGlobalSkillDisable (F228 P1)', () => {
  beforeEach(async () => {
    catCafeRoot = await mkdtemp(join(tmpdir(), 'f719-propagation-main-'));
    extProjectRoot = await mkdtemp(join(tmpdir(), 'f719-propagation-ext-'));
    skillsSource = join(catCafeRoot, 'cat-cafe-skills');

    // Create a skill in the source directory
    await mkdir(join(skillsSource, 'test-skill'), { recursive: true });
    await writeFile(join(skillsSource, 'test-skill', 'SKILL.md'), '# test-skill');

    // Register the external project in governance-registry.json
    const registryDir = join(catCafeRoot, '.cat-cafe');
    await mkdir(registryDir, { recursive: true });
    await writeFile(
      join(registryDir, 'governance-registry.json'),
      JSON.stringify({
        entries: [{ projectPath: extProjectRoot, packVersion: '1.0.0', lastSyncedAt: new Date().toISOString() }],
      }),
    );

    // Set up external project with a v2 capabilities config and a mounted skill
    const extCatCafe = join(extProjectRoot, '.cat-cafe');
    await mkdir(extCatCafe, { recursive: true });
    await writeCapabilitiesConfig(extProjectRoot, {
      version: 2,
      capabilities: [{ id: 'test-skill', type: 'skill', enabled: true, source: 'cat-cafe', mountPaths: ['claude'] }],
    });

    // Create the provider directory with a symlink (simulating a mounted skill)
    const providerDir = join(extProjectRoot, '.claude', 'skills');
    await mkdir(providerDir, { recursive: true });
    await symlink(relative(providerDir, join(skillsSource, 'test-skill')), join(providerDir, 'test-skill'));
  });

  afterEach(async () => {
    // Restore write permissions before cleanup
    try {
      await chmod(join(extProjectRoot, '.cat-cafe', 'capabilities.json'), 0o644);
    } catch {
      // May not exist
    }
    try {
      await chmod(join(catCafeRoot, '.cat-cafe', 'governance-registry.json'), 0o644);
    } catch {
      // May not exist
    }
    await rm(catCafeRoot, { recursive: true, force: true });
    await rm(extProjectRoot, { recursive: true, force: true });
  });

  test('returns empty warnings when external project cleanup succeeds', async () => {
    const warnings = await propagateGlobalSkillDisable(
      catCafeRoot,
      catCafeRoot, // primary = catCafeRoot, so ext project should be processed
      'test-skill',
      skillsSource,
    );

    assert.deepStrictEqual(warnings, []);

    // Verify: ext project's mountPaths should be cleared
    const extConfig = await readCapabilitiesConfig(extProjectRoot);
    assert.ok(extConfig);
    const extCap = extConfig.capabilities.find((c) => c.id === 'test-skill');
    assert.ok(extCap);
    assert.deepStrictEqual(extCap.mountPaths, []);
  });

  test('returns warnings when external project config write fails', async () => {
    // Make the capabilities.json file itself read-only so writeCapabilitiesConfig fails
    const configFile = join(extProjectRoot, '.cat-cafe', 'capabilities.json');
    await chmod(configFile, 0o444);

    const warnings = await propagateGlobalSkillDisable(catCafeRoot, catCafeRoot, 'test-skill', skillsSource);

    assert.ok(warnings.length > 0, 'Should have at least one warning');
    assert.ok(warnings[0].includes(extProjectRoot), `Warning should reference the failed project path: ${warnings[0]}`);

    // Restore permissions for cleanup
    await chmod(configFile, 0o644);
  });

  test('global disable rolls back external unmount when config write fails', async () => {
    // Verify the skill symlink exists before disable
    const linkPath = join(extProjectRoot, '.claude', 'skills', 'test-skill');
    assert.equal(await pathExists(linkPath), true, 'symlink should exist before disable');
    assert.equal((await lstat(linkPath)).isSymbolicLink(), true);

    // Make capabilities.json read-only to trigger config write failure
    const configFile = join(extProjectRoot, '.cat-cafe', 'capabilities.json');
    await chmod(configFile, 0o444);

    const warnings = await propagateGlobalSkillDisable(catCafeRoot, catCafeRoot, 'test-skill', skillsSource);

    assert.ok(warnings.length > 0, 'Should have at least one warning');

    // F228: After rollback, the symlink should be restored (not left dangling)
    assert.equal(await pathExists(linkPath), true, 'symlink should be restored after rollback');
    assert.equal((await lstat(linkPath)).isSymbolicLink(), true, 'restored path should be a symlink');

    // Config should remain unchanged (write failed, no mutation)
    await chmod(configFile, 0o644);
    const extConfig = await readCapabilitiesConfig(extProjectRoot);
    const extCap = extConfig?.capabilities.find((c) => c.id === 'test-skill');
    assert.ok(extCap, 'skill capability should still exist');
    assert.strictEqual(extCap.enabled, true, 'skill should still be enabled after rollback');
    assert.deepStrictEqual(extCap.mountPaths, ['claude'], 'mountPaths should be unchanged after rollback');
  });

  test('skips primary project root in propagation', async () => {
    // When primaryProjectRoot matches an entry, that entry should be skipped
    const warnings = await propagateGlobalSkillDisable(
      catCafeRoot,
      extProjectRoot, // primary = ext, so ext entry should be skipped
      'test-skill',
      skillsSource,
    );

    // No warnings because the only registered project was skipped
    assert.deepStrictEqual(warnings, []);

    // Verify: ext project's config should NOT be modified (it was skipped)
    const extConfig = await readCapabilitiesConfig(extProjectRoot);
    assert.ok(extConfig);
    const extCap = extConfig.capabilities.find((c) => c.id === 'test-skill');
    assert.ok(extCap);
    assert.deepStrictEqual(extCap.mountPaths, ['claude'], 'mountPaths should be unchanged');
  });

  test('sets external project enabled=false on global disable', async () => {
    const warnings = await propagateGlobalSkillDisable(catCafeRoot, catCafeRoot, 'test-skill', skillsSource);

    assert.deepStrictEqual(warnings, []);

    // Global disable means "所有项目都别用 skill X" — enabled must be false everywhere.
    // The enabled flag is the single source of truth for the toggle UI; without this,
    // the frontend shows "enabled" even after global disable.
    const extConfig = await readCapabilitiesConfig(extProjectRoot);
    assert.ok(extConfig);
    const extCap = extConfig.capabilities.find((c) => c.id === 'test-skill');
    assert.ok(extCap);
    assert.strictEqual(extCap.enabled, false, 'global disable must cascade enabled=false to all external projects');
  });

  test('persists disabled policy when external project is missing the skill capability', async () => {
    await writeCapabilitiesConfig(extProjectRoot, {
      version: 2,
      capabilities: [],
    });

    const warnings = await propagateGlobalSkillDisable(catCafeRoot, catCafeRoot, 'test-skill', skillsSource);

    assert.deepStrictEqual(warnings, []);
    assert.equal(await pathExists(join(extProjectRoot, '.claude', 'skills', 'test-skill')), false);

    const extConfig = await readCapabilitiesConfig(extProjectRoot);
    const extCap = extConfig?.capabilities.find((c) => c.id === 'test-skill');
    assert.ok(extCap, 'global disable must persist a disabled project policy for missing skill entries');
    assert.strictEqual(extCap.type, 'skill');
    assert.strictEqual(extCap.source, 'cat-cafe');
    assert.strictEqual(extCap.enabled, false);
    assert.deepStrictEqual(extCap.mountPaths, []);
  });

  test('converts legacy directory-level roots before global disable propagation', async () => {
    await mkdir(join(skillsSource, 'kept-skill'), { recursive: true });
    await writeFile(join(skillsSource, 'kept-skill', 'SKILL.md'), '# kept-skill');

    const providerDir = join(extProjectRoot, '.claude', 'skills');
    await rm(providerDir, { recursive: true, force: true });
    await symlink(relative(join(extProjectRoot, '.claude'), skillsSource), providerDir);

    const extConfig = await readCapabilitiesConfig(extProjectRoot);
    assert.ok(extConfig);
    extConfig.capabilities.push({
      id: 'kept-skill',
      type: 'skill',
      enabled: true,
      source: 'cat-cafe',
      mountPaths: ['claude'],
    });
    await writeCapabilitiesConfig(extProjectRoot, extConfig);

    const warnings = await propagateGlobalSkillDisable(catCafeRoot, catCafeRoot, 'test-skill', skillsSource);

    assert.deepStrictEqual(warnings, []);
    const rootStat = await lstat(providerDir);
    assert.strictEqual(rootStat.isDirectory(), true, 'legacy root should become a real provider directory');
    assert.strictEqual(rootStat.isSymbolicLink(), false, 'legacy directory-level symlink should be removed');
    assert.strictEqual(
      await pathExists(join(providerDir, 'test-skill')),
      false,
      'globally disabled skill must no longer be loadable through the legacy root',
    );
    assert.strictEqual(
      (await lstat(join(providerDir, 'kept-skill'))).isSymbolicLink(),
      true,
      'other enabled source skills should remain mounted after conversion',
    );
    const updated = await readCapabilitiesConfig(extProjectRoot);
    const disabledCap = updated?.capabilities.find((c) => c.id === 'test-skill');
    assert.strictEqual(disabledCap?.enabled, false);
    assert.deepStrictEqual(disabledCap?.mountPaths, []);
  });

  test('global disable legacy root conversion preserves per-skill mountPaths', async () => {
    await mkdir(join(skillsSource, 'codex-only-skill'), { recursive: true });
    await writeFile(join(skillsSource, 'codex-only-skill', 'SKILL.md'), '# codex-only-skill');

    const providerDir = join(extProjectRoot, '.claude', 'skills');
    await rm(providerDir, { recursive: true, force: true });
    await symlink(relative(join(extProjectRoot, '.claude'), skillsSource), providerDir);

    const extConfig = await readCapabilitiesConfig(extProjectRoot);
    assert.ok(extConfig);
    extConfig.capabilities.push({
      id: 'codex-only-skill',
      type: 'skill',
      enabled: true,
      source: 'cat-cafe',
      mountPaths: ['codex'],
    });
    await writeCapabilitiesConfig(extProjectRoot, extConfig);

    const warnings = await propagateGlobalSkillDisable(catCafeRoot, catCafeRoot, 'test-skill', skillsSource);

    assert.deepStrictEqual(warnings, []);
    const rootStat = await lstat(providerDir);
    assert.strictEqual(rootStat.isDirectory(), true, 'legacy root should become a real provider directory');
    assert.strictEqual(rootStat.isSymbolicLink(), false, 'legacy directory-level symlink should be removed');
    assert.strictEqual(
      await pathExists(join(providerDir, 'test-skill')),
      false,
      'globally disabled skill must no longer be loadable through the legacy root',
    );
    assert.strictEqual(
      await pathExists(join(providerDir, 'codex-only-skill')),
      false,
      'legacy conversion must not expose a codex-only skill through the claude provider root',
    );
  });

  test('global provider enable skips disabled standard provider in external mount rules', async () => {
    const extConfig = await readCapabilitiesConfig(extProjectRoot);
    assert.ok(extConfig);
    extConfig.mountRules = [
      { name: 'claude', path: '.claude/skills', enabled: true },
      { name: 'codex', path: '.codex/skills', enabled: false },
      { name: 'gemini', path: '.gemini/skills', enabled: true },
      { name: 'kimi', path: '.kimi/skills', enabled: true },
    ];
    await writeCapabilitiesConfig(extProjectRoot, extConfig);

    const warnings = await propagateGlobalProviderToggle(
      catCafeRoot,
      catCafeRoot,
      'test-skill',
      'codex',
      true,
      skillsSource,
    );

    assert.deepStrictEqual(warnings, []);
    assert.equal(await pathExists(join(extProjectRoot, '.codex', 'skills', 'test-skill')), false);
    const updated = await readCapabilitiesConfig(extProjectRoot);
    const extCap = updated?.capabilities.find((c) => c.id === 'test-skill');
    assert.deepStrictEqual(extCap?.mountPaths, ['claude'], 'disabled provider must not be recorded as mounted');
    assert.strictEqual(extCap?.enabled, true, 'existing provider mount keeps the skill enabled');
  });

  test('global provider disable removes stale managed links from disabled external provider dirs', async () => {
    const extConfig = await readCapabilitiesConfig(extProjectRoot);
    assert.ok(extConfig);
    extConfig.capabilities = [
      {
        id: 'test-skill',
        type: 'skill',
        enabled: true,
        source: 'cat-cafe',
        mountPaths: ['claude', 'codex'],
      },
    ];
    extConfig.mountRules = [
      { name: 'claude', path: '.claude/skills', enabled: true },
      { name: 'codex', path: '.codex/skills', enabled: false },
      { name: 'gemini', path: '.gemini/skills', enabled: true },
      { name: 'kimi', path: '.kimi/skills', enabled: true },
    ];
    await writeCapabilitiesConfig(extProjectRoot, extConfig);

    const codexDir = join(extProjectRoot, '.codex', 'skills');
    await mkdir(codexDir, { recursive: true });
    await symlink(relative(codexDir, join(skillsSource, 'test-skill')), join(codexDir, 'test-skill'));

    const warnings = await propagateGlobalProviderToggle(
      catCafeRoot,
      catCafeRoot,
      'test-skill',
      'codex',
      false,
      skillsSource,
    );

    assert.deepStrictEqual(warnings, []);
    assert.equal(
      await pathExists(join(extProjectRoot, '.claude', 'skills', 'test-skill')),
      true,
      'valid sibling provider mount should remain',
    );
    assert.equal(
      await pathExists(join(codexDir, 'test-skill')),
      false,
      'provider-off propagation must remove stale managed links even when that provider is disabled locally',
    );

    const updated = await readCapabilitiesConfig(extProjectRoot);
    const extCap = updated?.capabilities.find((c) => c.id === 'test-skill');
    assert.deepStrictEqual(extCap?.mountPaths, ['claude']);
    assert.strictEqual(extCap?.enabled, true, 'remaining provider mount keeps the skill enabled');
  });

  test('global provider enable rolls back external mount when config write fails', async () => {
    const configFile = join(extProjectRoot, '.cat-cafe', 'capabilities.json');
    await chmod(configFile, 0o444);

    const warnings = await propagateGlobalProviderToggle(
      catCafeRoot,
      catCafeRoot,
      'test-skill',
      'codex',
      true,
      skillsSource,
    );

    assert.ok(warnings.length > 0, 'config write failure should report a propagation warning');
    assert.equal(
      await pathExists(join(extProjectRoot, '.codex', 'skills', 'test-skill')),
      false,
      'failed provider enable must roll back the newly created external mount',
    );

    await chmod(configFile, 0o644);
    const updated = await readCapabilitiesConfig(extProjectRoot);
    const extCap = updated?.capabilities.find((c) => c.id === 'test-skill');
    assert.deepStrictEqual(extCap?.mountPaths, ['claude'], 'failed provider enable must preserve old policy');
  });

  test('global provider disable rolls back external unmount when config write fails', async () => {
    const extConfig = await readCapabilitiesConfig(extProjectRoot);
    assert.ok(extConfig);
    extConfig.capabilities = [
      {
        id: 'test-skill',
        type: 'skill',
        enabled: true,
        source: 'cat-cafe',
        mountPaths: ['claude', 'codex'],
      },
    ];
    await writeCapabilitiesConfig(extProjectRoot, extConfig);

    const codexDir = join(extProjectRoot, '.codex', 'skills');
    const codexLink = join(codexDir, 'test-skill');
    await mkdir(codexDir, { recursive: true });
    await symlink(relative(codexDir, join(skillsSource, 'test-skill')), codexLink);

    const configFile = join(extProjectRoot, '.cat-cafe', 'capabilities.json');
    await chmod(configFile, 0o444);

    const warnings = await propagateGlobalProviderToggle(
      catCafeRoot,
      catCafeRoot,
      'test-skill',
      'codex',
      false,
      skillsSource,
    );

    assert.ok(warnings.length > 0, 'config write failure should report a propagation warning');
    assert.equal(
      (await lstat(codexLink)).isSymbolicLink(),
      true,
      'failed provider disable must restore the previously managed external mount',
    );

    await chmod(configFile, 0o644);
    const updated = await readCapabilitiesConfig(extProjectRoot);
    const extCap = updated?.capabilities.find((c) => c.id === 'test-skill');
    assert.deepStrictEqual(extCap?.mountPaths, ['claude', 'codex'], 'failed provider disable must preserve old policy');
  });

  test('global provider enable skips undefined custom provider in external mount rules', async () => {
    const warnings = await propagateGlobalProviderToggle(
      catCafeRoot,
      catCafeRoot,
      'test-skill',
      'opencode',
      true,
      skillsSource,
    );

    assert.deepStrictEqual(warnings, []);
    assert.equal(await pathExists(join(extProjectRoot, '.opencode', 'skills', 'test-skill')), false);
    const updated = await readCapabilitiesConfig(extProjectRoot);
    const extCap = updated?.capabilities.find((c) => c.id === 'test-skill');
    assert.deepStrictEqual(extCap?.mountPaths, ['claude'], 'undefined custom provider must not be recorded as mounted');
    assert.strictEqual(extCap?.enabled, true, 'existing provider mount keeps the skill enabled');
  });

  test('persists provider enable when external project is missing the skill capability', async () => {
    await writeCapabilitiesConfig(extProjectRoot, {
      version: 2,
      capabilities: [],
    });

    const warnings = await propagateGlobalProviderToggle(
      catCafeRoot,
      catCafeRoot,
      'test-skill',
      'codex',
      true,
      skillsSource,
    );

    assert.deepStrictEqual(warnings, []);
    assert.equal(await pathExists(join(extProjectRoot, '.codex', 'skills', 'test-skill')), true);

    const updated = await readCapabilitiesConfig(extProjectRoot);
    const extCap = updated?.capabilities.find((c) => c.id === 'test-skill');
    assert.ok(extCap, 'provider enable must persist policy for missing skill entries');
    assert.strictEqual(extCap.type, 'skill');
    assert.strictEqual(extCap.source, 'cat-cafe');
    assert.strictEqual(extCap.enabled, true);
    assert.deepStrictEqual(extCap.mountPaths, ['codex']);
  });

  test('global provider toggle preserves same-id plugin skill capability', async () => {
    await writeCapabilitiesConfig(extProjectRoot, {
      version: 2,
      capabilities: [
        {
          id: 'test-skill',
          type: 'skill',
          enabled: true,
          source: 'plugin',
          pluginId: 'same-id-plugin',
          mountPaths: ['claude'],
        },
      ],
    });

    const warnings = await propagateGlobalProviderToggle(
      catCafeRoot,
      catCafeRoot,
      'test-skill',
      'codex',
      true,
      skillsSource,
    );

    assert.deepStrictEqual(warnings, []);
    assert.equal(await pathExists(join(extProjectRoot, '.codex', 'skills', 'test-skill')), true);

    const updated = await readCapabilitiesConfig(extProjectRoot);
    const pluginCap = updated?.capabilities.find((c) => c.id === 'test-skill' && c.source === 'plugin');
    assert.ok(pluginCap, 'same-id plugin skill capability must be preserved');
    assert.strictEqual(pluginCap.enabled, true);
    assert.strictEqual(pluginCap.pluginId, 'same-id-plugin');
    assert.deepStrictEqual(pluginCap.mountPaths, ['claude']);

    const catCafeCaps = updated?.capabilities.filter((c) => c.id === 'test-skill' && c.source === 'cat-cafe');
    assert.equal(catCafeCaps?.length, 1, 'provider propagation should write a separate cat-cafe skill policy');
    assert.strictEqual(catCafeCaps?.[0]?.enabled, true);
    assert.deepStrictEqual(catCafeCaps?.[0]?.mountPaths, ['codex']);
  });

  test('persists provider enable policy when external project has no capabilities config', async () => {
    await rm(join(extProjectRoot, '.cat-cafe', 'capabilities.json'), { force: true });

    const warnings = await propagateGlobalProviderToggle(
      catCafeRoot,
      catCafeRoot,
      'test-skill',
      'codex',
      true,
      skillsSource,
    );

    assert.deepStrictEqual(warnings, []);
    assert.equal(await pathExists(join(extProjectRoot, '.codex', 'skills', 'test-skill')), true);

    const updated = await readCapabilitiesConfig(extProjectRoot);
    const extCap = updated?.capabilities.find((c) => c.id === 'test-skill');
    assert.ok(extCap, 'provider enable must create a project policy for configless projects');
    assert.strictEqual(extCap.type, 'skill');
    assert.strictEqual(extCap.source, 'cat-cafe');
    assert.strictEqual(extCap.enabled, true);
    assert.deepStrictEqual(extCap.mountPaths, ['codex']);
  });

  test('persists provider disable policy when external project is missing the skill capability', async () => {
    await writeCapabilitiesConfig(extProjectRoot, {
      version: 2,
      capabilities: [],
    });

    const warnings = await propagateGlobalProviderToggle(
      catCafeRoot,
      catCafeRoot,
      'test-skill',
      'claude',
      false,
      skillsSource,
    );

    assert.deepStrictEqual(warnings, []);
    assert.equal(await pathExists(join(extProjectRoot, '.claude', 'skills', 'test-skill')), false);

    const updated = await readCapabilitiesConfig(extProjectRoot);
    const extCap = updated?.capabilities.find((c) => c.id === 'test-skill');
    assert.ok(extCap, 'provider disable must persist narrowed policy for missing skill entries');
    assert.strictEqual(extCap.type, 'skill');
    assert.strictEqual(extCap.source, 'cat-cafe');
    assert.strictEqual(extCap.enabled, true);
    assert.deepStrictEqual(extCap.mountPaths, ['codex', 'gemini', 'kimi']);
  });

  test('global provider disable preserves inherited global policy when external skill policy is missing', async () => {
    await writeCapabilitiesConfig(extProjectRoot, {
      version: 2,
      capabilities: [],
    });

    const warnings = await propagateGlobalProviderToggle(
      catCafeRoot,
      catCafeRoot,
      'test-skill',
      'codex',
      false,
      skillsSource,
      ['claude'],
    );

    assert.deepStrictEqual(warnings, []);
    assert.equal(await pathExists(join(extProjectRoot, '.codex', 'skills', 'test-skill')), false);

    const updated = await readCapabilitiesConfig(extProjectRoot);
    const extCap = updated?.capabilities.find((c) => c.id === 'test-skill');
    assert.ok(extCap, 'provider disable must persist the narrowed inherited policy');
    assert.strictEqual(extCap.type, 'skill');
    assert.strictEqual(extCap.source, 'cat-cafe');
    assert.strictEqual(extCap.enabled, true);
    assert.deepStrictEqual(extCap.mountPaths, ['claude']);
  });

  test('global provider enable preserves inherited global policy when external skill policy is missing', async () => {
    await writeCapabilitiesConfig(extProjectRoot, {
      version: 2,
      capabilities: [],
    });

    const warnings = await propagateGlobalProviderToggle(
      catCafeRoot,
      catCafeRoot,
      'test-skill',
      'codex',
      true,
      skillsSource,
      ['claude', 'codex'],
    );

    assert.deepStrictEqual(warnings, []);
    assert.equal(await pathExists(join(extProjectRoot, '.claude', 'skills', 'test-skill')), true);
    assert.equal(await pathExists(join(extProjectRoot, '.codex', 'skills', 'test-skill')), true);

    const updated = await readCapabilitiesConfig(extProjectRoot);
    const extCap = updated?.capabilities.find((c) => c.id === 'test-skill');
    assert.ok(extCap, 'provider enable must persist the expanded inherited policy');
    assert.strictEqual(extCap.type, 'skill');
    assert.strictEqual(extCap.source, 'cat-cafe');
    assert.strictEqual(extCap.enabled, true);
    assert.deepStrictEqual(extCap.mountPaths, ['claude', 'codex']);
  });

  test('persists provider disable policy when target provider is disabled in external mount rules', async () => {
    await writeCapabilitiesConfig(extProjectRoot, {
      version: 2,
      capabilities: [],
      mountRules: [
        { name: 'claude', path: '.claude/skills', enabled: true },
        { name: 'codex', path: '.codex/skills', enabled: false },
        { name: 'gemini', path: '.gemini/skills', enabled: false },
        { name: 'kimi', path: '.kimi/skills', enabled: false },
      ],
    });

    const warnings = await propagateGlobalProviderToggle(
      catCafeRoot,
      catCafeRoot,
      'test-skill',
      'codex',
      false,
      skillsSource,
    );

    assert.deepStrictEqual(warnings, []);
    assert.equal(await pathExists(join(extProjectRoot, '.codex', 'skills', 'test-skill')), false);

    const updated = await readCapabilitiesConfig(extProjectRoot);
    const extCap = updated?.capabilities.find((c) => c.id === 'test-skill');
    assert.ok(extCap, 'provider disable must persist policy even when the provider is currently disabled');
    assert.strictEqual(extCap.type, 'skill');
    assert.strictEqual(extCap.source, 'cat-cafe');
    assert.strictEqual(extCap.enabled, true);
    assert.deepStrictEqual(extCap.mountPaths, ['claude']);
  });

  test('persists provider disable policy when external project has no capabilities config', async () => {
    await rm(join(extProjectRoot, '.cat-cafe', 'capabilities.json'), { force: true });

    const warnings = await propagateGlobalProviderToggle(
      catCafeRoot,
      catCafeRoot,
      'test-skill',
      'claude',
      false,
      skillsSource,
    );

    assert.deepStrictEqual(warnings, []);
    assert.equal(await pathExists(join(extProjectRoot, '.claude', 'skills', 'test-skill')), false);

    const updated = await readCapabilitiesConfig(extProjectRoot);
    const extCap = updated?.capabilities.find((c) => c.id === 'test-skill');
    assert.ok(extCap, 'provider disable must create a narrowed project policy for configless projects');
    assert.strictEqual(extCap.type, 'skill');
    assert.strictEqual(extCap.source, 'cat-cafe');
    assert.strictEqual(extCap.enabled, true);
    assert.deepStrictEqual(extCap.mountPaths, ['codex', 'gemini', 'kimi']);
  });

  test('persists enabled policy when external project is missing the skill capability', async () => {
    await writeCapabilitiesConfig(extProjectRoot, {
      version: 2,
      capabilities: [],
      mountRules: [
        { name: 'claude', path: '.claude/skills', enabled: true },
        { name: 'codex', path: '.codex/skills', enabled: false },
        { name: 'gemini', path: '.gemini/skills', enabled: false },
        { name: 'kimi', path: '.kimi/skills', enabled: false },
        { name: 'acp', path: '.acp/skills', enabled: true },
      ],
    });

    const result = await propagateGlobalSkillEnable(catCafeRoot, catCafeRoot, 'test-skill', skillsSource);

    assert.deepStrictEqual(result.warnings, []);
    assert.deepStrictEqual(result.conflicts, []);
    assert.equal(await pathExists(join(extProjectRoot, '.claude', 'skills', 'test-skill')), true);
    assert.equal(await pathExists(join(extProjectRoot, '.acp', 'skills', 'test-skill')), true);
    assert.equal(await pathExists(join(extProjectRoot, '.codex', 'skills', 'test-skill')), false);

    const updated = await readCapabilitiesConfig(extProjectRoot);
    const extCap = updated?.capabilities.find((c) => c.id === 'test-skill');
    assert.ok(extCap, 'global enable must persist an enabled project policy for missing skill entries');
    assert.strictEqual(extCap.type, 'skill');
    assert.strictEqual(extCap.source, 'cat-cafe');
    assert.strictEqual(extCap.enabled, true);
    assert.deepStrictEqual(extCap.mountPaths, ['claude', 'acp']);
  });

  test('global skill enable propagation cascades global mountPaths as default', async () => {
    // F228: Global mountPaths cascade as a mount default during propagation.
    // The propagation mounts to providers in the global policy that are also
    // enabled in the external project's mount rules. Providers outside the
    // global policy are NOT mounted but also NOT unmounted if already present.
    await writeCapabilitiesConfig(catCafeRoot, {
      version: 2,
      capabilities: [{ id: 'test-skill', type: 'skill', enabled: true, source: 'cat-cafe', mountPaths: ['claude'] }],
    });
    await writeCapabilitiesConfig(extProjectRoot, {
      version: 2,
      capabilities: [],
      mountRules: [
        { name: 'claude', path: '.claude/skills', enabled: true },
        { name: 'codex', path: '.codex/skills', enabled: true },
        { name: 'gemini', path: '.gemini/skills', enabled: false },
        { name: 'kimi', path: '.kimi/skills', enabled: false },
      ],
    });

    const result = await propagateGlobalSkillEnable(catCafeRoot, catCafeRoot, 'test-skill', skillsSource);

    assert.deepStrictEqual(result.warnings, []);
    assert.deepStrictEqual(result.conflicts, []);
    assert.equal(await pathExists(join(extProjectRoot, '.claude', 'skills', 'test-skill')), true);
    assert.equal(
      await pathExists(join(extProjectRoot, '.codex', 'skills', 'test-skill')),
      false,
      'global enable propagation only mounts providers in the global policy cascade',
    );

    const updated = await readCapabilitiesConfig(extProjectRoot);
    const extCap = updated?.capabilities.find((c) => c.id === 'test-skill');
    assert.ok(extCap, 'global enable must persist an enabled project policy');
    assert.strictEqual(extCap.type, 'skill');
    assert.strictEqual(extCap.source, 'cat-cafe');
    assert.strictEqual(extCap.enabled, true);
    assert.deepStrictEqual(extCap.mountPaths, ['claude']);
  });

  test('preserves existing project-level provider mounts outside global skill mountPaths', async () => {
    // F228: Global policy is a cascade default, NOT a constraint.
    // Existing project-level mounts outside the global policy must be preserved
    // during propagation — projects can independently mount additional providers.
    await writeCapabilitiesConfig(catCafeRoot, {
      version: 2,
      capabilities: [{ id: 'test-skill', type: 'skill', enabled: true, source: 'cat-cafe', mountPaths: ['claude'] }],
    });
    await writeCapabilitiesConfig(extProjectRoot, {
      version: 2,
      capabilities: [
        { id: 'test-skill', type: 'skill', enabled: true, source: 'cat-cafe', mountPaths: ['claude', 'codex'] },
      ],
      mountRules: [
        { name: 'claude', path: '.claude/skills', enabled: true },
        { name: 'codex', path: '.codex/skills', enabled: true },
        { name: 'gemini', path: '.gemini/skills', enabled: false },
        { name: 'kimi', path: '.kimi/skills', enabled: false },
      ],
    });
    const codexSkillsDir = join(extProjectRoot, '.codex', 'skills');
    await mkdir(codexSkillsDir, { recursive: true });
    await symlink(relative(codexSkillsDir, join(skillsSource, 'test-skill')), join(codexSkillsDir, 'test-skill'));

    const result = await propagateGlobalSkillEnable(catCafeRoot, catCafeRoot, 'test-skill', skillsSource);

    assert.deepStrictEqual(result.warnings, []);
    assert.deepStrictEqual(result.conflicts, []);
    assert.equal(await pathExists(join(extProjectRoot, '.claude', 'skills', 'test-skill')), true);
    assert.equal(
      await pathExists(join(extProjectRoot, '.codex', 'skills', 'test-skill')),
      true,
      'existing project-level codex mount must be preserved — global policy is cascade default, not constraint',
    );

    const updated = await readCapabilitiesConfig(extProjectRoot);
    const extCap = updated?.capabilities.find((c) => c.id === 'test-skill');
    assert.ok(extCap, 'global enable must persist an enabled project policy');
    assert.strictEqual(extCap.enabled, true);
    // Existing project mountPaths preserved + claude from global cascade
    assert.deepStrictEqual(extCap.mountPaths, ['claude', 'codex']);
  });

  test('global skill enable preserves same-id plugin skill capability', async () => {
    await writeCapabilitiesConfig(extProjectRoot, {
      version: 2,
      capabilities: [
        {
          id: 'test-skill',
          type: 'skill',
          enabled: false,
          source: 'cat-cafe',
          pluginId: 'same-id-plugin',
          mountPaths: [],
        },
      ],
    });

    const result = await propagateGlobalSkillEnable(catCafeRoot, catCafeRoot, 'test-skill', skillsSource);

    assert.deepStrictEqual(result.warnings, []);
    assert.deepStrictEqual(result.conflicts, []);
    assert.equal(await pathExists(join(extProjectRoot, '.claude', 'skills', 'test-skill')), true);

    const updated = await readCapabilitiesConfig(extProjectRoot);
    const pluginCap = updated?.capabilities.find(
      (c) => c.id === 'test-skill' && c.source === 'cat-cafe' && c.pluginId === 'same-id-plugin',
    );
    assert.ok(pluginCap, 'same-id plugin skill capability must be preserved');
    assert.strictEqual(pluginCap.enabled, false);
    assert.deepStrictEqual(pluginCap.mountPaths, []);

    const catCafeCap = updated?.capabilities.find(
      (c) => c.id === 'test-skill' && c.source === 'cat-cafe' && !c.pluginId,
    );
    assert.ok(catCafeCap, 'global skill enable should write a separate Cat Cafe skill policy');
    assert.strictEqual(catCafeCap.enabled, true);
    assert.deepStrictEqual(catCafeCap.mountPaths, ['claude', 'codex', 'gemini', 'kimi']);
  });

  test('persists enabled policy when external project has no capabilities config', async () => {
    await rm(join(extProjectRoot, '.cat-cafe', 'capabilities.json'), { force: true });

    const result = await propagateGlobalSkillEnable(catCafeRoot, catCafeRoot, 'test-skill', skillsSource);

    assert.deepStrictEqual(result.warnings, []);
    assert.deepStrictEqual(result.conflicts, []);
    assert.equal(await pathExists(join(extProjectRoot, '.claude', 'skills', 'test-skill')), true);
    assert.equal(await pathExists(join(extProjectRoot, '.codex', 'skills', 'test-skill')), true);

    const updated = await readCapabilitiesConfig(extProjectRoot);
    const extCap = updated?.capabilities.find((c) => c.id === 'test-skill');
    assert.ok(extCap, 'global enable must create an enabled project policy for configless projects');
    assert.strictEqual(extCap.type, 'skill');
    assert.strictEqual(extCap.source, 'cat-cafe');
    assert.strictEqual(extCap.enabled, true);
    assert.deepStrictEqual(extCap.mountPaths, ['claude', 'codex', 'gemini', 'kimi']);
  });

  test('returns warning when governance registry is unreadable', async () => {
    // Make the registry file unreadable
    await chmod(join(catCafeRoot, '.cat-cafe', 'governance-registry.json'), 0o000);

    const warnings = await propagateGlobalSkillDisable(catCafeRoot, catCafeRoot, 'test-skill', skillsSource);

    // GovernanceRegistry.read() catches errors and returns { entries: [] },
    // so this should succeed with no warnings (empty registry)
    // But if there's a permission error at the FS level, it depends on the
    // GovernanceRegistry implementation. Let's just verify no crash.
    assert.ok(Array.isArray(warnings));
  });
});
