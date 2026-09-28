import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDirectExecution } from '../src/utils/is-direct-execution.ts';

const root = mkdtempSync(join(tmpdir(), 'clowder-mcp-entry 测试-'));
const actual = join(root, 'actual');
const alias = join(root, 'workspace');
mkdirSync(actual);
symlinkSync(actual, alias, process.platform === 'win32' ? 'junction' : 'dir');
after(() => {
  // Remove the directory alias itself before removing its isolated fixture root.
  if (process.platform === 'win32') rmdirSync(alias);
  else rmSync(alias);
  rmSync(root, { recursive: true, force: true });
});
const helper = new URL('../src/utils/is-direct-execution.ts', import.meta.url).href;
const entry = join(actual, 'entry.mjs');
writeFileSync(
  entry,
  `import {isDirectExecution} from ${JSON.stringify(helper)}; console.log(isDirectExecution(import.meta.url) ? 'MAIN' : 'IMPORTED');`,
);
writeFileSync(join(actual, 'importer.mjs'), "import './entry.mjs';");

for (const [label, script, expected] of [
  ['physical entry', entry, 'MAIN'],
  ['junction or symlink entry', join(alias, 'entry.mjs'), 'MAIN'],
  ['ordinary module import', join(actual, 'importer.mjs'), 'IMPORTED'],
]) {
  test(label, () => {
    const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  });
}

test('missing, invalid and unrelated entry paths cannot execute an imported server', () => {
  assert.equal(isDirectExecution(pathToFileURL(entry).href, ''), false);
  assert.equal(isDirectExecution(pathToFileURL(entry).href, join(root, 'missing.mjs')), false);
  assert.equal(isDirectExecution(pathToFileURL(entry).href, join(actual, 'importer.mjs')), false);
});

test('Windows path casing aliases have the same file identity', { skip: process.platform !== 'win32' }, () => {
  assert.equal(isDirectExecution(pathToFileURL(entry).href, entry.toUpperCase()), true);
});

test('every MCP entrypoint uses the shared execution guard', () => {
  for (const name of [
    'collab',
    'memory',
    'signals',
    'limb',
    'audio',
    'finance',
    'index',
    'protocol-server',
    'remote-spike',
  ]) {
    const source = readFileSync(fileURLToPath(new URL(`../src/${name}.ts`, import.meta.url)), 'utf8');
    assert.match(source, /isDirectExecution\(import\.meta\.url\)/, name);
    assert.doesNotMatch(
      source,
      /resolve\(fileURLToPath\(import\.meta\.url\)\) === resolve\(process\.argv\[1\]\)/,
      name,
    );
  }
});
