import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';

import { resolveNpmInvocation } from '../dist/domains/plugin/manager/local-directory-distribution.js';

const bundledNpmCli = resolve(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

test('explicit npm JS entrypoint always runs through the current Node binary', () => {
  const npmCli = '/opt/tools/npm/bin/npm-cli.js';
  assert.deepEqual(resolveNpmInvocation(npmCli), {
    command: process.execPath,
    prefixArgs: [npmCli],
  });
});

test('non-Windows spawns the npm launcher directly', { skip: process.platform === 'win32' }, () => {
  assert.deepEqual(resolveNpmInvocation('npm'), { command: 'npm', prefixArgs: [] });
});

// Regression: execFile cannot start npm.cmd on Windows, so a bare `npm` must run
// npm's JS entrypoint with the same Node binary (builtin package materializer
// dependency installs go through this).
test('Windows rewrites bare npm to the bundled npm-cli.js entrypoint', { skip: process.platform !== 'win32' }, () => {
  const invocation = resolveNpmInvocation('npm');
  if (existsSync(bundledNpmCli)) {
    assert.deepEqual(invocation, { command: process.execPath, prefixArgs: [bundledNpmCli] });
  } else {
    // Node installations without a bundled npm keep the historical passthrough.
    assert.deepEqual(invocation, { command: 'npm', prefixArgs: [] });
  }
});

test('Windows treats npm.cmd like bare npm', { skip: process.platform !== 'win32' }, () => {
  const invocation = resolveNpmInvocation('npm.cmd');
  if (existsSync(bundledNpmCli)) {
    assert.deepEqual(invocation, { command: process.execPath, prefixArgs: [bundledNpmCli] });
  } else {
    assert.deepEqual(invocation, { command: 'npm.cmd', prefixArgs: [] });
  }
});

test('Windows leaves non-cmd absolute launchers untouched', { skip: process.platform !== 'win32' }, () => {
  const npmExe = 'C:\\tools\\npm.exe';
  assert.deepEqual(resolveNpmInvocation(npmExe), { command: npmExe, prefixArgs: [] });
});
