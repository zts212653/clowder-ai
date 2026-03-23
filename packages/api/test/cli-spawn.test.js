/**
 * CLI Spawn Tests
 * 测试 CLI 子进程管理器
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mock, test } from 'node:test';
import { clearTimeout as clearKeepAliveTimeout, setTimeout as setKeepAliveTimeout } from 'node:timers';

const { spawnCli, isCliError, isCliTimeout, isLivenessWarning, KILL_GRACE_MS, SEMANTIC_COMPLETION_GRACE_MS } =
  await import('../dist/utils/cli-spawn.js');

/** Helper: collect all items from async iterable */
async function collect(iterable) {
  const keepAlive = setKeepAliveTimeout(() => {}, 15_000);
  const items = [];
  try {
    for await (const item of iterable) {
      items.push(item);
    }
    return items;
  } finally {
    clearKeepAliveTimeout(keepAlive);
  }
}

/**
 * Create a mock child process for testing.
 * @param {{ exitOnKill?: boolean, exitCode?: number }} opts
 *   exitOnKill: if true (default), killing closes stdout and emits exit.
 *   exitCode: the code to emit on exit (default null for signal kills).
 */
function createMockProcess(opts = {}) {
  const { exitOnKill = true, exitCode = null, pid = 12345 } = opts;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const proc = {
    stdout,
    stderr,
    pid,
    exitCode: null,
    kill: mock.fn((signal) => {
      if (exitOnKill) {
        process.nextTick(() => {
          if (!stdout.destroyed) stdout.end();
          emitter.emit('exit', exitCode, signal || 'SIGTERM');
        });
      }
      return true;
    }),
    on: (event, listener) => {
      emitter.on(event, listener);
      return proc;
    },
    once: (event, listener) => {
      emitter.once(event, listener);
      return proc;
    },
    // Expose emitter for manual event emission in tests
    _emitter: emitter,
  };
  return proc;
}

/** Create a mock SpawnFn that returns the given mock process */
function createMockSpawnFn(mockProcess) {
  return mock.fn(() => mockProcess);
}

test('spawnCli yields parsed JSON events from stdout', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: ['--json'] }, { spawnFn }));

  proc.stdout.write('{"type":"start","id":"123"}\n');
  proc.stdout.write('{"type":"message","text":"hello"}\n');
  proc.stdout.end();
  // Emit clean exit
  proc._emitter.emit('exit', 0, null);

  const results = await promise;

  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { type: 'start', id: '123' });
  assert.deepEqual(results[1], { type: 'message', text: 'hello' });

  // Verify spawn was called with correct args
  assert.equal(spawnFn.mock.callCount(), 1);
  assert.equal(spawnFn.mock.calls[0].arguments[0], 'test-cli');
  assert.deepEqual(spawnFn.mock.calls[0].arguments[1], ['--json']);
});

test('spawnCli does not yield stderr data', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [] }, { spawnFn }));

  proc.stderr.write('DEBUG: some warning\n');
  proc.stdout.write('{"type":"ok"}\n');
  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);

  const results = await promise;
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], { type: 'ok' });
});

test('spawnCli yields parse errors alongside valid JSON', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [] }, { spawnFn }));

  proc.stdout.write('{"valid":true}\n');
  proc.stdout.write('not-json-line\n');
  proc.stdout.write('{"also":"valid"}\n');
  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);

  const results = await promise;

  // F166: parse errors are now yielded so consumers can decide how to handle them
  assert.equal(results.length, 3);
  assert.deepEqual(results[0], { valid: true });
  assert.equal(results[1].__parseError, true);
  assert.equal(results[1].line, 'not-json-line');
  assert.deepEqual(results[2], { also: 'valid' });
});

test('parse-error noise does not reset timeout forever', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [], timeoutMs: 60 }, { spawnFn }));

  const noiseTimer = setInterval(() => {
    if (!proc.stdout.writableEnded) {
      proc.stdout.write('not-json-line\n');
    }
  }, 10);

  // Let timeout fire while noise is still arriving.
  await new Promise((resolve) => setTimeout(resolve, 140));
  clearInterval(noiseTimer);
  if (!proc.stdout.writableEnded) proc.stdout.end();

  const results = await promise;
  const hasTimeout = results.some((r) => isCliTimeout(r));
  assert.equal(hasTimeout, true, 'invalid stdout noise should not keep invocation alive');
});

test('spawnCli kills process on timeout', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [], timeoutMs: 50 }, { spawnFn }));

  // Don't write anything to stdout - let it timeout
  // Wait for timeout to fire, then close stdout
  await new Promise((resolve) => setTimeout(resolve, 100));
  proc.stdout.end();

  await promise;

  // Verify kill was called
  assert.ok(proc.kill.mock.callCount() >= 1);
  assert.equal(proc.kill.mock.calls[0].arguments[0], 'SIGTERM');
});

test('CLI_TIMEOUT_MS=0 disables timeout (no auto-kill on silence)', async () => {
  const saved = process.env.CLI_TIMEOUT_MS;
  process.env.CLI_TIMEOUT_MS = '0';
  try {
    const proc = createMockProcess();
    const spawnFn = createMockSpawnFn(proc);

    const promise = collect(spawnCli({ command: 'test-cli', args: [] }, { spawnFn }));

    // Wait longer than our typical small timeout values; should NOT auto-kill
    await new Promise((resolve) => setTimeout(resolve, 120));

    proc.stdout.end();
    proc._emitter.emit('exit', 0, null);

    await promise;

    assert.equal(proc.kill.mock.callCount(), 0, 'should not kill when timeout is disabled');
  } finally {
    if (saved === undefined) {
      delete process.env.CLI_TIMEOUT_MS;
    } else {
      process.env.CLI_TIMEOUT_MS = saved;
    }
  }
});

test('spawnCli uses 5 minute fallback timeout when CLI_TIMEOUT_MS is unset', async () => {
  const savedEnv = process.env.CLI_TIMEOUT_MS;
  delete process.env.CLI_TIMEOUT_MS;

  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const originalSetTimeout = global.setTimeout;
  const delays = [];

  global.setTimeout = (_handler, delay, ...args) => {
    delays.push(delay);
    return originalSetTimeout(() => {}, 0, ...args);
  };

  try {
    const promise = collect(spawnCli({ command: 'test-cli', args: [] }, { spawnFn }));

    proc.stdout.end();
    proc._emitter.emit('exit', 0, null);
    await promise;

    assert.ok(delays.length > 0);
    assert.equal(delays[0], 300000);
  } finally {
    global.setTimeout = originalSetTimeout;
    if (savedEnv === undefined) {
      delete process.env.CLI_TIMEOUT_MS;
    } else {
      process.env.CLI_TIMEOUT_MS = savedEnv;
    }
  }
});

test('spawnCli resets timeout on stderr activity (CLI alive signal)', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [], timeoutMs: 50 }, { spawnFn }));

  // Keep the process "alive" with stderr output so it doesn't timeout
  await new Promise((resolve) => setTimeout(resolve, 20));
  proc.stderr.write('thinking...\n');
  await new Promise((resolve) => setTimeout(resolve, 20));
  proc.stderr.write('still working...\n');
  await new Promise((resolve) => setTimeout(resolve, 20));

  proc.stdout.write('{"type":"ok"}\n');
  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);

  const results = await promise;

  assert.equal(proc.kill.mock.callCount(), 0, 'should not kill while stderr is active');
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], { type: 'ok' });
});

test('spawnCli kills process on abort signal', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const controller = new AbortController();

  const promise = collect(spawnCli({ command: 'test-cli', args: [], signal: controller.signal }, { spawnFn }));

  // Write one event then abort
  proc.stdout.write('{"type":"first"}\n');
  controller.abort();

  // Close stdout after abort
  await new Promise((resolve) => setTimeout(resolve, 50));
  proc.stdout.end();

  const results = await promise;

  // Should have the first event
  assert.ok(results.length >= 1);
  assert.deepEqual(results[0], { type: 'first' });

  // Verify kill was called
  assert.ok(proc.kill.mock.callCount() >= 1);
});

test('spawnCli cleans up on consumer break (early return)', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  // Write data before iterating so the loop has something to break on
  proc.stdout.write('{"type":"first"}\n');
  proc.stdout.write('{"type":"second"}\n');

  const results = [];
  for await (const event of spawnCli({ command: 'test-cli', args: [] }, { spawnFn })) {
    results.push(event);
    if (results.length === 1) break; // Consumer stops early
  }

  assert.equal(results.length, 1);
  assert.deepEqual(results[0], { type: 'first' });

  // Verify kill was called (cleanup via finally)
  assert.ok(proc.kill.mock.callCount() >= 1);
});

test('spawnCli passes cwd and env to spawn', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(
    spawnCli(
      {
        command: 'claude',
        args: ['-p', 'hello'],
        cwd: '/some/project',
        env: { CUSTOM_VAR: 'value' },
      },
      { spawnFn },
    ),
  );

  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);
  await promise;

  const spawnCall = spawnFn.mock.calls[0];
  assert.equal(spawnCall.arguments[0], 'claude');
  assert.deepEqual(spawnCall.arguments[1], ['-p', 'hello']);
  assert.equal(spawnCall.arguments[2].cwd, '/some/project');
  assert.equal(spawnCall.arguments[2].env.CUSTOM_VAR, 'value');
});

test('spawnCli removes inherited env vars when override is null', async () => {
  const saved = process.env.SPAWN_DELETE_ME;
  process.env.SPAWN_DELETE_ME = 'secret-value';

  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const promise = collect(
    spawnCli(
      {
        command: 'claude',
        args: ['-p', 'hello'],
        env: { SPAWN_DELETE_ME: null, KEEP_ME: '1' },
      },
      { spawnFn },
    ),
  );

  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);
  await promise;

  const env = spawnFn.mock.calls[0].arguments[2].env;
  assert.equal(env.SPAWN_DELETE_ME, undefined);
  assert.equal(Object.hasOwn(env, 'SPAWN_DELETE_ME'), false);
  assert.equal(env.KEEP_ME, '1');

  if (saved === undefined) delete process.env.SPAWN_DELETE_ME;
  else process.env.SPAWN_DELETE_ME = saved;
});

test('spawnCli handles already-aborted signal', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const controller = new AbortController();
  controller.abort(); // Already aborted

  const promise = collect(spawnCli({ command: 'test-cli', args: [], signal: controller.signal }, { spawnFn }));

  proc.stdout.end();
  await promise;

  // Verify kill was called immediately
  assert.ok(proc.kill.mock.callCount() >= 1);
});

test('spawnCli handles empty stdout', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [] }, { spawnFn }));

  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);
  const results = await promise;

  assert.equal(results.length, 0);
});

// === New tests for 缅因猫 review findings ===

test('spawnCli yields __cliError on non-zero exit code >= 2 (stderr sanitized)', async () => {
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [] }, { spawnFn }));

  proc.stdout.write('{"type":"partial"}\n');
  proc.stderr.write('Error: something went wrong\n');
  proc.stdout.end();
  // Exit code 2 is always a hard error (not soft-exited)
  proc._emitter.emit('exit', 2, null);

  const results = await promise;

  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { type: 'partial' });

  // Second result should be the CLI error with sanitized message
  assert.equal(isCliError(results[1]), true);
  assert.equal(results[1].exitCode, 2);
  assert.equal(results[1].command, 'test-cli');
  assert.ok(results[1].message.includes('code: 2'));
  assert.ok(!results[1].stderr, 'stderr should not be exposed to users');
});

test('spawnCli yields __cliError for exit code 1 even with valid output (no soft exit in spawnCli)', async () => {
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'codex', args: ['exec'] }, { spawnFn }));

  // spawnCli always reports non-zero exit as error — soft exit handling
  // is the caller's responsibility (e.g. CodexAgentService)
  proc.stdout.write('{"type":"review","text":"NEEDS_FIX"}\n');
  proc.stdout.end();
  proc._emitter.emit('exit', 1, null);

  const results = await promise;

  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { type: 'review', text: 'NEEDS_FIX' });
  assert.equal(isCliError(results[1]), true);
  assert.equal(results[1].exitCode, 1);
});

test('spawnCli yields __cliError when killed by external signal (stderr sanitized)', async () => {
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [] }, { spawnFn }));

  proc.stderr.write('Killed by OOM\n');
  proc.stdout.end();
  // External signal kill: exitCode=null, signal=SIGKILL
  proc._emitter.emit('exit', null, 'SIGKILL');

  const results = await promise;

  assert.equal(results.length, 1);
  assert.equal(isCliError(results[0]), true);
  assert.equal(results[0].exitCode, null);
  assert.equal(results[0].signal, 'SIGKILL');
  assert.equal(results[0].command, 'test-cli');
  // message is sanitized — no raw stderr exposed (contains signal info, not raw stderr)
  assert.ok(results[0].message.includes('SIGKILL'));
  assert.ok(!results[0].stderr, 'stderr should not be exposed to users');
});

test('spawnCli yields __cliTimeout (not __cliError) on timeout kill', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [], timeoutMs: 50 }, { spawnFn }));

  // Let timeout fire and kill the process
  await new Promise((resolve) => setTimeout(resolve, 100));
  proc.stdout.end();

  const results = await promise;

  // Should NOT contain a __cliError (we killed it via timeout)
  const hasCliError = results.some((r) => isCliError(r));
  assert.equal(hasCliError, false);

  // Should contain a __cliTimeout instead
  const hasTimeout = results.some((r) => isCliTimeout(r));
  assert.equal(hasTimeout, true);

  const timeout = results.find((r) => isCliTimeout(r));
  assert.equal(timeout.timeoutMs, 50);
  assert.equal(timeout.command, 'test-cli');
});

test('isCliError type guard works correctly', () => {
  assert.equal(isCliError({ __cliError: true, exitCode: 1, message: 'CLI 异常退出', command: 'x' }), true);
  assert.equal(isCliError({ __cliError: false }), false);
  assert.equal(isCliError({ type: 'message' }), false);
  assert.equal(isCliError(null), false);
  assert.equal(isCliError('string'), false);
});

test('isCliTimeout type guard works correctly', () => {
  assert.equal(isCliTimeout({ __cliTimeout: true, timeoutMs: 300000, message: 'CLI 响应超时', command: 'x' }), true);
  assert.equal(isCliTimeout({ __cliTimeout: false }), false);
  assert.equal(isCliTimeout({ __cliError: true }), false);
  assert.equal(isCliTimeout(null), false);
  assert.equal(isCliTimeout('string'), false);
});

test('AbortSignal cancel does NOT yield __cliTimeout', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);
  const controller = new AbortController();

  const promise = collect(spawnCli({ command: 'test-cli', args: [], signal: controller.signal }, { spawnFn }));

  // Cancel via AbortSignal (not timeout)
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 50));
  proc.stdout.end();

  const results = await promise;

  const hasTimeout = results.some((r) => isCliTimeout(r));
  assert.equal(hasTimeout, false, 'User cancel should not yield __cliTimeout');
  const hasCliError = results.some((r) => isCliError(r));
  assert.equal(hasCliError, false, 'User cancel should not yield __cliError');
});

test('spawnCli escalates SIGTERM to SIGKILL after grace period', async () => {
  // Create a stubborn process that does NOT exit on SIGTERM
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'stubborn-cli', args: [], timeoutMs: 50 }, { spawnFn }));

  // Wait for timeout to fire SIGTERM
  await new Promise((resolve) => setTimeout(resolve, 100));

  // First kill should be SIGTERM
  assert.ok(proc.kill.mock.callCount() >= 1);
  assert.equal(proc.kill.mock.calls[0].arguments[0], 'SIGTERM');

  // Wait for KILL_GRACE_MS to elapse for escalation
  await new Promise((resolve) => setTimeout(resolve, KILL_GRACE_MS + 100));

  // Should have escalated to SIGKILL
  const killCalls = proc.kill.mock.calls;
  const signals = killCalls.map((c) => c.arguments[0]);
  assert.ok(signals.includes('SIGKILL'), `Expected SIGKILL in signals: ${signals}`);

  // Now actually exit the process so the generator resolves
  proc.stdout.end();
  proc._emitter.emit('exit', null, 'SIGKILL');

  await promise;
});

// === F118: Timeout diagnostic enrichment ===

test('timeout event includes firstEventAt/lastEventAt/lastEventType when events were received', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'codex', args: [], timeoutMs: 50 }, { spawnFn }));

  // Feed one event then go silent
  proc.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'abc' }) + '\n');

  // Wait for timeout
  // End before silence exceeds the soft threshold: this test verifies that
  // stderr activity resets probe silence, not that a later real quiet period
  // suppresses warnings forever.
  await new Promise((r) => setTimeout(r, 50));
  proc.stdout.end();

  const results = await promise;
  const timeout = results.find(isCliTimeout);
  assert.ok(timeout, 'should have timeout event');
  assert.equal(typeof timeout.firstEventAt, 'number');
  assert.equal(typeof timeout.lastEventAt, 'number');
  assert.equal(timeout.firstEventAt, timeout.lastEventAt, 'only one event — first === last');
  assert.equal(timeout.lastEventType, 'thread.started');
  assert.equal(typeof timeout.silenceDurationMs, 'number');
  assert.ok(timeout.silenceDurationMs >= 40, 'silence should be at least ~timeout ms');
  assert.equal(typeof timeout.processAlive, 'boolean');
});

test('timeout with no events has null firstEventAt/lastEventAt/lastEventType', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'codex', args: [], timeoutMs: 50 }, { spawnFn }));

  // No events — just wait for timeout
  await new Promise((r) => setTimeout(r, 100));
  proc.stdout.end();

  const results = await promise;
  const timeout = results.find(isCliTimeout);
  assert.ok(timeout);
  assert.equal(timeout.firstEventAt, null);
  assert.equal(timeout.lastEventAt, null);
  assert.equal(timeout.lastEventType, null);
  assert.equal(timeout.silenceDurationMs, timeout.timeoutMs, 'silence = full timeout when no events');
});

test('timeout includes invocationId and cliSessionId when passed in options', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: [],
        timeoutMs: 50,
        invocationId: 'inv-123',
        cliSessionId: 'sess-456',
      },
      { spawnFn },
    ),
  );

  await new Promise((r) => setTimeout(r, 100));
  proc.stdout.end();

  const results = await promise;
  const timeout = results.find(isCliTimeout);
  assert.ok(timeout);
  assert.equal(timeout.invocationId, 'inv-123');
  assert.equal(timeout.cliSessionId, 'sess-456');
});

test('P1-fix: processAlive reflects state at timeout moment, not after kill', async () => {
  // Process is alive when timeout fires (hasn't exited on its own)
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  proc.stdout.write(JSON.stringify({ type: 'init' }) + '\n');

  const promise = collect(spawnCli({ command: 'codex', args: [], timeoutMs: 50 }, { spawnFn }));

  await new Promise((r) => setTimeout(r, 100));
  // Don't manually end stdout — let timeout kill handle it

  const results = await promise;
  const timeout = results.find(isCliTimeout);
  assert.ok(timeout, 'should have timeout event');
  // Process was alive when timeout fired (it hadn't exited on its own)
  assert.equal(timeout.processAlive, true, 'process should be alive at timeout moment');
});

test('timeout omits invocationId/cliSessionId when not provided', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(spawnCli({ command: 'test-cli', args: [], timeoutMs: 50 }, { spawnFn }));

  await new Promise((r) => setTimeout(r, 100));
  proc.stdout.end();

  const results = await promise;
  const timeout = results.find(isCliTimeout);
  assert.ok(timeout);
  assert.equal(timeout.invocationId, undefined);
  assert.equal(timeout.cliSessionId, undefined);
});

// === F118 Phase B: Liveness probe integration ===

test('B4: yields alive_but_silent warning during CLI silence', async () => {
  const proc = createMockProcess({ pid: process.pid });
  const spawnFn = createMockSpawnFn(proc);

  proc.stdout.write(JSON.stringify({ type: 'init' }) + '\n');

  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: [],
        timeoutMs: 500,
        livenessProbe: { sampleIntervalMs: 30, softWarningMs: 80, stallWarningMs: 300 },
      },
      { spawnFn },
    ),
  );

  await new Promise((r) => setTimeout(r, 600));
  proc.stdout.end();

  const results = await promise;
  const warnings = results.filter((e) => e?.__livenessWarning);
  assert.ok(warnings.length > 0, 'should have liveness warnings');
  assert.ok(warnings.some((w) => w.level === 'alive_but_silent'));
});

test('B3: dead process triggers immediate cleanup via probe', async () => {
  // Use a PID that doesn't exist — probe should classify as dead
  const proc = createMockProcess({ exitOnKill: false, pid: 99999 });
  const spawnFn = createMockSpawnFn(proc);

  proc.stdout.write(JSON.stringify({ type: 'init' }) + '\n');

  const startMs = Date.now();
  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: [],
        timeoutMs: 5000,
        livenessProbe: { sampleIntervalMs: 30 },
      },
      { spawnFn },
    ),
  );

  // Give probe time to detect dead process
  await new Promise((r) => setTimeout(r, 200));
  proc.stdout.end();
  proc._emitter.emit('exit', 1, null);

  await promise;
  const elapsedMs = Date.now() - startMs;
  assert.ok(elapsedMs < 2000, `should finish quickly (${elapsedMs}ms), not wait for 5s timeout`);
});

test('timeout includes rawArchivePath when passed in options', async () => {
  const proc = createMockProcess();
  const spawnFn = createMockSpawnFn(proc);

  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: [],
        timeoutMs: 50,
        rawArchivePath: '/data/cli-raw-archive/2026-03-14/inv-123.ndjson',
      },
      { spawnFn },
    ),
  );

  await new Promise((r) => setTimeout(r, 100));
  proc.stdout.end();

  const results = await promise;
  const timeout = results.find(isCliTimeout);
  assert.ok(timeout);
  assert.equal(timeout.rawArchivePath, '/data/cli-raw-archive/2026-03-14/inv-123.ndjson');
});

test('P1-fix: probe race timer is cleaned up when NDJSON wins', async () => {
  const proc = createMockProcess({ pid: process.pid });
  const spawnFn = createMockSpawnFn(proc);

  let clearCount = 0;
  const origClearTimeout = global.clearTimeout;
  global.clearTimeout = (timer) => {
    clearCount++;
    return origClearTimeout(timer);
  };

  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: [],
        timeoutMs: 5000,
        livenessProbe: { sampleIntervalMs: 200 },
      },
      { spawnFn },
    ),
  );

  // Rapid-fire 10 events — each should win the race and clear the timer
  for (let i = 0; i < 10; i++) {
    proc.stdout.write(JSON.stringify({ type: 'msg', i }) + '\n');
    await new Promise((r) => setTimeout(r, 5));
  }
  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);
  await promise;

  global.clearTimeout = origClearTimeout;
  // Each NDJSON event that wins the race should clearTimeout the probe timer
  assert.ok(clearCount >= 10, `clearTimeout should be called at least 10 times, got ${clearCount}`);
});

test('P2-fix: stderr activity notifies probe (no false silent warning)', async () => {
  const proc = createMockProcess({ pid: process.pid });
  const spawnFn = createMockSpawnFn(proc);

  proc.stdout.write(JSON.stringify({ type: 'init' }) + '\n');

  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: [],
        timeoutMs: 500,
        livenessProbe: { sampleIntervalMs: 30, softWarningMs: 80, stallWarningMs: 300 },
      },
      { spawnFn },
    ),
  );

  // Keep stderr active but stdout silent — should reset probe silence
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 40));
    proc.stderr.write(`thinking step ${i}...\n`);
  }

  await new Promise((r) => setTimeout(r, 100));
  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);

  const results = await promise;
  const warnings = results.filter((e) => e?.__livenessWarning);
  const silentWarnings = warnings.filter((w) => w.level === 'alive_but_silent');
  assert.equal(silentWarnings.length, 0, 'stderr activity should prevent alive_but_silent warnings');
});

test('spawnCli handles spawn error (e.g. command not found)', async () => {
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const gen = spawnCli({ command: 'nonexistent-command', args: [] }, { spawnFn });

  // Emit error before any stdout data
  process.nextTick(() => {
    const err = new Error('spawn nonexistent-command ENOENT');
    err.code = 'ENOENT';
    proc._emitter.emit('error', err);
    proc.stdout.end();
    proc._emitter.emit('exit', null, null);
  });

  await assert.rejects(
    async () => {
      for await (const _ of gen) {
        /* consume */
      }
    },
    (err) => {
      assert.ok(err.message.includes('ENOENT'));
      return true;
    },
  );
});

// F118 Phase C: isLivenessWarning type guard
test('isLivenessWarning returns true for valid warning events', () => {
  const warning = {
    __livenessWarning: true,
    state: 'busy-silent',
    silenceDurationMs: 125000,
    level: 'alive_but_silent',
    processAlive: true,
  };
  assert.ok(isLivenessWarning(warning));
});

test('isLivenessWarning returns false for non-warning objects', () => {
  assert.ok(!isLivenessWarning({ type: 'text', content: 'hello' }));
  assert.ok(!isLivenessWarning(null));
  assert.ok(!isLivenessWarning(42));
  assert.ok(!isLivenessWarning({ __livenessWarning: false }));
});

// === Issue #116: Semantic completion decoupled from process exit ===

test('Group A: semanticCompletionSignal aborted → generator finishes without waiting for exit', async () => {
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const semanticController = new AbortController();

  const startMs = Date.now();
  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: ['exec', '--json'],
        timeoutMs: 10_000,
        semanticCompletionSignal: semanticController.signal,
      },
      { spawnFn },
    ),
  );

  proc.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't1' }) + '\n');
  proc.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100 } }) + '\n');

  semanticController.abort();
  proc.stdout.end();

  // Simulate process exiting naturally during grace period (e.g. git push finishes)
  setTimeout(() => proc._emitter.emit('exit', 0, null), 200);

  const results = await promise;
  const elapsedMs = Date.now() - startMs;

  // Should finish after process exits (~200ms), not wait for full timeout (10s)
  assert.ok(elapsedMs < 2000, `Should finish once process exits during grace, took ${elapsedMs}ms`);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { type: 'thread.started', thread_id: 't1' });
  assert.deepEqual(results[1], { type: 'turn.completed', usage: { input_tokens: 100 } });
});

test('Group A: semanticCompletionSignal skips __cliError for post-completion exit', async () => {
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const semanticController = new AbortController();

  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: ['exec'],
        semanticCompletionSignal: semanticController.signal,
      },
      { spawnFn },
    ),
  );

  proc.stdout.write(JSON.stringify({ type: 'item.completed', text: 'hello' }) + '\n');
  semanticController.abort();
  proc.stdout.end();

  // Process exits with non-zero during grace (Codex CLI quirk)
  setTimeout(() => proc._emitter.emit('exit', 1, null), 100);

  const results = await promise;

  const hasCliError = results.some((r) => isCliError(r));
  assert.equal(hasCliError, false, 'Post-semantic-completion exit error should be suppressed');

  assert.equal(results.length, 1);
  assert.deepEqual(results[0], { type: 'item.completed', text: 'hello' });
});

test('Group B: no semanticCompletionSignal → generator waits for exit (existing behavior)', async () => {
  const proc = createMockProcess({ exitOnKill: true });
  const spawnFn = createMockSpawnFn(proc);

  const startMs = Date.now();
  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: ['exec'],
        timeoutMs: 200,
      },
      { spawnFn },
    ),
  );

  proc.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't1' }) + '\n');
  proc.stdout.end();

  const results = await promise;
  const elapsedMs = Date.now() - startMs;

  assert.ok(elapsedMs >= 150, `Should wait for timeout (~200ms), only took ${elapsedMs}ms`);
  const hasTimeout = results.some((r) => isCliTimeout(r));
  assert.equal(hasTimeout, true, 'Without semanticCompletionSignal, should wait for exit and eventually timeout');
});

test('Group B: semanticCompletionSignal not aborted → still waits for exit', async () => {
  const proc = createMockProcess({ exitOnKill: true });
  const spawnFn = createMockSpawnFn(proc);

  const semanticController = new AbortController();

  const startMs = Date.now();
  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: ['exec'],
        timeoutMs: 200,
        semanticCompletionSignal: semanticController.signal,
      },
      { spawnFn },
    ),
  );

  proc.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 't1' }) + '\n');
  proc.stdout.end();

  const results = await promise;
  const elapsedMs = Date.now() - startMs;

  assert.ok(elapsedMs >= 150, `Should wait for timeout (~200ms), only took ${elapsedMs}ms`);
  const hasTimeout = results.some((r) => isCliTimeout(r));
  assert.equal(hasTimeout, true, 'Un-aborted semanticCompletionSignal should behave like no signal');
});

test('Group A: lingering process is killed after grace period expires', async () => {
  const proc = createMockProcess({ exitOnKill: false });
  const spawnFn = createMockSpawnFn(proc);

  const semanticController = new AbortController();

  const promise = collect(
    spawnCli(
      {
        command: 'codex',
        args: ['exec'],
        timeoutMs: 60_000,
        semanticCompletionSignal: semanticController.signal,
      },
      { spawnFn },
    ),
  );

  proc.stdout.write(JSON.stringify({ type: 'turn.completed' }) + '\n');
  semanticController.abort();
  proc.stdout.end();

  // Process never exits — grace timer (SEMANTIC_COMPLETION_GRACE_MS) should expire,
  // then killChild() in finally should fire SIGTERM.
  // Emit exit after kill so generator can resolve.
  const exitAfterKill = () => {
    if (proc.kill.mock.callCount() > 0) {
      proc._emitter.emit('exit', null, 'SIGTERM');
    } else {
      setTimeout(exitAfterKill, 50);
    }
  };
  setTimeout(exitAfterKill, 100);

  const startMs = Date.now();
  await promise;
  const elapsedMs = Date.now() - startMs;

  assert.ok(proc.kill.mock.callCount() >= 1, 'Should kill lingering process after grace');
  assert.equal(proc.kill.mock.calls[0].arguments[0], 'SIGTERM');
  assert.ok(
    elapsedMs >= SEMANTIC_COMPLETION_GRACE_MS - 500,
    `Should wait for grace period (~${SEMANTIC_COMPLETION_GRACE_MS}ms), took ${elapsedMs}ms`,
  );
});
