import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveNpmInvocation } from '../dist/domains/plugin/manager/npm-invocation.js';

async function root(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cat-cafe-npm invocation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function cli(directory) {
  const file = join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await mkdir(join(directory, 'node_modules', 'npm', 'bin'), { recursive: true });
  await writeFile(file, '// fixture; command selection must not execute this file\n');
  return file;
}

test('Windows default npm runs the bundled CLI with the same Node binary, including paths with spaces', async (t) => {
  const directory = await root(t);
  const entry = await cli(directory);
  const execPath = join(directory, 'node.exe');
  for (const command of ['npm', 'npm.cmd']) {
    assert.deepEqual(resolveNpmInvocation(command, { platform: 'win32', execPath }), {
      command: execPath,
      prefixArgs: [entry],
    });
  }
});

test('an absolute Windows npm.cmd keeps its adjacent CLI when the Node directory has no npm', async (t) => {
  const directory = await root(t);
  const selected = join(directory, 'selected npm');
  const entry = await cli(selected);
  const execPath = join(directory, 'node', 'node.exe');
  assert.deepEqual(resolveNpmInvocation(join(selected, 'npm.cmd'), { platform: 'win32', execPath }), {
    command: execPath,
    prefixArgs: [entry],
  });
});

test('explicit JS entrypoints remain separate argv and never become shell command text', () => {
  for (const platform of ['win32', 'darwin', 'linux']) {
    const execPath = '/node with spaces/node';
    const entry = '/npm cli/quoted & literal/npm-cli.cjs';
    assert.deepEqual(resolveNpmInvocation(entry, { platform, execPath }), {
      command: execPath,
      prefixArgs: [entry],
    });
  }
});

test('ordinary POSIX and explicit executable callers retain their command contract', () => {
  assert.deepEqual(resolveNpmInvocation('npm', { platform: 'linux', execPath: '/node' }), {
    command: 'npm',
    prefixArgs: [],
  });
  assert.deepEqual(resolveNpmInvocation('selected-npm.exe', { platform: 'win32', execPath: '/node' }), {
    command: 'selected-npm.exe',
    prefixArgs: [],
  });
});
