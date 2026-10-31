/**
 * F118/F212 hotfix — provider-scoped graceful stall termination.
 *
 * These tests stay at spawnCli's public boundary so the lifecycle controller
 * cannot pass while its orchestration wiring is broken.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mock, test } from 'node:test';

const { buildCliTimeoutTelemetryAttributes, spawnCli } = await import('../dist/utils/cli-spawn.js');
const { CliTerminationController } = await import('../dist/utils/CliTerminationController.js');
const { ProcessLivenessProbe } = await import('../dist/utils/ProcessLivenessProbe.js');

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function createMockProcess({ exitOnSignal } = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const emitter = new EventEmitter();
  const originalEmit = emitter.emit.bind(emitter);
  emitter.emit = (event, ...args) => {
    const emitted = originalEmit(event, ...args);
    if (event === 'exit') process.nextTick(() => originalEmit('close', ...args));
    return emitted;
  };

  const proc = {
    stdout,
    stderr,
    stdin: null,
    pid: 12345,
    kill: mock.fn((signal = 'SIGTERM') => {
      if (exitOnSignal?.(signal)) {
        process.nextTick(() => {
          if (!stdout.destroyed) stdout.end();
          emitter.emit('exit', 0, null);
        });
      }
      return true;
    }),
    on(event, listener) {
      emitter.on(event, listener);
      return proc;
    },
    once(event, listener) {
      emitter.once(event, listener);
      return proc;
    },
    _emitter: emitter,
  };
  return proc;
}

function mockOneStall(t, silenceDurationMs = 421_234) {
  const warning = {
    __livenessWarning: true,
    state: 'idle-silent',
    silenceDurationMs,
    level: 'suspected_stall',
    cpuTimeMs: 300,
    processAlive: true,
  };
  let drains = 0;
  t.mock.method(ProcessLivenessProbe.prototype, 'start', () => {});
  t.mock.method(ProcessLivenessProbe.prototype, 'getState', () => 'idle-silent');
  t.mock.method(ProcessLivenessProbe.prototype, 'drainWarnings', () => {
    drains += 1;
    return drains === 2 ? [warning] : [];
  });
  t.mock.method(ProcessLivenessProbe.prototype, 'flushPendingWarnings', async () => {});
}

function stallOptions(mode) {
  return {
    command: 'codex',
    args: [],
    timeoutMs: 10_000,
    invocationId: 'inv-graceful-stall',
    livenessProbe: {
      sampleIntervalMs: 5,
      softWarningMs: 10,
      stallWarningMs: 420_000,
      stallAutoKill: true,
      stallTerminationMode: mode,
    },
  };
}

test('interrupt-first stall exits during grace without SIGTERM/SIGKILL', async (t) => {
  mockOneStall(t);
  const proc = createMockProcess({ exitOnSignal: (signal) => signal === 'SIGINT' });

  const items = await collect(
    spawnCli(stallOptions('interrupt-first'), {
      spawnFn: () => proc,
      terminationGraces: { interruptMs: 10, terminateMs: 10 },
    }),
  );

  assert.deepEqual(
    proc.kill.mock.calls.map((call) => call.arguments[0]),
    ['SIGINT'],
  );
  const timeout = items.find((item) => item?.__cliTimeout);
  assert.ok(timeout, 'stall must still yield a timeout terminal envelope');
  assert.equal(timeout.cliDiagnostics.reasonCode, 'cli_stall_timeout');
  assert.equal(timeout.terminalContext.observedSilenceDurationMs, 421_234);
  assert.deepEqual(timeout.terminalContext.signalsSent, ['SIGINT']);
});

test('interrupt-first stall escalates stubborn child in one bounded sequence', async (t) => {
  mockOneStall(t, 422_000);
  const proc = createMockProcess({ exitOnSignal: () => false });
  const resultPromise = collect(
    spawnCli(stallOptions('interrupt-first'), {
      spawnFn: () => proc,
      terminationGraces: { interruptMs: 10, terminateMs: 10 },
    }),
  );

  const deadline = Date.now() + 500;
  while (proc.kill.mock.calls.length < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const signals = proc.kill.mock.calls.map((call) => call.arguments[0]);
  proc.stdout.end();
  proc._emitter.emit('exit', null, 'SIGKILL');
  const items = await resultPromise;

  assert.deepEqual(signals, ['SIGINT', 'SIGTERM', 'SIGKILL']);
  const timeout = items.find((item) => item?.__cliTimeout);
  assert.deepEqual(timeout.terminalContext.signalsSent, signals);
  assert.equal(timeout.terminalContext.finalStage, 'kill');
});

test('terminate-first remains the default stall policy for non-Codex callers', async (t) => {
  mockOneStall(t);
  const proc = createMockProcess({ exitOnSignal: (signal) => signal === 'SIGTERM' });
  const options = stallOptions(undefined);
  delete options.livenessProbe.stallTerminationMode;

  await collect(
    spawnCli(options, {
      spawnFn: () => proc,
      terminationGraces: { interruptMs: 10, terminateMs: 10 },
    }),
  );

  assert.equal(proc.kill.mock.calls[0].arguments[0], 'SIGTERM');
  assert.equal(
    proc.kill.mock.calls.some((call) => call.arguments[0] === 'SIGINT'),
    false,
  );
});

test('warning queue drain cadence stays independent from the 60s CPU sample interval', async (t) => {
  mockOneStall(t);
  const proc = createMockProcess({ exitOnSignal: (signal) => signal === 'SIGTERM' });
  const options = stallOptions(undefined);
  options.livenessProbe.sampleIntervalMs = 60_000;
  delete options.livenessProbe.stallTerminationMode;

  const startedAt = Date.now();
  await collect(
    spawnCli(options, {
      spawnFn: () => proc,
      terminationGraces: { interruptMs: 10, terminateMs: 10 },
      livenessWarningDrainIntervalMs: 5,
    }),
  );

  assert.ok(Date.now() - startedAt < 500, 'warning drain must not wait for the next CPU sample');
});

test('termination controller makes duplicate requests idempotent and cancels escalation on exit', async () => {
  const child = { kill: mock.fn(() => true) };
  let exited = false;
  const controller = new CliTerminationController({
    child,
    isChildExited: () => exited,
    graces: { interruptMs: 10, terminateMs: 10 },
  });

  assert.equal(controller.request('interrupt-first'), true);
  assert.equal(controller.request('interrupt-first'), false);
  exited = true;
  controller.markExited();
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.deepEqual(
    child.kill.mock.calls.map((call) => call.arguments[0]),
    ['SIGINT'],
  );
  assert.equal(controller.getState(), 'exited');
});

test('timeout telemetry is verdict-ready and contains no command arguments or credentials', () => {
  const attributes = buildCliTimeoutTelemetryAttributes({
    kind: 'stall_timeout',
    configuredTimeoutMs: 420_000,
    observedSilenceDurationMs: 421_234,
    processAliveAtTimeout: true,
    postKillExitCode: 0,
    postKillSignal: null,
    signalsSent: ['SIGINT'],
    finalStage: 'interrupt',
  });

  assert.deepEqual(attributes, {
    'cli.reason_code': 'cli_stall_timeout',
    'cli.timeout_reason': 'stall_timeout',
    'cli.timeout_ms': 420_000,
    'cli.silence_ms': 421_234,
    'cli.process_alive_at_timeout': true,
    'cli.first_termination_stage': 'interrupt',
    'cli.termination_stage': 'interrupt',
    'cli.termination_signals': 'SIGINT',
  });
  const serialized = JSON.stringify(attributes);
  assert.doesNotMatch(serialized, /argv|prompt|callback|token|credential/i);
});

test('a later stall warning cannot overwrite an already committed response timeout', async (t) => {
  mockOneStall(t, 421_000);
  const proc = createMockProcess({ exitOnSignal: () => false });
  const options = stallOptions('interrupt-first');
  options.timeoutMs = 5;

  const resultPromise = collect(
    spawnCli(options, {
      spawnFn: () => proc,
      terminationGraces: { interruptMs: 100, terminateMs: 100 },
      livenessWarningDrainIntervalMs: 10,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 40));
  proc.stdout.end();
  proc._emitter.emit('exit', 0, null);
  const items = await resultPromise;

  const timeout = items.find((item) => item?.__cliTimeout);
  assert.equal(timeout.terminalContext.kind, 'response_timeout');
  assert.equal(timeout.cliDiagnostics.reasonCode, 'cli_response_timeout');
  assert.equal(timeout.stallKill, undefined);
  assert.equal(proc.kill.mock.calls[0].arguments[0], 'SIGTERM');
});

test('timeout returns after bounded escalation even when the child never closes stdout', async () => {
  const proc = createMockProcess({ exitOnSignal: () => false });
  const collectPromise = collect(
    spawnCli(
      { command: 'codex', args: [], timeoutMs: 5, invocationId: 'inv-never-closes' },
      {
        spawnFn: () => proc,
        terminationGraces: { interruptMs: 10, terminateMs: 10 },
      },
    ),
  );

  const outcome = await Promise.race([
    collectPromise.then((items) => ({ items })),
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 200)),
  ]);

  assert.notEqual(outcome.timedOut, true, 'spawnCli must not depend on stdout close after final escalation');
  assert.deepEqual(
    proc.kill.mock.calls.map((call) => call.arguments[0]),
    ['SIGTERM', 'SIGKILL'],
  );
  assert.equal(outcome.items.find((item) => item?.__cliTimeout).cliDiagnostics.reasonCode, 'cli_response_timeout');
});
