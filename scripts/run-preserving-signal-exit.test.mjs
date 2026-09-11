/**
 * Regression tests for scripts/run-preserving-signal-exit.mjs.
 *
 * The wrapper exists so the Web build can report the same exit code a signal
 * would have produced. It spawned the target command without a shell, which
 * works on POSIX but not on Windows: tools pnpm puts in node_modules/.bin are
 * `.cmd` shims, and Windows cannot execute those without cmd.exe. The result was
 *
 *   packages/web build$ node ../../scripts/run-preserving-signal-exit.mjs next build
 *   packages/web build: Error: spawn next ENOENT
 *
 * which made `pnpm run build` fail on Windows and therefore made the Windows
 * installer impossible to build at all.
 *
 * The tests use a command that only exists as a `.cmd` shim, so they fail on
 * Windows exactly the way `next build` did.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const IS_WINDOWS = os.platform() === 'win32';
const WRAPPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'run-preserving-signal-exit.mjs');

let stubDir;

before(() => {
  stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-signal-exit-'));
  if (IS_WINDOWS) {
    fs.writeFileSync(path.join(stubDir, 'stub-tool.cmd'), '@echo off\r\necho STUB-TOOL-RAN\r\nexit /b %1\r\n', 'utf8');
  } else {
    const stub = path.join(stubDir, 'stub-tool');
    // Written without shell parameter expansion so linters do not read it as a
    // template placeholder.
    fs.writeFileSync(stub, '#!/bin/sh\necho STUB-TOOL-RAN\nif [ -z "$1" ]; then exit 0; fi\nexit "$1"\n', 'utf8');
    fs.chmodSync(stub, 0o755);
  }
});

after(() => {
  if (stubDir) fs.rmSync(stubDir, { recursive: true, force: true });
});

function runWrapper(args, env = {}) {
  try {
    const stdout = execFileSync(process.execPath, [WRAPPER, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`,
        ...env,
      },
    });
    return { code: 0, stdout };
  } catch (error) {
    return {
      code: typeof error?.status === 'number' ? error.status : 1,
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? ''),
    };
  }
}

describe('run-preserving-signal-exit: running a PATH command', () => {
  it('runs a command that only exists as a shim on PATH', () => {
    const result = runWrapper(['stub-tool', '0']);

    assert.match(
      result.stdout,
      /STUB-TOOL-RAN/,
      `the wrapper must be able to launch a node_modules/.bin shim (${IS_WINDOWS ? '.cmd on Windows' : 'script on POSIX'})`,
    );
    assert.equal(result.code, 0);
  });

  it('propagates the child exit code', () => {
    const result = runWrapper(['stub-tool', '7']);

    assert.equal(result.code, 7, 'the wrapper must preserve the child exit code');
  });

  it('reports a missing command instead of a raw crash', () => {
    const result = runWrapper(['definitely-not-a-real-command-xyz']);

    assert.notEqual(result.code, 0);
  });
});
