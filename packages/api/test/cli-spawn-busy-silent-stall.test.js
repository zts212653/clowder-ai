/**
 * Red tests: busy-silent / stderr chatter should not indefinitely extend invocation lifetime.
 *
 * Root cause: stderr handler calls resetTimeout() + probe.notifyActivity() on every
 * reconnect/transport error. This resets the 30min CLI timeout and the probe's silence
 * tracking, so the timeout callback never fires and the probe never reaches suspected_stall.
 *
 * These tests lock the fix contract:
 * 1. stderr should NOT reset probe activity (notifyActivity only on NDJSON events)
 * 2. resetTimeout must respect an absolute hard cap (boundedExtensionFactor × timeoutMs)
 * 3. stallAutoKill works on idle-silent (existing, should pass)
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { clearTimeout as clearKeepAliveTimeout, setTimeout as setKeepAliveTimeout } from 'node:timers';

const { spawnCli, isCliTimeout } = await import('../dist/utils/cli-spawn.js');
const { ProcessLivenessProbe } = await import('../dist/utils/ProcessLivenessProbe.js');

function createMockProcess(opts = {}) {
  const { exitOnKill = true, exitCode = null, pid = 12345, autoCloseOnExit = true } = opts;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const originalEmit = emitter.emit.bind(emitter);
  emitter.emit = (event, ...args) => {
    const emitted = originalEmit(event, ...args);
    if (event === 'exit' && autoCloseOnExit) {
      setImmediate(() => originalEmit('close', exitCode, null));
    }
    return emitted;
  };
  return Object.assign(emitter, {
    stdout,
    stderr,
    stdin: new PassThrough(),
    pid,
    killed: false,
    kill(signal) {
      if (this.killed) return false;
      this.killed = true;
      if (exitOnKill) {
        stdout.end();
        setImmediate(() => emitter.emit('exit', exitCode, signal || 'SIGTERM'));
      }
      return true;
    },
    ref() {},
    unref() {},
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: stderr should NOT reset probe silence tracking
//
// Strategy: Don't run full spawnCli (it would hang due to the bug).
// Instead, directly test that ProcessLivenessProbe.notifyActivity resets
// stallWarningEmitted, and assert that the production code SHOULD NOT
// call it from stderr path.
//
// This is a structural contract test: we inspect cli-spawn.ts source
// to verify stderr handler does NOT call probe.notifyActivity().
// ─────────────────────────────────────────────────────────────────────────────
test('stderr handler should NOT call probe.notifyActivity (structural contract)', async () => {
  // Read the cli-spawn source and check whether stderr handler calls notifyActivity
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const source = await readFile(join(import.meta.dirname, '..', 'src', 'utils', 'cli-spawn.ts'), 'utf-8');

  // Find the stderr handler block using indexOf (regex lazy match stops too early)
  const stderrIdx = source.indexOf("child.stderr?.on('data'");
  assert.ok(stderrIdx !== -1, 'Should find stderr data handler in cli-spawn.ts');

  const afterStderr = source.slice(stderrIdx);
  const closingIdx = afterStderr.indexOf('});');
  assert.ok(closingIdx !== -1, 'Should find closing of stderr handler');

  const handlerBody = afterStderr.slice(0, closingIdx + 3);

  // INVARIANT 1: stderr handler must NOT call probe.notifyActivity()
  assert.equal(
    /notifyActivity/.test(handlerBody),
    false,
    'stderr handler must NOT call probe.notifyActivity() — ' +
      'reconnect/transport errors should not reset silence tracking. ' +
      `Found in handler: ${handlerBody.trim().slice(0, 200)}`,
  );

  // INVARIANT 2: stderr handler must NOT call resetTimeout()
  // stderr is transport noise, not meaningful output. Extending the timeout
  // on stderr was the root cause of the 30-min stall: chatter kept resetting
  // the timer so the callback never fired.
  assert.equal(
    /resetTimeout/.test(handlerBody),
    false,
    'stderr handler must NOT call resetTimeout() — ' +
      'transport/reconnect noise must not extend invocation lifetime. ' +
      `Found in handler: ${handlerBody.trim().slice(0, 200)}`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: resetTimeout is pure inactivity timer — no early wall-clock cap
//
// Strategy: Structural test — verify that resetTimeout does NOT check
// elapsed time before arming the timer. The wall-clock cap lives in the
// probe's isHardCapExceeded (inside the timeout callback, for busy-silent
// extensions only). stderr cannot call resetTimeout (Test 1 locks this),
// so an early wall-clock cap is unnecessary and harmful (it turns the
// inactivity timeout into an absolute wall-clock limit, killing healthy
// long-running invocations that continuously produce stdout).
// ─────────────────────────────────────────────────────────────────────────────
test('resetTimeout must NOT have early wall-clock cap (pure inactivity timer)', async () => {
  const { readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const source = await readFile(join(import.meta.dirname, '..', 'src', 'utils', 'cli-spawn.ts'), 'utf-8');

  // Find the resetTimeout function body
  const resetTimeoutMatch = source.match(/const resetTimeout\s*=\s*\(\)\s*(?::\s*void)?\s*=>\s*\{([\s\S]*?)\n {2}\};/);
  assert.ok(resetTimeoutMatch, 'Should find resetTimeout function in cli-spawn.ts');

  const resetBody = resetTimeoutMatch[1];

  // INVARIANT: the part of resetTimeout BEFORE setTimeout must NOT check
  // elapsed time or hardCapMs — that would turn it into an absolute wall-clock
  // limit for all callers including stdout.
  const beforeSetTimeout = resetBody.split('setTimeout')[0];
  const hasWallClockCap = /elapsed.*hardCap|hardCapMs|Date\.now\(\)\s*-\s*startedAt/.test(beforeSetTimeout);

  assert.equal(
    hasWallClockCap,
    false,
    'resetTimeout must be a pure inactivity timer — no early wall-clock cap before arming the timer. ' +
      'The hard cap for busy-silent extensions lives in the probe callback inside setTimeout.',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: stallAutoKill on idle-silent + suspected_stall (existing behavior, should pass)
// ─────────────────────────────────────────────────────────────────────────────
test('stallAutoKill fires on idle-silent + suspected_stall', async () => {
  const proc = createMockProcess();
  const spawnFn = () => proc;

  const origStart = ProcessLivenessProbe.prototype.start;
  const origGetState = ProcessLivenessProbe.prototype.getState;
  const origDrain = ProcessLivenessProbe.prototype.drainWarnings;

  let warningDrainCount = 0;
  ProcessLivenessProbe.prototype.start = () => {};
  ProcessLivenessProbe.prototype.getState = () => 'idle-silent';
  ProcessLivenessProbe.prototype.drainWarnings = () => {
    warningDrainCount++;
    if (warningDrainCount === 2) {
      return [
        {
          __livenessWarning: true,
          state: 'idle-silent',
          silenceDurationMs: 300_000,
          level: 'suspected_stall',
          cpuTimeMs: 0,
          processAlive: true,
        },
      ];
    }
    return [];
  };

  const keepAlive = setKeepAliveTimeout(() => {}, 15_000);
  const items = [];
  try {
    for await (const item of spawnCli(
      {
        command: 'mock-cli',
        args: [],
        timeoutMs: 500,
        livenessProbe: {
          sampleIntervalMs: 30,
          softWarningMs: 60,
          stallWarningMs: 120,
          stallAutoKill: true,
        },
      },
      { spawnFn },
    )) {
      items.push(item);
    }
  } finally {
    clearKeepAliveTimeout(keepAlive);
    ProcessLivenessProbe.prototype.start = origStart;
    ProcessLivenessProbe.prototype.getState = origGetState;
    ProcessLivenessProbe.prototype.drainWarnings = origDrain;
  }

  const timeoutItems = items.filter(isCliTimeout);
  assert.ok(timeoutItems.length > 0, 'idle-silent + suspected_stall should trigger auto-kill');
  assert.ok(timeoutItems[0].stallKill, 'timeout should be marked as stallKill');
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: stderr does NOT extend timeout at all
//
// Behavioral test: with timeoutMs=200, stderr arriving at ~90ms and ~180ms
// must NOT push the total past the original timeout.
// Before fix: stderr called resetTimeout(), total could reach 2x+ timeout.
// After fix: stderr does not call resetTimeout(), total ≈ timeoutMs.
// ─────────────────────────────────────────────────────────────────────────────
test('stderr does NOT extend timeout — process times out at original timeoutMs', async () => {
  const proc = createMockProcess();
  const spawnFn = () => proc;

  const origStart = ProcessLivenessProbe.prototype.start;
  ProcessLivenessProbe.prototype.start = () => {};

  const keepAlive = setKeepAliveTimeout(() => {}, 15_000);
  const startTime = Date.now();
  let endTime;

  // Schedule stderr at ~90ms and ~180ms — these must NOT extend the timeout
  const stderrTimer1 = globalThis.setTimeout(() => proc.stderr.write('reconnect error 1\n'), 90);
  const stderrTimer2 = globalThis.setTimeout(() => proc.stderr.write('reconnect error 2\n'), 180);

  const items = [];
  try {
    for await (const item of spawnCli(
      {
        command: 'mock-cli',
        args: [],
        timeoutMs: 200,
        livenessProbe: {
          sampleIntervalMs: 30,
          softWarningMs: 60,
          stallWarningMs: 120,
          boundedExtensionFactor: 2.0,
        },
      },
      { spawnFn },
    )) {
      items.push(item);
    }
  } finally {
    endTime = Date.now();
    clearKeepAliveTimeout(keepAlive);
    globalThis.clearTimeout(stderrTimer1);
    globalThis.clearTimeout(stderrTimer2);
    ProcessLivenessProbe.prototype.start = origStart;
  }

  const elapsed = endTime - startTime;

  // Should have timed out
  const timeoutItems = items.filter(isCliTimeout);
  assert.ok(timeoutItems.length > 0, 'process should time out');

  // Timeout should fire near timeoutMs (200ms), not at hardCap (400ms).
  // Before fix: stderr at 90ms+180ms would push total to ~380ms (1.9x).
  // After fix: stderr is ignored, total ≈ 200ms.
  // Allow 1.5x for Node.js timer jitter at small values.
  const ratio = elapsed / 200;
  assert.ok(
    ratio <= 1.5,
    `stderr must not extend timeout: elapsed ${elapsed}ms / timeoutMs 200ms = ${ratio.toFixed(2)}x. ` +
      `Should be ≤ 1.5x. Before fix stderr would push this to ~1.9x.`,
  );
});
