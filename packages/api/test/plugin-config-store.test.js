import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import {
  loadAllPluginConfigs,
  readPluginConfig,
  resolvePluginEnv,
  writePluginConfig,
} from '../dist/domains/plugin/plugin-config-store.js';

describe('plugin-config-store', () => {
  let tmpDir;
  const savedEnv = {};

  beforeEach(() => {
    tmpDir = mkdtempSync(join(os.tmpdir(), 'plugin-cfg-'));
    mkdirSync(join(tmpDir, '.cat-cafe'), { recursive: true });
  });

  after(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function trackEnv(name) {
    if (!(name in savedEnv)) savedEnv[name] = process.env[name];
  }

  it('readPluginConfig returns empty object for missing file', () => {
    const result = readPluginConfig(tmpDir, 'nonexistent');
    assert.deepEqual(result, {});
  });

  it('writePluginConfig creates JSON file and populates configCache (not process.env)', () => {
    trackEnv('TEST_PLUGIN_KEY');
    trackEnv('TEST_PLUGIN_SECRET');
    delete process.env.TEST_PLUGIN_KEY;
    delete process.env.TEST_PLUGIN_SECRET;

    const { changedKeys } = writePluginConfig(tmpDir, 'test-plugin', [
      { name: 'TEST_PLUGIN_KEY', value: 'abc123' },
      { name: 'TEST_PLUGIN_SECRET', value: 'secret456' },
    ]);

    assert.deepEqual(changedKeys, ['TEST_PLUGIN_KEY', 'TEST_PLUGIN_SECRET']);
    assert.equal(process.env.TEST_PLUGIN_KEY, undefined, 'must not write process.env');
    assert.equal(process.env.TEST_PLUGIN_SECRET, undefined, 'must not write process.env');

    const stored = readPluginConfig(tmpDir, 'test-plugin');
    assert.equal(stored.TEST_PLUGIN_KEY, 'abc123');
    assert.equal(stored.TEST_PLUGIN_SECRET, 'secret456');

    const manifest = {
      id: 'test-plugin',
      name: 'Test',
      version: '1.0.0',
      builtin: false,
      config: [
        { envName: 'TEST_PLUGIN_KEY', label: 'Key', sensitive: false, required: true },
        { envName: 'TEST_PLUGIN_SECRET', label: 'Secret', sensitive: true, required: true },
      ],
      resources: [],
    };
    const env = resolvePluginEnv([manifest]);
    assert.equal(env.TEST_PLUGIN_KEY, 'abc123');
    assert.equal(env.TEST_PLUGIN_SECRET, 'secret456');
  });

  it('writePluginConfig merges with existing config', () => {
    trackEnv('TEST_PLUGIN_A');
    trackEnv('TEST_PLUGIN_B');

    writePluginConfig(tmpDir, 'test-plugin', [{ name: 'TEST_PLUGIN_A', value: 'first' }]);
    writePluginConfig(tmpDir, 'test-plugin', [{ name: 'TEST_PLUGIN_B', value: 'second' }]);

    const stored = readPluginConfig(tmpDir, 'test-plugin');
    assert.equal(stored.TEST_PLUGIN_A, 'first');
    assert.equal(stored.TEST_PLUGIN_B, 'second');
  });

  it('writePluginConfig tombstones key when value is null', () => {
    trackEnv('TEST_PLUGIN_REMOVE');

    const manifest = {
      id: 'test-plugin',
      name: 'Test',
      version: '1.0.0',
      builtin: false,
      config: [{ envName: 'TEST_PLUGIN_REMOVE', label: 'Remove', sensitive: false, required: false }],
      resources: [],
    };

    writePluginConfig(tmpDir, 'test-plugin', [{ name: 'TEST_PLUGIN_REMOVE', value: 'exists' }]);
    let env = resolvePluginEnv([manifest]);
    assert.equal(env.TEST_PLUGIN_REMOVE, 'exists');

    writePluginConfig(tmpDir, 'test-plugin', [{ name: 'TEST_PLUGIN_REMOVE', value: null }]);
    env = resolvePluginEnv([manifest]);
    assert.equal(env.TEST_PLUGIN_REMOVE, undefined, 'null tombstone hides value');

    const stored = readPluginConfig(tmpDir, 'test-plugin');
    assert.equal(stored.TEST_PLUGIN_REMOVE, undefined);
  });

  it('writePluginConfig reports no changes when values are identical', () => {
    trackEnv('TEST_PLUGIN_SAME');

    writePluginConfig(tmpDir, 'test-plugin', [{ name: 'TEST_PLUGIN_SAME', value: 'unchanged' }]);
    const { changedKeys } = writePluginConfig(tmpDir, 'test-plugin', [
      { name: 'TEST_PLUGIN_SAME', value: 'unchanged' },
    ]);

    assert.deepEqual(changedKeys, []);
  });

  it('loadAllPluginConfigs populates configCache for manifest-declared keys only', () => {
    trackEnv('LOAD_TEST_KEY');
    trackEnv('LOAD_TEST_ROGUE');

    writePluginConfig(tmpDir, 'load-test', [
      { name: 'LOAD_TEST_KEY', value: 'loaded' },
      { name: 'LOAD_TEST_ROGUE', value: 'injected' },
    ]);
    delete process.env.LOAD_TEST_KEY;
    delete process.env.LOAD_TEST_ROGUE;

    const manifest = {
      id: 'load-test',
      name: 'Load Test',
      version: '1.0.0',
      builtin: false,
      config: [{ envName: 'LOAD_TEST_KEY', label: 'Key', sensitive: false, required: true }],
      resources: [],
    };
    const count = loadAllPluginConfigs(tmpDir, [manifest]);
    assert.equal(count, 1);
    assert.equal(process.env.LOAD_TEST_KEY, undefined, 'must not write process.env');

    const env = resolvePluginEnv([manifest]);
    assert.equal(env.LOAD_TEST_KEY, 'loaded');
    assert.equal(env.LOAD_TEST_ROGUE, undefined, 'undeclared key must not be resolved');
  });

  it('resolvePluginEnv null tombstone overrides dotenv residue', () => {
    trackEnv('TOMBSTONE_KEY');

    process.env.TOMBSTONE_KEY = 'from-dotenv';
    writePluginConfig(tmpDir, 'tomb-test', [{ name: 'TOMBSTONE_KEY', value: null }]);

    const manifest = {
      id: 'tomb-test',
      name: 'Tomb Test',
      version: '1.0.0',
      builtin: false,
      config: [{ envName: 'TOMBSTONE_KEY', label: 'Key', sensitive: false, required: true }],
      resources: [],
    };
    loadAllPluginConfigs(tmpDir, [manifest]);
    const env = resolvePluginEnv([manifest]);
    assert.equal(env.TOMBSTONE_KEY, undefined, 'null tombstone must suppress env fallback');
    assert.equal(process.env.TOMBSTONE_KEY, 'from-dotenv', 'process.env must not be mutated');
  });

  it('JSON file has restricted permissions (0o600)', () => {
    trackEnv('TEST_PLUGIN_PERMS');

    writePluginConfig(tmpDir, 'perm-test', [{ name: 'TEST_PLUGIN_PERMS', value: 'secret' }]);

    const configPath = join(tmpDir, '.cat-cafe', 'plugin-config', 'perm-test.json');
    assert.ok(existsSync(configPath));

    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    assert.equal(parsed.TEST_PLUGIN_PERMS, 'secret');
  });

  it('each plugin gets its own config file', () => {
    trackEnv('PLUGIN_A_KEY');
    trackEnv('PLUGIN_B_KEY');

    writePluginConfig(tmpDir, 'plugin-a', [{ name: 'PLUGIN_A_KEY', value: 'a' }]);
    writePluginConfig(tmpDir, 'plugin-b', [{ name: 'PLUGIN_B_KEY', value: 'b' }]);

    const a = readPluginConfig(tmpDir, 'plugin-a');
    const b = readPluginConfig(tmpDir, 'plugin-b');
    assert.equal(a.PLUGIN_A_KEY, 'a');
    assert.equal(a.PLUGIN_B_KEY, undefined);
    assert.equal(b.PLUGIN_B_KEY, 'b');
    assert.equal(b.PLUGIN_A_KEY, undefined);
  });
});
