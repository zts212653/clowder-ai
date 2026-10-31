import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const { ManagedRunner } = await import('../dist/infrastructure/managed-runner.js');

test('readonly mode never falls back to a writable ordinary command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f306-readonly-managed-'));
  const sentinel = join(root, 'sentinel');
  writeFileSync(sentinel, 'BEFORE');
  try {
    const runner = new ManagedRunner();
    const result = await runner.launch(`printf AFTER > '${sentinel}'`, {
      cwd: root,
      executionPolicy: 'read_only',
      timeoutMs: 2000,
    });
    assert.notEqual(result.exitCode, 0);
    assert.equal(readFileSync(sentinel, 'utf8'), 'BEFORE');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unknown managed execution policy fails before any command executes', async () => {
  const runner = new ManagedRunner();
  await assert.rejects(runner.launch('printf UNEXPECTED', { executionPolicy: 'externalSandbox' }), /execution_policy/);
  assert.throws(
    () => new ManagedRunner().start('printf UNEXPECTED', { executionPolicy: 'externalSandbox' }),
    /execution_policy/,
  );
});

test('ordinary commands retain writable worktree behavior', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f306-ordinary-managed-'));
  const path = join(root, 'owned-output');
  try {
    const runner = new ManagedRunner();
    const result = await runner.launch(`printf ordinary > '${path}'`, { cwd: root, timeoutMs: 2000 });
    assert.equal(result.exitCode, 0);
    assert.equal(readFileSync(path, 'utf8'), 'ordinary');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unavailable native capability rejects admission and never executes an ordinary fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f306-unavailable-native-'));
  const prior = process.env.CODEX_BIN;
  const sentinel = join(root, 'sentinel');
  writeFileSync(sentinel, 'BEFORE');
  process.env.CODEX_BIN = 'caller-relative-executable';
  try {
    const runner = new ManagedRunner();
    const started = runner.start(`printf CHANGED > '${sentinel}'`, {
      cwd: root,
      executionPolicy: 'read_only',
      timeoutMs: 2000,
    });
    const admission = await started.admission;
    assert.equal(admission.spawned, false);
    assert.match(admission.error, /readonly_capability_unavailable/);
    assert.equal((await started.completion).exitCode, null);
    assert.equal(readFileSync(sentinel, 'utf8'), 'BEFORE');
  } finally {
    if (prior === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prior;
    rmSync(root, { recursive: true, force: true });
  }
});

test('readonly temporary-home setup failure settles admission and completion without a running residue', async () => {
  const prior = process.env.TMPDIR;
  const missing = join(tmpdir(), 'f306-readonly-no-such-directory', 'missing');
  process.env.TMPDIR = missing;
  const unhandled = [];
  const observeUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', observeUnhandled);
  const runner = new ManagedRunner();
  try {
    const started = runner.start('printf UNEXPECTED', { cwd: '/', executionPolicy: 'read_only', timeoutMs: 2000 });
    const completion = started.completion.then(
      (value) => value,
      (error) => ({ rejected: error.message }),
    );
    const admission = await Promise.race([
      started.admission,
      new Promise((resolve) => setTimeout(() => resolve('PENDING'), 250)),
    ]);
    assert.notEqual(admission, 'PENDING');
    assert.equal(admission.spawned, false);
    const result = await completion;
    assert.equal(result.exitCode, null);
    assert.match(result.tailOutput, /ENOENT/);
    assert.equal(runner.state, 'completed');
    runner.cancel();
    assert.equal(runner.state, 'completed', 'terminal failure must clear its cancellation controller');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    runner.cancel();
    if (prior === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prior;
    process.removeListener('unhandledRejection', observeUnhandled);
  }
});

test('readonly cleanup failure remains a bounded completion and clears its cancellation controller', async (t) => {
  const prior = process.env.CODEX_BIN;
  const originalMkdtemp = fsPromises.mkdtemp;
  const originalRm = fsPromises.rm;
  let home;
  t.mock.method(fsPromises, 'mkdtemp', async (...args) => {
    home = await originalMkdtemp(...args);
    return home;
  });
  t.mock.method(fsPromises, 'rm', async () => {
    throw new Error('injected_readonly_cleanup_failure');
  });
  syncBuiltinESMExports();
  process.env.CODEX_BIN = 'relative-unavailable';
  const runner = new ManagedRunner();
  try {
    const started = runner.start('printf UNEXPECTED', { cwd: '/', executionPolicy: 'read_only', timeoutMs: 2000 });
    assert.equal((await started.admission).spawned, false);
    const result = await started.completion;
    assert.equal(result.exitCode, null);
    assert.match(result.tailOutput, /injected_readonly_cleanup_failure/);
    assert.equal(result.tailOutput.length < 8193, true);
    assert.equal(runner.state, 'completed');
    runner.cancel();
    assert.equal(runner.state, 'completed');
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (prior === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prior;
    if (home) await originalRm(home, { recursive: true, force: true });
  }
});

test('readonly durable-gate validation never exposes a pending admission', async () => {
  const runner = new ManagedRunner();
  const started = runner.start('printf UNEXPECTED', {
    cwd: '/',
    executionPolicy: 'read_only',
    maximumTimeoutMs: 2000,
  });
  assert.equal((await started.admission).spawned, false);
  const result = await started.completion;
  assert.match(result.tailOutput, /cannot_run_durable_gate/);
  assert.equal(runner.state, 'completed');
  runner.cancel();
  assert.equal(runner.state, 'completed');
});

test('readonly transport failure settles admission without unhandled completion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'f306-readonly-broken-transport-'));
  const binary = join(root, 'codex');
  const prior = process.env.CODEX_BIN;
  writeFileSync(
    binary,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "codex-cli 0.159.0\\n"; else exit 23; fi\n',
    { mode: 0o700 },
  );
  process.env.CODEX_BIN = binary;
  const runner = new ManagedRunner();
  try {
    const started = runner.start('printf UNEXPECTED', { cwd: root, executionPolicy: 'read_only', timeoutMs: 2000 });
    const admission = await started.admission;
    assert.equal(admission.spawned, false);
    const result = await started.completion;
    assert.equal(result.exitCode, null);
    assert.equal(result.tailOutput.length <= 8192, true);
    assert.equal(runner.state, 'completed');
  } finally {
    if (prior === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prior;
    rmSync(root, { recursive: true, force: true });
  }
});
