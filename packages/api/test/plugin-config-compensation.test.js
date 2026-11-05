import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  readPluginConfigText,
  restorePluginConfigText,
  writePluginConfig,
} from '../dist/domains/plugin/plugin-config-store.js';

test('compensation restores exact old text and refuses to overwrite an intervening edit', () => {
  const root = mkdtempSync(join(tmpdir(), 'config-compensation-'));
  const path = join(root, '.cat-cafe/plugin-config/test.plugin.json');
  writePluginConfig(root, 'test.plugin', [{ name: 'setting', value: 'old' }]);
  const previous = `${readPluginConfigText(root, 'test.plugin')}\n`;
  writeFileSync(path, previous);
  writePluginConfig(root, 'test.plugin', [{ name: 'setting', value: 'new' }]);
  const written = readPluginConfigText(root, 'test.plugin');
  restorePluginConfigText(root, 'test.plugin', written, previous);
  assert.equal(readPluginConfigText(root, 'test.plugin'), previous);
  writeFileSync(path, 'external edit');
  assert.throws(() => restorePluginConfigText(root, 'test.plugin', written, previous), /changed/);
  assert.equal(readFileSync(path, 'utf8'), 'external edit');
});

test('compensating a first file preserves the failed payload instead of deleting it', () => {
  const root = mkdtempSync(join(tmpdir(), 'config-compensation-new-'));
  writePluginConfig(root, 'test.plugin', [{ name: 'setting', value: 'new' }]);
  const written = readPluginConfigText(root, 'test.plugin');
  restorePluginConfigText(root, 'test.plugin', written, undefined);
  assert.equal(readPluginConfigText(root, 'test.plugin'), undefined);
  const directory = join(root, '.cat-cafe/plugin-config');
  const retained = readdirSync(directory).filter((name) => name.includes('.retained-failed-'));
  assert.equal(retained.length, 1);
  assert.equal(readFileSync(join(directory, retained[0]), 'utf8'), written);
});
