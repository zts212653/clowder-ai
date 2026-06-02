import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, mock, test } from 'node:test';
import { AntigravityBridge } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityBridge.js';

function tempStorePath() {
  return path.join(os.tmpdir(), `antigravity-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}
function createBridge() {
  const bridge = new AntigravityBridge(
    { port: 1234, csrfToken: 'test', useTls: false },
    { sessionStorePath: tempStorePath() },
  );
  mock.method(bridge, 'ensureConnected', async () => ({ port: 1234, csrfToken: 'test', useTls: false }));
  Object.getPrototypeOf(bridge).rpc = async () => ({});
  return bridge;
}
const makeStep = (type, extra = {}) => ({ type, status: 'CORTEX_STEP_STATUS_DONE', ...extra });

describe('F211-REG9: pollForSteps status-gate', () => {
  test('an unchanged/stalled cascade is NOT re-downloaded every poll — full getTrajectory fires only on change', async () => {
    const bridge = createBridge();
    // stepsBefore=5; cascade RUNNING@5 (stalled, unchanged) for 3 polls, then advances to 6 + IDLE.
    const statusSeq = [
      { stepCount: 5, status: 'CASCADE_RUN_STATUS_RUNNING', lastModifiedTime: 'T1' },
      { stepCount: 5, status: 'CASCADE_RUN_STATUS_RUNNING', lastModifiedTime: 'T1' },
      { stepCount: 5, status: 'CASCADE_RUN_STATUS_RUNNING', lastModifiedTime: 'T1' },
      { stepCount: 6, status: 'CASCADE_RUN_STATUS_IDLE', lastModifiedTime: 'T2' },
    ];
    let si = 0;
    let current = statusSeq[0];
    mock.method(bridge, 'getCascadeStatus', async () => {
      current = statusSeq[Math.min(si++, statusSeq.length - 1)];
      return current;
    });
    // getTrajectory / getTrajectorySteps always reflect the CURRENT status (the full fetch is
    // decoupled from poll-count by the gate, so they must not be indexed by call-count).
    mock.method(bridge, 'getTrajectory', async () => ({ status: current.status, numTotalSteps: current.stepCount }));
    const steps = [
      ...Array.from({ length: 5 }, () => makeStep('CORTEX_STEP_TYPE_PLANNER_RESPONSE')),
      makeStep('CORTEX_STEP_TYPE_PLANNER_RESPONSE', { plannerResponse: { response: 'done', stopReason: 'STOP' } }),
    ];
    mock.method(bridge, 'getTrajectorySteps', async () => steps.slice(0, current.stepCount));

    const batches = [];
    for await (const b of bridge.pollForSteps('c1', 5, 2_000, 5, undefined, false)) {
      batches.push(b);
      if (batches.length > 30) break;
    }

    const statusCalls = bridge.getCascadeStatus.mock.callCount();
    const trajCalls = bridge.getTrajectory.mock.callCount();
    assert.ok(statusCalls >= 3, `cheap getCascadeStatus must drive each poll tick, got ${statusCalls}`);
    assert.ok(
      trajCalls < statusCalls,
      `full getTrajectory (${trajCalls}) must be < status polls (${statusCalls}); unchanged polls must skip the ~4MB fetch`,
    );
    assert.ok(
      trajCalls <= 2,
      `full getTrajectory should fire only on change (initial + step-6/IDLE), got ${trajCalls}`,
    );
    assert.ok(
      batches.some((b) => b.cursor.terminalSeen),
      'poll must still terminate at the real IDLE after the change',
    );
  });

  test('a genuinely stalled cascade (status frozen, never idle) still surfaces via idle-timeout — no silent infinite poll', async () => {
    const bridge = createBridge();
    const frozen = { stepCount: 5, status: 'CASCADE_RUN_STATUS_RUNNING', lastModifiedTime: 'FROZEN' };
    mock.method(bridge, 'getCascadeStatus', async () => frozen);
    mock.method(bridge, 'getTrajectory', async () => ({ status: frozen.status, numTotalSteps: frozen.stepCount }));
    mock.method(bridge, 'getTrajectorySteps', async () =>
      Array.from({ length: 5 }, () => makeStep('CORTEX_STEP_TYPE_PLANNER_RESPONSE')),
    );

    await assert.rejects(
      async () => {
        for await (const _b of bridge.pollForSteps('c1', 5, 40, 5, undefined, false)) {
          // drain
        }
      },
      /stall/i,
      'a frozen cascade must throw the idle-timeout stall, not poll forever silently',
    );
  });

  test('a transient getTrajectory failure AFTER a real change retries the full fetch — never skips the change to a false stall (砚砚 P1)', async () => {
    const bridge = createBridge();
    // RUNNING/5/T1 (initial) → IDLE/6/T2 (the real change), then stays IDLE/6/T2.
    const statusSeq = [
      { stepCount: 5, status: 'CASCADE_RUN_STATUS_RUNNING', lastModifiedTime: 'T1' },
      { stepCount: 6, status: 'CASCADE_RUN_STATUS_IDLE', lastModifiedTime: 'T2' },
      { stepCount: 6, status: 'CASCADE_RUN_STATUS_IDLE', lastModifiedTime: 'T2' },
      { stepCount: 6, status: 'CASCADE_RUN_STATUS_IDLE', lastModifiedTime: 'T2' },
    ];
    let si = 0;
    let current = statusSeq[0];
    mock.method(bridge, 'getCascadeStatus', async () => {
      current = statusSeq[Math.min(si++, statusSeq.length - 1)];
      return current;
    });
    // The FIRST full fetch of the IDLE/6 change throws once (transient LS RPC error); subsequent ok.
    let trajCalls = 0;
    mock.method(bridge, 'getTrajectory', async () => {
      trajCalls += 1;
      if (current.stepCount === 6 && trajCalls === 2) throw new Error('transient LS RPC error');
      return { status: current.status, numTotalSteps: current.stepCount };
    });
    const steps = [
      ...Array.from({ length: 5 }, () => makeStep('CORTEX_STEP_TYPE_PLANNER_RESPONSE')),
      makeStep('CORTEX_STEP_TYPE_PLANNER_RESPONSE', { plannerResponse: { response: 'done', stopReason: 'STOP' } }),
    ];
    mock.method(bridge, 'getTrajectorySteps', async () => steps.slice(0, current.stepCount));

    // Buggy code (optimistic lastStatusKey commit before the fetch succeeds) skips the IDLE/6 full fetch
    // after the transient failure and false-stalls. The fix must retry the change and deliver the terminal.
    const batches = [];
    for await (const b of bridge.pollForSteps('c1', 5, 200, 5, undefined, false)) {
      batches.push(b);
      if (batches.length > 50) break;
    }
    assert.ok(
      batches.some((b) => b.cursor.terminalSeen),
      'after a transient full-fetch failure on a real change, the poll must retry and deliver the terminal (not skip → false stall)',
    );
    assert.ok(batches.flatMap((b) => b.steps).length >= 1, 'the step-6 change must be delivered after the retry');
  });
});
