/**
 * ManagedRunner Tests (F167 Phase P — H3)
 *
 * TDD Red tests for the managed command runner that spawns shell commands,
 * captures output, handles timeout/cancel, and returns structured results.
 *
 * Test IDs: T1-T4 per f167-phase-p-wakewhen.md plan.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { ManagedRunner, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } = await import('../dist/infrastructure/managed-runner.js');

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
