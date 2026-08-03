/** F212 post-close hotfix — timeout envelopes must carry one causal truth. */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

const { buildCliDiagnostics } = await import('../dist/utils/cli-diagnostics.js');
const { spawnCli } = await import('../dist/utils/cli-spawn.js');

async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

function createExitZeroOnTerminateProcess() {
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
    kill() {
      process.nextTick(() => {
        stdout.end();
        emitter.emit('exit', 0, null);
      });
      return true;
    },
    on(event, listener) {
      emitter.on(event, listener);
      return proc;
    },
    once(event, listener) {
      emitter.once(event, listener);
      return proc;
    },
  };
  return proc;
}

test('terminalContext forces stall timeout diagnostics and omits post-kill exit from public debugRef', () => {
  const diagnostics = buildCliDiagnostics({
    rawText: '',
    stderrEmpty: true,
    debugRef: { command: 'codex', signal: null, invocationId: 'inv-stall' },
    terminalContext: {
      kind: 'stall_timeout',
      configuredTimeoutMs: 420_000,
      observedSilenceDurationMs: 540_039,
      processAliveAtTimeout: true,
      postKillExitCode: 0,
      postKillSignal: null,
      signalsSent: ['SIGINT'],
      finalStage: 'interrupt',
    },
  });

  assert.equal(diagnostics.reasonCode, 'cli_stall_timeout');
  assert.doesNotMatch(diagnostics.publicSummary, /未识别|CLI 已退出/);
  assert.doesNotMatch(diagnostics.publicHint, /未识别|CLI 已退出/);
  assert.equal(Object.hasOwn(diagnostics.debugRef, 'exitCode'), false);
});

test('terminalContext distinguishes response timeout from stall timeout', () => {
  const diagnostics = buildCliDiagnostics({
    rawText: '',
    stderrEmpty: true,
    debugRef: { command: 'codex', signal: null },
    terminalContext: {
      kind: 'response_timeout',
      configuredTimeoutMs: 30_000,
      observedSilenceDurationMs: 30_005,
      processAliveAtTimeout: true,
      postKillExitCode: null,
      postKillSignal: 'SIGTERM',
      signalsSent: ['SIGTERM'],
      finalStage: 'terminate',
    },
  });

  assert.equal(diagnostics.reasonCode, 'cli_response_timeout');
  assert.notEqual(diagnostics.reasonCode, 'cli_stall_timeout');
});

test('__cliTimeout snapshots cause before kill and keeps exit=0 in terminalContext only', async () => {
  const proc = createExitZeroOnTerminateProcess();
  const diagnosticCalls = [];
  const items = await collect(
    spawnCli(
      {
        command: 'codex',
        args: ['--secret-prompt', 'callbackToken=must-not-log'],
        timeoutMs: 15,
        invocationId: 'inv-response-timeout',
        diagnosticLogger: {
          error(payload, message) {
            diagnosticCalls.push({ payload, message });
          },
        },
      },
      { spawnFn: () => proc, terminationGraces: { interruptMs: 5, terminateMs: 5 } },
    ),
  );

  const timeout = items.find((item) => item?.__cliTimeout);
  assert.ok(timeout);
  assert.equal(timeout.cliDiagnostics.reasonCode, 'cli_response_timeout');
  assert.equal(Object.hasOwn(timeout.cliDiagnostics.debugRef, 'exitCode'), false);
  assert.equal(timeout.terminalContext.kind, 'response_timeout');
  assert.equal(timeout.terminalContext.configuredTimeoutMs, 15);
  const minimumObservedSilenceMs = timeout.terminalContext.configuredTimeoutMs - 5;
  assert.ok(
    timeout.terminalContext.observedSilenceDurationMs >= minimumObservedSilenceMs,
    `millisecond clock granularity may report slightly below the configured timeout: ${timeout.terminalContext.observedSilenceDurationMs}ms`,
  );
  assert.equal(timeout.terminalContext.processAliveAtTimeout, true);
  assert.equal(timeout.terminalContext.postKillExitCode, 0);
  const timeoutLog = diagnosticCalls.find((call) => call.message === 'CLI timeout');
  assert.ok(timeoutLog);
  assert.equal(timeoutLog.payload.reasonCode, 'cli_response_timeout');
  assert.equal(timeoutLog.payload.observedSilenceDurationMs >= minimumObservedSilenceMs, true);
  assert.deepEqual(timeoutLog.payload.signalsSent, ['SIGTERM']);
  assert.doesNotMatch(JSON.stringify(timeoutLog), /secret-prompt|callbackToken|must-not-log/);
});
