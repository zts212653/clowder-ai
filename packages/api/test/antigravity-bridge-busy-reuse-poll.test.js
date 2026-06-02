import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, mock, test } from 'node:test';
import { AntigravityBridge } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityBridge.js';

function tempStorePath() {
  return path.join(os.tmpdir(), `antigravity-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function createBridge() {
  const storePath = tempStorePath();
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

/** Build a fake trajectory at a given step count and status. */
function makeTraj(numSteps, status = 'CASCADE_RUN_STATUS_IDLE', extra = {}) {
  return {
    status,
    numTotalSteps: numSteps,
    ...extra,
  };
}

/** Build a minimal trajectory step. */
function makeStep(type, extra = {}) {
  return { type, status: 'CORTEX_STEP_STATUS_DONE', ...extra };
}

describe('F211-REG8: pollForSteps busy-reuse follow-up turn', () => {
  test('busy-reuse: poll waits for the follow-up turn, not terminating at the old turn IDLE (else follow-up is lost)', async () => {
    const bridge = createBridge();

    // Simulate: cascade was RUNNING at step 680 when sendMessage was called.
    // sendMessage returns { stepsBefore: 680, wasBusy: true }.
    // Old turn adds steps 681-683, then goes IDLE.
    // Then follow-up picks up (USER_INPUT at 684), model responds (685), goes IDLE again.

    let pollCount = 0;
    const trajectorySequence = [
      // Poll 1: old turn still running, step 681 added
      () => makeTraj(681, 'CASCADE_RUN_STATUS_RUNNING'),
      // Poll 2: old turn finishing, steps 682-683, now IDLE (old turn done)
      () => makeTraj(683, 'CASCADE_RUN_STATUS_IDLE'),
      // Poll 3: follow-up picked up, USER_INPUT at 684, RUNNING again
      () => makeTraj(685, 'CASCADE_RUN_STATUS_RUNNING'),
      // Poll 4: follow-up response done, IDLE
      () => makeTraj(686, 'CASCADE_RUN_STATUS_IDLE'),
    ];

    mock.method(bridge, 'getTrajectory', async () => {
      const idx = Math.min(pollCount++, trajectorySequence.length - 1);
      return trajectorySequence[idx]();
    });

    const allStepsData = [
      // Steps 0-679: old turn (before stepsBefore)
      ...Array.from({ length: 680 }, () => makeStep('CORTEX_STEP_TYPE_PLANNER_RESPONSE')),
      // Steps 680-682: old turn tail (after stepsBefore)
      makeStep('CORTEX_STEP_TYPE_PLANNER_RESPONSE'),
      makeStep('CORTEX_STEP_TYPE_TOOL_CALL'),
      makeStep('CORTEX_STEP_TYPE_TOOL_RESULT'),
      // Step 683: follow-up USER_INPUT
      makeStep('CORTEX_STEP_TYPE_USER_INPUT', { userInput: { items: [{ text: 'follow-up question' }] } }),
      // Steps 684-685: follow-up response
      makeStep('CORTEX_STEP_TYPE_PLANNER_RESPONSE', { plannerResponse: { response: 'follow-up answer' } }),
      makeStep('CORTEX_STEP_TYPE_PLANNER_RESPONSE', { plannerResponse: { response: '', stopReason: 'STOP' } }),
    ];

    mock.method(bridge, 'getTrajectorySteps', async () => {
      const count = bridge.getTrajectory.mock.callCount();
      const idx = Math.min(count - 1, trajectorySequence.length - 1);
      const numSteps = trajectorySequence[idx]().numTotalSteps;
      return allStepsData.slice(0, numSteps);
    });

    // Call sendMessage first to get stepsBefore + wasBusy
    const result = await bridge.sendMessage('cascade-1', 'follow-up question');
    // REG8 fix: sendMessage should return { stepsBefore, wasBusy }
    // Before fix: returns just a number
    const stepsBefore = typeof result === 'object' ? result.stepsBefore : result;
    const wasBusy = typeof result === 'object' ? result.wasBusy : false;

    // Collect all yielded batches from pollForSteps
    const batches = [];
    for await (const batch of bridge.pollForSteps(
      'cascade-1',
      stepsBefore,
      60_000,
      10, // fast poll for test
      undefined,
      wasBusy, // REG8: expectFollowUpTurn
    )) {
      batches.push(batch);
      // Safety: don't loop forever
      if (batches.length > 20) break;
    }

    // The fix should ensure we get batches from BOTH turns:
    // - Old turn tail (steps 680-682)
    // - Follow-up response (steps 684-685) after USER_INPUT
    const allDeliveredSteps = batches.flatMap((b) => b.steps);
    const hasFollowUpUserInput = allDeliveredSteps.some((s) => s.type === 'CORTEX_STEP_TYPE_USER_INPUT');
    const hasFollowUpResponse = allDeliveredSteps.some((s) => s.plannerResponse?.response === 'follow-up answer');

    // This is the REG8 assertion: poll must NOT terminate before delivering the follow-up
    assert.ok(hasFollowUpUserInput, 'should have delivered the follow-up USER_INPUT step');
    assert.ok(hasFollowUpResponse, 'should have delivered the follow-up response');

    // Final batch should be terminal (IDLE after follow-up, not after old turn)
    const lastBatch = batches[batches.length - 1];
    assert.equal(lastBatch.cursor.terminalSeen, true, 'final batch should be terminal');
  });

  test('normal IDLE path (not busy-reuse) still terminates immediately', async () => {
    const bridge = createBridge();

    // Normal case: cascade was IDLE when sendMessage was called.
    // sendMessage returns stepsBefore with wasBusy=false.
    // Model responds, then IDLE.

    let pollCount = 0;
    const trajectorySequence = [
      () => makeTraj(2, 'CASCADE_RUN_STATUS_RUNNING'),
      () => makeTraj(3, 'CASCADE_RUN_STATUS_IDLE'),
    ];

    mock.method(bridge, 'getTrajectory', async () => {
      const idx = Math.min(pollCount++, trajectorySequence.length - 1);
      return trajectorySequence[idx]();
    });

    const steps = [
      makeStep('CORTEX_STEP_TYPE_USER_INPUT'),
      makeStep('CORTEX_STEP_TYPE_PLANNER_RESPONSE', { plannerResponse: { response: 'answer' } }),
      makeStep('CORTEX_STEP_TYPE_PLANNER_RESPONSE', { plannerResponse: { response: '', stopReason: 'STOP' } }),
    ];

    mock.method(bridge, 'getTrajectorySteps', async () => {
      const count = bridge.getTrajectory.mock.callCount();
      const numSteps = trajectorySequence[Math.min(count - 1, trajectorySequence.length - 1)]().numTotalSteps;
      return steps.slice(0, numSteps);
    });

    // sendMessage on IDLE cascade → wasBusy = false
    // Reset pollCount for the poll phase
    pollCount = 0;

    const batches = [];
    for await (const batch of bridge.pollForSteps(
      'cascade-1',
      1, // stepsBefore = 1 (after USER_INPUT)
      60_000,
      10,
      undefined,
      false, // NOT busy-reuse
    )) {
      batches.push(batch);
      if (batches.length > 20) break;
    }

    // Should terminate normally at the first IDLE
    assert.ok(batches.length <= 3, `should terminate quickly, got ${batches.length} batches`);
    const lastBatch = batches[batches.length - 1];
    assert.equal(lastBatch.cursor.terminalSeen, true);
  });
});
