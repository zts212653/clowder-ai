import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, mock, test } from 'node:test';
import { AntigravityBridge } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityBridge.js';

function tempStorePath() {
  return path.join(os.tmpdir(), `antigravity-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AntigravityBridge.drainCascade', () => {
  const cleanupPaths = [];

  afterEach(() => {
    for (const p of cleanupPaths) {
      try {
        fs.unlinkSync(p);
      } catch {}
    }
    cleanupPaths.length = 0;
  });

  function createBridge() {
    const storePath = tempStorePath();
    cleanupPaths.push(storePath);
    const bridge = new AntigravityBridge(
      { port: 1234, csrfToken: 'test', useTls: false },
      { sessionStorePath: storePath },
    );
    mock.method(bridge, 'ensureConnected', async () => ({ port: 1234, csrfToken: 'test', useTls: false }));
    Object.getPrototypeOf(bridge).rpc = async (_conn, method) => {
      if (method === 'CancelCascadeSteps') return {};
      return {};
    };
    return bridge;
  }

  test('fails closed while pushToolResult writeback is in flight', async () => {
    const bridge = createBridge();
    const blockedSend = deferred();
    mock.method(bridge, 'sendMessage', async () => blockedSend.promise);

    const pushPromise = bridge.pushToolResult(
      'c1',
      23,
      { status: 'success', output: { exitCode: 0 }, stdout: 'ok', exitCode: 0, durationMs: 1 },
      { commandLine: 'echo ok', cwd: '/tmp' },
    );

    while (bridge.sendMessage.mock.callCount() === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const drained = await bridge.drainCascade('c1', { quietWindowMs: 1, timeoutMs: 10, pollIntervalMs: 1 });
    assert.equal(drained.ok, false);
    assert.equal(drained.drainResult, 'best_effort_quiet_window');
    assert.match(drained.reason, /in-flight/i);

    blockedSend.resolve(1);
    await pushPromise;
  });

  test('clears writeback in-flight state when pushToolResult throws', async () => {
    const bridge = createBridge();
    mock.method(bridge, 'sendMessage', async () => {
      throw new Error('writeback failed');
    });
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 0,
    }));

    await assert.rejects(
      bridge.pushToolResult(
        'c1',
        23,
        { status: 'success', output: { exitCode: 0 }, stdout: 'ok', exitCode: 0, durationMs: 1 },
        { commandLine: 'echo ok', cwd: '/tmp' },
      ),
      /writeback failed/,
    );

    const drained = await bridge.drainCascade('c1', { quietWindowMs: 1, timeoutMs: 20, pollIntervalMs: 1 });
    assert.equal(drained.ok, true);
    assert.equal(drained.drainResult, 'complete');
    assert.equal(drained.lastObservedStepCount, 0);
  });

  test('returns complete once meaningful trajectory steps stay quiet', async () => {
    const bridge = createBridge();
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 3,
      trajectory: {
        steps: [
          { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
          { type: 'CORTEX_STEP_TYPE_CODE_ACTION', status: 'CORTEX_STEP_STATUS_CANCELED' },
          { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'CORTEX_STEP_STATUS_DONE' },
        ],
      },
    }));

    const drained = await bridge.drainCascade('c1', { quietWindowMs: 1, timeoutMs: 20, pollIntervalMs: 1 });
    assert.equal(drained.ok, true);
    assert.equal(drained.drainResult, 'complete');
    assert.equal(drained.lastObservedStepCount, 1);
  });

  test('does not complete while the trajectory remains non-idle', async () => {
    const bridge = createBridge();
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_RUNNING',
      numTotalSteps: 3,
      awaitingUserInput: false,
    }));

    const drained = await bridge.drainCascade('c1', { quietWindowMs: 1, timeoutMs: 20, pollIntervalMs: 1 });
    assert.equal(drained.ok, false);
    assert.equal(drained.drainResult, 'best_effort_quiet_window');
    assert.match(drained.reason, /CASCADE_RUN_STATUS_RUNNING/);
    assert.equal(drained.lastObservedStepCount, 3);
  });

  test('returns skipped_runtime_unreachable when trajectory cannot be read', async () => {
    const bridge = createBridge();
    mock.method(bridge, 'getTrajectory', async () => {
      throw new Error('ECONNREFUSED');
    });

    const drained = await bridge.drainCascade('c1', { quietWindowMs: 1, timeoutMs: 20, pollIntervalMs: 1 });
    assert.equal(drained.ok, false);
    assert.equal(drained.drainResult, 'skipped_runtime_unreachable');
    assert.match(drained.reason, /ECONNREFUSED/);
  });

  test('returns best_effort_quiet_window when trajectory keeps changing until timeout', async () => {
    const bridge = createBridge();
    let stepCount = 0;
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_RUNNING',
      numTotalSteps: ++stepCount,
    }));

    const drained = await bridge.drainCascade('c1', { quietWindowMs: 10, timeoutMs: 20, pollIntervalMs: 1 });
    assert.equal(drained.ok, false);
    assert.equal(drained.drainResult, 'best_effort_quiet_window');
    assert.match(drained.reason, /quiet window/i);
    assert.ok(drained.lastObservedStepCount > 0);
  });

  test('bounds stalled trajectory reads by the drain timeout', async () => {
    const bridge = createBridge();
    const blockedTrajectory = deferred();
    let trajectorySignal;
    mock.method(bridge, 'getTrajectory', async (_cascadeId, options = {}) => {
      trajectorySignal = options.signal;
      trajectorySignal?.addEventListener('abort', () => blockedTrajectory.reject(trajectorySignal.reason), {
        once: true,
      });
      return blockedTrajectory.promise;
    });

    const drainPromise = bridge.drainCascade('c1', { quietWindowMs: 1, timeoutMs: 20, pollIntervalMs: 1 });

    try {
      const drained = await Promise.race([
        drainPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('drain timeout was not honored')), 120)),
      ]);

      assert.equal(drained.ok, false);
      assert.equal(drained.drainResult, 'best_effort_quiet_window');
      assert.match(drained.reason, /timeout/i);
      assert.ok(trajectorySignal instanceof AbortSignal);
      assert.equal(trajectorySignal.aborted, true);
      assert.match(String(trajectorySignal.reason), /trajectory read exceeded drain timeout/i);
    } finally {
      blockedTrajectory.resolve({
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 0,
      });
      await drainPromise.catch(() => {});
    }
  });
});
