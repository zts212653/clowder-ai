import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';
import { readPluginConfig, writePluginConfig } from '../dist/domains/plugin/plugin-config-store.js';

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

  it('writePluginConfig persists JSON without mutating process.env', () => {
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

  it('writePluginConfig persists a null tombstone while reads omit cleared values', () => {
    writePluginConfig(tmpDir, 'test-plugin', [{ name: 'TEST_PLUGIN_REMOVE', value: 'exists' }]);
    assert.equal(readPluginConfig(tmpDir, 'test-plugin').TEST_PLUGIN_REMOVE, 'exists');
    writePluginConfig(tmpDir, 'test-plugin', [{ name: 'TEST_PLUGIN_REMOVE', value: null }]);
    assert.equal(readPluginConfig(tmpDir, 'test-plugin').TEST_PLUGIN_REMOVE, undefined);
    const stored = JSON.parse(readFileSync(join(tmpDir, '.cat-cafe/plugin-config/test-plugin.json'), 'utf8'));
    assert.equal(stored.TEST_PLUGIN_REMOVE, null);
  });

  it('writePluginConfig reports no changes when values are identical', () => {
    trackEnv('TEST_PLUGIN_SAME');

    writePluginConfig(tmpDir, 'test-plugin', [{ name: 'TEST_PLUGIN_SAME', value: 'unchanged' }]);
    const { changedKeys } = writePluginConfig(tmpDir, 'test-plugin', [
      { name: 'TEST_PLUGIN_SAME', value: 'unchanged' },
    ]);

    assert.deepEqual(changedKeys, []);
  });

  it('persisted tombstones do not fall back to process environment values', () => {
    trackEnv('TOMBSTONE_KEY');
    process.env.TOMBSTONE_KEY = 'from-dotenv';
    writePluginConfig(tmpDir, 'tomb-test', [{ name: 'TOMBSTONE_KEY', value: null }]);
    assert.equal(readPluginConfig(tmpDir, 'tomb-test').TOMBSTONE_KEY, undefined);
    assert.equal(process.env.TOMBSTONE_KEY, 'from-dotenv');
  });

  it('reads fresh persisted values without a process-local configuration cache', () => {
    writePluginConfig(tmpDir, 'snapshot-test', [{ name: 'SNAPSHOT_TEST_KEY', value: 'previous-value' }]);
    const configPath = join(tmpDir, '.cat-cafe/plugin-config/snapshot-test.json');
    writeFileSync(configPath, `${JSON.stringify({ SNAPSHOT_TEST_KEY: null })}\n`, 'utf8');
    assert.equal(readPluginConfig(tmpDir, 'snapshot-test').SNAPSHOT_TEST_KEY, undefined);
  });

  it('JSON file has restricted permissions (0o600)', () => {
    trackEnv('TEST_PLUGIN_PERMS');

    writePluginConfig(tmpDir, 'perm-test', [{ name: 'TEST_PLUGIN_PERMS', value: 'secret' }]);

    const configPath = join(tmpDir, '.cat-cafe', 'plugin-config', 'perm-test.json');
    assert.ok(existsSync(configPath));
    assert.equal(statSync(configPath).mode & 0o777, 0o600);

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
