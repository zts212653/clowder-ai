/**
 * ManagedRunner Tests (F167 Phase P — H3)
 *
 * TDD Red tests for the managed command runner that spawns shell commands,
 * captures output, handles timeout/cancel, and returns structured results.
 *
 * Test IDs: T1-T4 per f167-phase-p-wakewhen.md plan.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const { ManagedRunner, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } = await import('../dist/infrastructure/managed-runner.js');
const execFileAsync = promisify(execFile);

// ─── T1: Command exits normally → exitCode + output ───────────────────────

test('T1: launch echo → exitCode=0, output contains text', async () => {
  const runner = new ManagedRunner();
  assert.strictEqual(runner.state, 'idle');

  const result = await runner.launch('echo hello-managed-runner');

  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.timedOut, false);
  assert.ok(result.durationMs >= 0, 'durationMs should be non-negative');
  assert.ok(result.tailOutput.includes('hello-managed-runner'), 'output should contain echoed text');
  assert.strictEqual(runner.state, 'completed');
});

test('T1a: managed commands do not inherit cat CLI process markers', async () => {
  const previousOwnerId = process.env.CAT_CAFE_PROCESS_OWNER_ID;
  const previousCliContext = process.env.CAT_CAFE_CLI_PROCESS_CONTEXT;
  process.env.CAT_CAFE_PROCESS_OWNER_ID = 'cat-owned-parent';
  process.env.CAT_CAFE_CLI_PROCESS_CONTEXT = 'cat';

  try {
    const runner = new ManagedRunner();
    const result = await runner.launch(
      `if [ -n "\${CAT_CAFE_PROCESS_OWNER_ID:-}" ] || [ -n "\${CAT_CAFE_CLI_PROCESS_CONTEXT:-}" ]; then exit 73; else echo managed-owner-isolated; fi`,
    );

    assert.strictEqual(result.exitCode, 0);
    assert.match(result.tailOutput, /managed-owner-isolated/);
  } finally {
    if (previousOwnerId === undefined) {
      delete process.env.CAT_CAFE_PROCESS_OWNER_ID;
    } else {
      process.env.CAT_CAFE_PROCESS_OWNER_ID = previousOwnerId;
    }
    if (previousCliContext === undefined) {
      delete process.env.CAT_CAFE_CLI_PROCESS_CONTEXT;
    } else {
      process.env.CAT_CAFE_CLI_PROCESS_CONTEXT = previousCliContext;
    }
  }
});

test('T1b: multi-line output → tailOutput captures last N lines', async () => {
  const runner = new ManagedRunner();
  // Generate 60 lines, tailOutput should only have last 50
  const result = await runner.launch('for i in $(seq 1 60); do echo "line-$i"; done');

  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.tailOutput.includes('line-60'), 'should include last line');
  assert.ok(result.tailOutput.includes('line-11'), 'should include line-11 (within tail 50)');
  // line-1 through line-10 should be truncated (60 lines, tail 50 = lines 11-60)
  const lines = result.tailOutput.trim().split('\n');
  assert.ok(lines.length <= 50, `tailOutput should have at most 50 lines, got ${lines.length}`);
});

// ─── T2: Command fails → non-zero exitCode ────────────────────────────────

test('T2: launch exit 1 → exitCode=1', async () => {
  const runner = new ManagedRunner();
  const result = await runner.launch('exit 42');

  assert.strictEqual(result.exitCode, 42);
  assert.strictEqual(result.timedOut, false);
  assert.strictEqual(runner.state, 'completed');
});

test('T2b: command with stderr → tailOutput captures stderr too', async () => {
  const runner = new ManagedRunner();
  const result = await runner.launch('echo "stdout-line" && echo "stderr-line" >&2 && exit 1');

  assert.strictEqual(result.exitCode, 1);
  assert.ok(result.tailOutput.includes('stdout-line'), 'should capture stdout');
  assert.ok(result.tailOutput.includes('stderr-line'), 'should capture stderr');
});

test('T2c: bundled rg remains available when daemon PATH omits interactive tools', async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = '/usr/bin:/bin';

  try {
    const runner = new ManagedRunner();
    const result = await runner.launch('printf "real-terminal-outcome\\n" | rg "^real-terminal-outcome$"');

    assert.strictEqual(result.exitCode, 0);
    assert.strictEqual(result.timedOut, false);
    assert.ok(
      result.tailOutput.includes('real-terminal-outcome'),
      `expected primary command evidence, got: ${result.tailOutput}`,
    );
  } finally {
    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
});

test('T2d: unresolved bundled rg preserves an absent daemon PATH for shell fallback', async () => {
  const childEnv = { ...process.env };
  delete childEnv.PATH;
  childEnv.npm_config_arch = 'review-unsupported';

  const managedRunnerUrl = new URL('../dist/infrastructure/managed-runner.js', import.meta.url).href;
  const script = `
    const { ManagedRunner } = await import(${JSON.stringify(managedRunnerUrl)});
    const result = await new ManagedRunner().launch('cat /dev/null && printf "fallback-shell-path-ok\\n"');
    process.stdout.write('RESULT=' + JSON.stringify(result) + '\\n');
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', script], {
    env: childEnv,
  });
  const resultLine = stdout.split('\n').find((line) => line.startsWith('RESULT='));
  assert.ok(resultLine, `expected child result, got: ${stdout}`);

  const result = JSON.parse(resultLine.slice('RESULT='.length));
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.timedOut, false);
  assert.ok(
    result.tailOutput.includes('fallback-shell-path-ok'),
    `expected fallback shell evidence, got: ${result.tailOutput}`,
  );
});

// ─── T3: Timeout → process killed, timedOut=true ──────────────────────────

test('T3: launch long-running command with short timeout → timedOut=true', async () => {
  const runner = new ManagedRunner();
  const result = await runner.launch('sleep 999', { timeoutMs: 200 });

  assert.strictEqual(result.timedOut, true);
  assert.strictEqual(result.exitCode, null, 'exitCode should be null when killed by timeout');
  assert.ok(result.durationMs >= 150, 'should have run at least ~200ms');
  assert.ok(result.durationMs < 10_000, 'should not wait for full sleep 999');
  assert.strictEqual(runner.state, 'timed_out');
});

// ─── T4: Cancel → SIGTERM sent, exitCode=null ─────────────────────────────

test('T4: cancel running command → exitCode=null', async () => {
  const runner = new ManagedRunner();

  // Launch a long-running process, then cancel after a brief delay
  const resultPromise = runner.launch('sleep 999', { timeoutMs: 60_000 });

  // Wait for process to actually start
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(runner.state, 'running');
  assert.ok(runner.pid != null, 'pid should be set while running');

  runner.cancel();

  const result = await resultPromise;
  assert.strictEqual(result.exitCode, null, 'exitCode should be null when cancelled');
  assert.strictEqual(result.timedOut, false, 'timedOut should be false for cancel');
  assert.strictEqual(runner.state, 'cancelled');
});

// ─── State machine invariants ─────────────────────────────────────────────

test('state: idle runner has no pid', () => {
  const runner = new ManagedRunner();
  assert.strictEqual(runner.state, 'idle');
  assert.strictEqual(runner.pid, null);
});

test('state: cannot launch twice without creating new runner', async () => {
  const runner = new ManagedRunner();
  await runner.launch('echo first');
  assert.strictEqual(runner.state, 'completed');

  await assert.rejects(
    () => runner.launch('echo second'),
    (err) => {
      assert.ok(err.message.includes('not idle'), `expected "not idle" error, got: ${err.message}`);
      return true;
    },
  );
});

test('state: cancel on idle runner is no-op', () => {
  const runner = new ManagedRunner();
  // Should not throw
  runner.cancel();
  assert.strictEqual(runner.state, 'idle');
});

// ─── cwd option ───────────────────────────────────────────────────────────

test('cwd: command runs in specified directory', async () => {
  const runner = new ManagedRunner();
  const result = await runner.launch('pwd', { cwd: '/tmp' });

  assert.strictEqual(result.exitCode, 0);
  // macOS: /tmp → /private/tmp symlink
  assert.ok(
    result.tailOutput.includes('/tmp') || result.tailOutput.includes('/private/tmp'),
    `expected /tmp in output, got: ${result.tailOutput.trim()}`,
  );
});

// ─── Defaults ─────────────────────────────────────────────────────────────

test('defaults: DEFAULT_TIMEOUT_MS is 600000 (10 min)', () => {
  assert.strictEqual(DEFAULT_TIMEOUT_MS, 600_000);
});

test('defaults: MAX_TIMEOUT_MS is 3600000 (1 hour)', () => {
  assert.strictEqual(MAX_TIMEOUT_MS, 3_600_000);
});

// ─── Cleanup: log file removed after completion ───────────────────────────

test('cleanup: log file is removed after launch completes', async () => {
  const runner = new ManagedRunner();
  await runner.launch('echo cleanup-test');

  // After completion, the log file should have been cleaned up
  // We can't easily check the exact path, but state should be completed
  assert.strictEqual(runner.state, 'completed');
  // The logPath getter (if exposed) should reflect cleanup
  assert.strictEqual(runner.logPath, null, 'logPath should be null after cleanup');
});

// ─── R4 regression: partial-line buffer cap ─────────────────────────────

test('R4-P2-7: huge line without newline → partial buffer capped, no memory blow', async () => {
  const runner = new ManagedRunner();
  // Emit a 2MB line without newlines — partial-line buffer should cap at 1MB.
  // Use printf to avoid shell arg limits: repeat a pattern via head -c.
  const result = await runner.launch('head -c 2000000 /dev/zero | tr "\\0" "A"');

  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.timedOut, false);
  // Output should exist (captured something) but not the full 2MB
  assert.ok(result.tailOutput.length > 0, 'should capture some output');
  // The cap is 1MB for the partial line, so tailOutput should be ≤ 1MB + margin
  assert.ok(
    result.tailOutput.length <= 1_100_000,
    `tailOutput should be capped near 1MB, got ${result.tailOutput.length}`,
  );
});

// ─── R4: close event for stdio drain (correctness, not deterministically regression-testable) ──

// NOTE: The exit→close fix (R4-P2-9) uses child.on('close') instead of child.on('exit')
// to ensure stdio streams fully drain before reading the rolling tail. This is a Node.js
// best-practice fix for a timing race that occurs when a process writes output immediately
// before exiting. The race is non-deterministic and depends on OS pipe buffer timing, so
// a test that reliably passes with 'close' but fails with 'exit' is not feasible.
// Instead, we verify the behavioral contract: output from fast-exit commands IS captured.
test('R4-P2-9: fast-exit command output is fully captured', async () => {
  const runner = new ManagedRunner();
  // Subprocess writes 100 lines and exits immediately. Verifies that output
  // piped through stdio is captured in the rolling tail regardless of timing.
  const result = await runner.launch('for i in $(seq 1 100); do echo "drain-test-$i"; done && exit 0');

  assert.strictEqual(result.exitCode, 0);
  assert.ok(result.tailOutput.includes('drain-test-100'), 'should capture final line');
  assert.ok(result.tailOutput.includes('drain-test-51'), 'should include lines within tail window');
});

// ─── Two-phase start(): spawn admission truth (F167 Phase P) ─────────────
// RED-1: Long command admission returns immediately with real pid

test('start: admission resolves immediately with pid for long-running command', async () => {
  const runner = new ManagedRunner();
  const { admission, completion } = runner.start('sleep 999', { timeoutMs: 60_000 });

  const admit = await admission;
  assert.strictEqual(admit.spawned, true);
  assert.ok(typeof admit.pid === 'number' && admit.pid > 0, `pid should be a positive number, got: ${admit.pid}`);
  assert.strictEqual(runner.state, 'running');

  // Admission should resolve fast (< 2s) even though the command takes 999s
  // (verified by reaching here without hitting the test timeout)

  // Clean up: cancel and await completion
  runner.cancel();
  const result = await completion;
  assert.strictEqual(result.exitCode, null, 'cancelled command should have null exitCode');
});

// RED-2: Spawn error produces no active hold/runner residue

test('start: spawn error → admission.spawned=false, no running state residue', async () => {
  const runner = new ManagedRunner();
  // Use a command with a non-existent cwd to trigger spawn error
  const { admission, completion } = runner.start('echo hello', { cwd: '/nonexistent-path-that-does-not-exist-12345' });

  const admit = await admission;
  // Spawn should fail (bad cwd)
  assert.strictEqual(admit.spawned, false);
  assert.strictEqual(admit.pid, null);
  assert.ok(admit.error, 'should have an error message');

  // Runner should NOT be in 'running' state
  assert.notStrictEqual(runner.state, 'running', 'state must not be running after spawn error');

  // completion should also resolve (not hang forever)
  const result = await completion;
  assert.strictEqual(result.exitCode, null, 'spawn error should have null exitCode');
});

// RED-3: start() still returns correct completion result (same as launch() semantics)

test('start: completion result matches launch() semantics for successful command', async () => {
  const runner = new ManagedRunner();
  const { admission, completion } = runner.start('echo spawn-truth-test');

  const admit = await admission;
  assert.strictEqual(admit.spawned, true);
  assert.ok(admit.pid != null, 'should have pid');

  const result = await completion;
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.timedOut, false);
  assert.ok(result.tailOutput.includes('spawn-truth-test'));
  assert.strictEqual(runner.state, 'completed');
});

// RED-4: Immediate exit race — admission and completion each settle exactly once

test('start: immediate-exit command → both admission and completion settle correctly', async () => {
  const runner = new ManagedRunner();
  // 'true' exits instantly — tests the race where close fires before admission consumer awaits
  const { admission, completion } = runner.start('true');

  const admit = await admission;
  assert.strictEqual(admit.spawned, true);

  const result = await completion;
  assert.strictEqual(result.exitCode, 0);
  assert.strictEqual(result.timedOut, false);
  assert.strictEqual(runner.state, 'completed');
});

// RED-5: start() on non-idle runner throws (same invariant as launch())

test('start: cannot start twice', async () => {
  const runner = new ManagedRunner();
  const { admission, completion } = runner.start('echo first');
  await admission;
  await completion;

  assert.throws(
    () => runner.start('echo second'),
    (err) => {
      assert.ok(err.message.includes('not idle'), `expected "not idle" error, got: ${err.message}`);
      return true;
    },
  );
});

test('durable managed job survives supervisor exit and writes to its persistent log', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'managed-runner-durable-'));
  const markerPath = join(tempDir, 'survived.txt');
  const managedRoot = join(tempDir, 'managed-gate-jobs');
  const logPath = join(managedRoot, 'managed-gate-restart-test.log');
  const recordPath = join(managedRoot, 'managed-gate-restart-test.json');
  const workerPidPath = join(tempDir, 'worker.pid');
  const managedRunnerUrl = new URL('../dist/infrastructure/managed-runner.js', import.meta.url).href;
  const durableJobUrl = new URL('../dist/domains/ball-custody/durable-managed-gate-job.js', import.meta.url).href;
  const descriptor = {
    kind: 'full_gate',
    jobId: 'managed-gate-restart-test',
    originTaskId: 'hold-ball-restart-test',
    supervisorEpoch: 'parent-crash-epoch',
    recordPath,
    gateReceiptPath: join(managedRoot, 'managed-gate-restart-test.gate.json'),
    logPath,
    executionSlaMs: 1_000,
    wallSlaMs: 180_000,
    wakeTarget: { threadId: 'thread-restart-test', catId: 'codex-sol', userId: 'user-restart-test' },
  };
  const command = `printf "detached-output\\n"; printf "survived\\n" > ${JSON.stringify(markerPath)}; sleep 999`;
  const parentScript = `
    const { writeFileSync } = await import('node:fs');
    process.env.CAT_CAFE_DATA_DIR = ${JSON.stringify(tempDir)};
    const { initializeDurableManagedGateJob } = await import(${JSON.stringify(durableJobUrl)});
    const { ManagedRunner } = await import(${JSON.stringify(managedRunnerUrl)});
    const descriptor = ${JSON.stringify(descriptor)};
    initializeDurableManagedGateJob(descriptor);
    const runner = new ManagedRunner();
    const { admission } = runner.start(${JSON.stringify(command)}, {
      timeoutMs: 5_000,
      maximumTimeoutMs: 5_000,
      managedJob: descriptor,
    });
    const admitted = await admission;
    if (admitted.pid) writeFileSync(${JSON.stringify(workerPidPath)}, String(admitted.pid));
    process.exit(admitted.spawned ? 0 : 2);
  `;

  try {
    await execFileAsync(process.execPath, ['--input-type=module', '--eval', parentScript]);
    const deadline = Date.now() + 2_000;
    while (
      (!existsSync(markerPath) || !existsSync(logPath) || !readFileSync(logPath, 'utf8').includes('detached-output')) &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const durableRecord = JSON.parse(readFileSync(recordPath, 'utf8'));
    assert.equal(durableRecord.state, 'running', 'worker must journal its own birth before command execution');
    assert.equal(durableRecord.ownerIdentity.pid, Number(readFileSync(workerPidPath, 'utf8')));
    const { inspectDurableManagedGateJob } = await import('../dist/domains/ball-custody/durable-managed-gate-job.js');
    const adopted = inspectDurableManagedGateJob(descriptor, {
      now: Date.now() + 60_001,
      supervisorEpoch: 'fresh-supervisor-epoch',
    });
    assert.equal(adopted.state, 'adopted', 'a fresh supervisor must adopt the exact live worker, never mark it lost');
    assert.equal(readFileSync(markerPath, 'utf8'), 'survived\n');
    assert.match(readFileSync(logPath, 'utf8'), /detached-output/);
  } finally {
    if (existsSync(workerPidPath)) {
      try {
        process.kill(-Number(readFileSync(workerPidPath, 'utf8')), 'SIGKILL');
      } catch {
        // Worker already reached terminal.
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('durable worker exits fail-closed before command execution when birth registration cannot commit', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'managed-runner-durable-fail-closed-'));
  const managedRoot = join(tempDir, 'managed-gate-jobs');
  const markerPath = join(tempDir, 'must-not-exist.txt');
  const previousDataDir = process.env.CAT_CAFE_DATA_DIR;
  process.env.CAT_CAFE_DATA_DIR = tempDir;
  try {
    const descriptor = {
      kind: 'full_gate',
      jobId: 'managed-gate-fail-closed-test',
      originTaskId: 'hold-ball-fail-closed-test',
      supervisorEpoch: 'fail-closed-epoch',
      recordPath: join(managedRoot, 'managed-gate-fail-closed-test.json'),
      gateReceiptPath: join(managedRoot, 'managed-gate-fail-closed-test.gate.json'),
      logPath: join(managedRoot, 'managed-gate-fail-closed-test.log'),
      executionSlaMs: 1_000,
      wallSlaMs: 5_000,
      wakeTarget: { threadId: 'thread-fail-closed', catId: 'codex-sol', userId: 'user-fail-closed' },
    };
    const runner = new ManagedRunner();
    const result = await runner.launch(`printf "ran\\n" > ${JSON.stringify(markerPath)}`, {
      timeoutMs: 5_000,
      maximumTimeoutMs: 5_000,
      managedJob: descriptor,
    });

    assert.equal(result.exitCode, 70);
    assert.equal(existsSync(markerPath), false, 'the gate command must not run before durable birth registration');
    assert.match(result.tailOutput, /birth registration failed; command was not executed/);
  } finally {
    if (previousDataDir === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previousDataDir;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('durable worker does not execute a gate when cancellation won the pre-execution race', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'managed-runner-durable-cancel-before-exec-'));
  const managedRoot = join(tempDir, 'managed-gate-jobs');
  const markerPath = join(tempDir, 'must-not-exist.txt');
  const previousDataDir = process.env.CAT_CAFE_DATA_DIR;
  process.env.CAT_CAFE_DATA_DIR = tempDir;
  try {
    const descriptor = {
      kind: 'full_gate',
      jobId: 'managed-gate-cancel-before-exec',
      originTaskId: 'hold-ball-cancel-before-exec',
      supervisorEpoch: 'cancel-before-exec-epoch',
      recordPath: join(managedRoot, 'managed-gate-cancel-before-exec.json'),
      gateReceiptPath: join(managedRoot, 'managed-gate-cancel-before-exec.gate.json'),
      logPath: join(managedRoot, 'managed-gate-cancel-before-exec.log'),
      executionSlaMs: 1_000,
      wallSlaMs: 5_000,
      wakeTarget: { threadId: 'thread-cancel-before-exec', catId: 'codex-sol', userId: 'user-cancel-before-exec' },
    };
    const { initializeDurableManagedGateJob } = await import(
      '../dist/domains/ball-custody/durable-managed-gate-job.js'
    );
    const { admitDurableGateCancellationRequest } = await import(
      '../dist/domains/ball-custody/durable-managed-gate-cancellation.js'
    );
    initializeDurableManagedGateJob(descriptor);
    admitDurableGateCancellationRequest(descriptor, {
      requestedAt: Date.now(),
      cancelledBy: 'operator:test-user',
      reason: 'explicit_hold_cancel',
    });

    const runner = new ManagedRunner();
    const result = await runner.launch(`printf "ran\\n" > ${JSON.stringify(markerPath)}`, {
      timeoutMs: 5_000,
      maximumTimeoutMs: 5_000,
      managedJob: descriptor,
    });

    assert.equal(result.exitCode, 70);
    assert.equal(existsSync(markerPath), false);
    assert.match(result.tailOutput, /cancellation was requested before execution/);
  } finally {
    if (previousDataDir === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previousDataDir;
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('durable managed job keeps restart-safe logs within the configured bound', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'managed-runner-durable-log-bound-'));
  const managedRoot = join(tempDir, 'managed-gate-jobs');
  const logPath = join(managedRoot, 'managed-gate-log-bound-test.log');
  const previousDataDir = process.env.CAT_CAFE_DATA_DIR;
  process.env.CAT_CAFE_DATA_DIR = tempDir;
  try {
    const { initializeDurableManagedGateJob } = await import(
      '../dist/domains/ball-custody/durable-managed-gate-job.js'
    );
    const descriptor = {
      kind: 'full_gate',
      jobId: 'managed-gate-log-bound-test',
      originTaskId: 'hold-ball-log-bound-test',
      supervisorEpoch: 'log-bound-epoch',
      recordPath: join(managedRoot, 'managed-gate-log-bound-test.json'),
      gateReceiptPath: join(managedRoot, 'managed-gate-log-bound-test.gate.json'),
      logPath,
      executionSlaMs: 5_000,
      wallSlaMs: 10_000,
      wakeTarget: { threadId: 'thread-log-bound', catId: 'codex-sol', userId: 'user-log-bound' },
    };
    initializeDurableManagedGateJob(descriptor);
    const runner = new ManagedRunner();
    const result = await runner.launch('head -c 11000000 /dev/zero | tr "\\0" "A"; printf "final-tail\\n"', {
      timeoutMs: 10_000,
      maximumTimeoutMs: 10_000,
      managedJob: descriptor,
    });

    assert.equal(result.exitCode, 0);
    assert.ok(statSync(logPath).size <= 10 * 1024 * 1024, `durable log exceeded bound: ${statSync(logPath).size}`);
    assert.match(result.tailOutput, /final-tail/);
  } finally {
    if (previousDataDir === undefined) delete process.env.CAT_CAFE_DATA_DIR;
    else process.env.CAT_CAFE_DATA_DIR = previousDataDir;
    rmSync(tempDir, { recursive: true, force: true });
  }
});
