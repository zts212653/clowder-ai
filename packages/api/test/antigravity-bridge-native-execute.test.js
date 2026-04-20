import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, mock, test } from 'node:test';
import { AntigravityBridge } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityBridge.js';
import { AuditLogger } from '../dist/domains/cats/services/agents/providers/antigravity/executors/AuditLogger.js';
import { ExecutorRegistry } from '../dist/domains/cats/services/agents/providers/antigravity/executors/ExecutorRegistry.js';
import { RunCommandExecutor } from '../dist/domains/cats/services/agents/providers/antigravity/executors/RunCommandExecutor.js';

function tempStorePath() {
  return path.join(os.tmpdir(), `antigravity-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function makeStep({
  status = 'CORTEX_STEP_STATUS_WAITING',
  commandLine = 'echo probe',
  stepIndex = 0,
  trajectoryId = 't1',
} = {}) {
  return {
    type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
    status,
    metadata: {
      toolCall: {
        id: 'toolu_1',
        name: 'run_command',
        argumentsJson: JSON.stringify({ CommandLine: commandLine, Cwd: '/tmp', SafeToAutoRun: true }),
      },
      sourceTrajectoryStepInfo: { trajectoryId, stepIndex, cascadeId: 'c1' },
    },
  };
}

describe('AntigravityBridge.nativeExecuteAndPush', () => {
  const cleanupPaths = [];
  const cleanupDirs = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
    for (const d of cleanupDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {}
    }
    cleanupPaths.length = 0;
    cleanupDirs.length = 0;
  });

  function makeBridge() {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-audit-'));
    cleanupDirs.push(logDir);
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 't', useTls: false },
      { sessionStorePath: storePath },
    );
    mock.method(bridge, 'ensureConnected', async () => ({ port: 1234, csrfToken: 't', useTls: false }));
    const rpcMock = mock.fn(async () => ({ stdout: 'probe\n', stderr: '', exitCode: 0 }));
    Object.getPrototypeOf(bridge).rpc = rpcMock;
    mock.method(bridge, 'sendMessage', async () => 1);
    const registry = new ExecutorRegistry();
    const audit = new AuditLogger(logDir);
    registry.register(new RunCommandExecutor({ rpc: rpcMock }));
    bridge.attachExecutors(registry, audit);
    return { bridge, rpcMock, audit, logDir };
  }

  test('executes WAITING RUN_COMMAND step and pushes result', async () => {
    const { bridge, rpcMock } = makeBridge();
    const step = makeStep({ commandLine: 'echo probe' });
    const handled = await bridge.nativeExecuteAndPush(step, {
      cascadeId: 'c1',
      cwd: '/tmp',
      modelName: 'claude-opus-4-6',
    });
    assert.equal(handled, true);
    // rpcMock receives both executor calls (2-arg: method, payload) and bridge calls
    // (3-arg: conn, method, payload). Extract method from whichever position is a string.
    const methods = rpcMock.mock.calls.map((c) => {
      const args = c.arguments;
      return typeof args[0] === 'string' ? args[0] : args[1];
    });
    assert.ok(methods.includes('RunCommand'), `expected RunCommand call, got ${methods.join(',')}`);
    assert.ok(methods.includes('CancelCascadeSteps'), `expected CancelCascadeSteps call, got ${methods.join(',')}`);
    assert.equal(bridge.sendMessage.mock.callCount(), 1);
    const [cascadeIdArg, textArg, modelArg] = bridge.sendMessage.mock.calls[0].arguments;
    assert.equal(cascadeIdArg, 'c1');
    assert.match(textArg, /\[native-executor result for: echo probe\]/);
    assert.equal(modelArg, 'claude-opus-4-6', 'tool-result writeback must preserve the requested model');
  });

  test('skips non-WAITING steps', async () => {
    const { bridge, rpcMock } = makeBridge();
    const step = makeStep({ status: 'CORTEX_STEP_STATUS_DONE' });
    const handled = await bridge.nativeExecuteAndPush(step, { cascadeId: 'c1', cwd: '/tmp' });
    assert.equal(handled, false);
    assert.equal(rpcMock.mock.callCount(), 0);
  });

  test('skips non-run_command steps', async () => {
    const { bridge, rpcMock } = makeBridge();
    const step = {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: { toolCall: { name: 'read_file', argumentsJson: '{}' } },
    };
    const handled = await bridge.nativeExecuteAndPush(step, { cascadeId: 'c1', cwd: '/tmp' });
    assert.equal(handled, false);
    assert.equal(rpcMock.mock.callCount(), 0);
  });

  test('skips when executor not attached', async () => {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 't', useTls: false },
      { sessionStorePath: storePath },
    );
    const step = makeStep();
    const handled = await bridge.nativeExecuteAndPush(step, { cascadeId: 'c1', cwd: '/tmp' });
    assert.equal(handled, false);
  });

  test('returns false when sourceTrajectoryStepInfo is missing — refuses to default stepIndex to 0', async () => {
    const { bridge, rpcMock } = makeBridge();
    const step = {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      status: 'CORTEX_STEP_STATUS_WAITING',
      metadata: {
        toolCall: {
          id: 'toolu_no_step_info',
          name: 'run_command',
          argumentsJson: JSON.stringify({ CommandLine: 'echo danger', Cwd: '/tmp' }),
        },
      },
    };
    const handled = await bridge.nativeExecuteAndPush(step, { cascadeId: 'c1', cwd: '/tmp' });
    assert.equal(handled, false, 'must not execute when stepIndex is unknown — would cancel wrong step');
    const cancelCalls = rpcMock.mock.calls.filter((c) => {
      const args = c.arguments;
      const method = typeof args[0] === 'string' ? args[0] : args[1];
      return method === 'CancelCascadeSteps';
    });
    assert.equal(cancelCalls.length, 0, 'must not call CancelCascadeSteps without valid stepIndex');
  });

  test('returns false when SafeToAutoRun is not true (respects Antigravity approval metadata)', async () => {
    const { bridge, rpcMock } = makeBridge();
    const variants = [
      { CommandLine: 'echo hi', Cwd: '/tmp', SafeToAutoRun: false },
      { CommandLine: 'echo hi', Cwd: '/tmp' }, // missing flag
      { CommandLine: 'echo hi', Cwd: '/tmp', SafeToAutoRun: 'true' }, // string, not bool
      { CommandLine: 'echo hi', Cwd: '/tmp', SafeToAutoRun: 1 }, // number, not bool
    ];
    for (const args of variants) {
      const step = {
        type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
        status: 'CORTEX_STEP_STATUS_WAITING',
        metadata: {
          toolCall: { id: 'toolu_gate', name: 'run_command', argumentsJson: JSON.stringify(args) },
          sourceTrajectoryStepInfo: { trajectoryId: 't1', stepIndex: 2, cascadeId: 'c1' },
        },
      };
      const handled = await bridge.nativeExecuteAndPush(step, { cascadeId: 'c1', cwd: '/tmp' });
      assert.equal(
        handled,
        false,
        `must not execute when SafeToAutoRun=${JSON.stringify(args.SafeToAutoRun)} (approval still owed)`,
      );
    }
    // No RPC calls at all — neither RunCommand nor CancelCascadeSteps
    assert.equal(rpcMock.mock.callCount(), 0);
    assert.equal(bridge.sendMessage.mock.callCount(), 0);
  });

  test('writes audit entry with result', async () => {
    const { bridge, logDir } = makeBridge();
    const step = makeStep({ commandLine: 'ls' });
    await bridge.nativeExecuteAndPush(step, { cascadeId: 'c1', cwd: '/tmp' });
    const files = fs.readdirSync(logDir);
    assert.equal(files.length, 1);
    const entry = JSON.parse(fs.readFileSync(path.join(logDir, files[0]), 'utf8').trim());
    assert.equal(entry.tool, 'run_command');
    assert.equal(entry.cascadeId, 'c1');
    assert.equal(entry.input.commandLine, 'ls');
    assert.equal(entry.result.status, 'success');
  });
});
