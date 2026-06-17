import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import { AntigravityBridge } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityBridge.js';

function createBridge() {
  return new AntigravityBridge({ port: 1234, csrfToken: 'test', useTls: false });
}

function plannerTextsFromBatches(batches) {
  return batches
    .flatMap((batch) => batch.steps)
    .map((step) => step.plannerResponse?.modifiedResponse ?? step.plannerResponse?.response)
    .filter(Boolean);
}

// ── G2: Streaming delivery (async generator) ───────────────────────

describe('G2: pollForSteps yields steps incrementally', () => {
  test('yields new steps as they appear without waiting for IDLE', async () => {
    const bridge = createBridge();
    let callCount = 0;
    const trajectories = [
      {
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 1,
        trajectory: {
          steps: [
            { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'DONE', plannerResponse: { response: 'step1' } },
          ],
        },
      },
      {
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 2,
        trajectory: {
          steps: [
            { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'DONE', plannerResponse: { response: 'step1' } },
            { type: 'CORTEX_STEP_TYPE_TOOL_CALL', status: 'IN_PROGRESS', toolCall: { toolName: 'search' } },
          ],
        },
      },
      {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 3,
        trajectory: {
          steps: [
            { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'DONE', plannerResponse: { response: 'step1' } },
            { type: 'CORTEX_STEP_TYPE_TOOL_CALL', status: 'DONE', toolCall: { toolName: 'search' } },
            { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'DONE', plannerResponse: { response: 'final' } },
          ],
        },
      },
    ];
    mock.method(bridge, 'getTrajectory', async () => trajectories[callCount++]);
    mock.method(bridge, 'getTrajectorySteps', async () => []);

    const yielded = [];
    for await (const batch of bridge.pollForSteps('cascade-1', 0, 5000, 50)) {
      yielded.push(batch);
    }

    assert.ok(yielded.length >= 2, `should yield multiple batches, got ${yielded.length}`);
    assert.equal(yielded[0].steps.length, 1, 'first batch: 1 new step');
    assert.equal(yielded[0].cursor.lastDeliveredStepCount, 1);
  });

  test('final batch has terminalSeen=true', async () => {
    const bridge = createBridge();
    let callCount = 0;
    const trajectories = [
      {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 1,
        trajectory: {
          steps: [{ type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'DONE', plannerResponse: { response: 'done' } }],
        },
      },
    ];
    mock.method(bridge, 'getTrajectory', async () => trajectories[callCount++]);
    mock.method(bridge, 'getTrajectorySteps', async () => []);

    const yielded = [];
    for await (const batch of bridge.pollForSteps('cascade-1', 0, 5000, 50)) {
      yielded.push(batch);
    }

    const lastBatch = yielded[yielded.length - 1];
    assert.equal(lastBatch.cursor.terminalSeen, true);
  });

  test('F211-REG12: IDLE with already-delivered generating planner text returns terminal instead of stalling', async () => {
    // Live repro 2026-06-05: Antigravity can flip the cascade summary to IDLE while the latest
    // planner response remains GENERATING, but already contains the text we delivered. That cascade
    // is still not a clean reuse target, but the current poll must close instead of waiting for a
    // never-created next step and throwing "steps=N, status=IDLE" after 60s.
    const bridge = createBridge();
    let callCount = 0;
    const generatingTextStep = {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_GENERATING',
      plannerResponse: { response: '发现了关键信息。让我发评估到 thread。' },
    };
    const trajectories = [
      {
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 1,
        trajectory: { steps: [generatingTextStep] },
      },
      {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 1,
        trajectory: { steps: [generatingTextStep] },
      },
    ];
    mock.method(bridge, 'getTrajectory', async () => trajectories[Math.min(callCount++, trajectories.length - 1)]);
    mock.method(bridge, 'getTrajectorySteps', async () => []);

    const yielded = [];
    for await (const batch of bridge.pollForSteps('cascade-1', 0, 40, 5)) {
      yielded.push(batch);
    }

    assert.equal(yielded[0].steps[0].plannerResponse.response, '发现了关键信息。让我发评估到 thread。');
    const lastBatch = yielded[yielded.length - 1];
    assert.equal(lastBatch.cursor.terminalSeen, true);
    assert.equal(lastBatch.cursor.lastDeliveredStepCount, 1);
  });

  test('F211-REG12: IDLE final text mutation under status gate gets a terminal follow-up fetch', async () => {
    const bridge = createBridge();
    let statusCallCount = 0;
    let trajectoryCallCount = 0;
    const statusSummaries = [
      { stepCount: 1, status: 'CASCADE_RUN_STATUS_RUNNING', lastModifiedTime: 'T1' },
      { stepCount: 1, status: 'CASCADE_RUN_STATUS_IDLE', lastModifiedTime: 'T2' },
      { stepCount: 1, status: 'CASCADE_RUN_STATUS_IDLE', lastModifiedTime: 'T2' },
    ];
    const trajectories = [
      {
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 1,
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_GENERATING',
              plannerResponse: { response: '发现了关键信息。' },
            },
          ],
        },
      },
      {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 1,
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_GENERATING',
              plannerResponse: { response: '发现了关键信息。让我发评估到 thread。' },
            },
          ],
        },
      },
    ];
    mock.method(
      bridge,
      'getCascadeStatus',
      async () => statusSummaries[Math.min(statusCallCount++, statusSummaries.length - 1)],
    );
    mock.method(
      bridge,
      'getTrajectory',
      async () => trajectories[Math.min(trajectoryCallCount++, trajectories.length - 1)],
    );
    mock.method(bridge, 'getTrajectorySteps', async () => []);

    const yielded = [];
    for await (const batch of bridge.pollForSteps('cascade-1', 0, 40, 5)) {
      yielded.push(batch);
    }

    assert.equal(yielded[0].steps[0].plannerResponse.response, '发现了关键信息。');
    assert.equal(yielded[1].steps[0].plannerResponse.response, '让我发评估到 thread。');
    assert.equal(yielded.at(-1).cursor.terminalSeen, true);
    assert.equal(yielded.at(-1).cursor.lastDeliveredStepCount, 1);
    assert.ok(trajectoryCallCount >= 3, 'unchanged IDLE status must still get one follow-up full fetch');
  });

  test('F211-REG12: dirty-IDLE terminal exception requires text on the generating planner', async () => {
    const bridge = createBridge();
    let callCount = 0;
    const emptyLatestPlanner = {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      status: 'CORTEX_STEP_STATUS_GENERATING',
      plannerResponse: {},
    };
    const textLatestPlanner = {
      ...emptyLatestPlanner,
      plannerResponse: { response: 'second planner finally produced text' },
    };
    const baseSteps = [
      { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'DONE' },
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        status: 'DONE',
        plannerResponse: { response: 'earlier planner text' },
      },
    ];
    const trajectories = [
      {
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 3,
        trajectory: { steps: [...baseSteps, emptyLatestPlanner] },
      },
      {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 3,
        trajectory: { steps: [...baseSteps, emptyLatestPlanner] },
      },
      {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 3,
        trajectory: { steps: [...baseSteps, textLatestPlanner] },
      },
      {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 3,
        trajectory: { steps: [...baseSteps, textLatestPlanner] },
      },
    ];
    mock.method(bridge, 'getTrajectory', async () => trajectories[Math.min(callCount++, trajectories.length - 1)]);
    mock.method(bridge, 'getTrajectorySteps', async () => []);

    const yielded = [];
    for await (const batch of bridge.pollForSteps('cascade-1', 0, 80, 5)) {
      yielded.push(batch);
    }

    assert.deepEqual(plannerTextsFromBatches(yielded), [
      'earlier planner text',
      'second planner finally produced text',
    ]);
    assert.equal(yielded.at(-1).cursor.terminalSeen, true);
    assert.ok(callCount >= 4, 'empty latest generating planner must force polling until that planner has text');
  });

  test('F211-REG14: resumed clean IDLE tail terminalizes before status-gate stall', async () => {
    const bridge = createBridge();
    let statusCallCount = 0;
    let trajectoryCallCount = 0;
    const cleanTail = [
      { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'CORTEX_STEP_STATUS_DONE' },
      {
        type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
        status: 'CORTEX_STEP_STATUS_DONE',
        plannerResponse: {
          response: 'co-creator催我了！来了来了！我已经把所有核心文档全部读完。',
          stopReason: 'STOP_REASON_CLIENT_CANCELED',
        },
      },
    ];
    const idleSummary = { stepCount: 2, status: 'CASCADE_RUN_STATUS_IDLE', lastModifiedTime: 'T-final' };
    mock.method(bridge, 'getCascadeStatus', async () => {
      statusCallCount += 1;
      return idleSummary;
    });
    mock.method(bridge, 'getTrajectory', async () => {
      trajectoryCallCount += 1;
      return {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 2,
        trajectory: { steps: cleanTail },
      };
    });
    mock.method(bridge, 'getTrajectorySteps', async () => cleanTail);

    const yielded = [];
    for await (const batch of bridge.pollForSteps('cascade-1', 2, 40, 5, undefined, false, 0)) {
      yielded.push(batch);
    }

    assert.equal(yielded.length, 1, 'resumed clean IDLE tail should emit one empty terminal batch');
    assert.equal(yielded[0].steps.length, 0);
    assert.equal(yielded[0].cursor.terminalSeen, true);
    assert.equal(yielded[0].cursor.lastDeliveredStepCount, 2);
    assert.ok(statusCallCount >= 1);
    assert.equal(trajectoryCallCount, 1, 'one full fetch is enough to prove the clean terminal tail');
  });

  test('throws on stall (no new steps within timeout)', async () => {
    const bridge = createBridge();
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_RUNNING',
      numTotalSteps: 0,
    }));

    await assert.rejects(async () => {
      for await (const _ of bridge.pollForSteps('cascade-1', 0, 100, 30)) {
        // consume
      }
    }, /stall/i);
  });

  test('yields delta when planner response grows in place without a new step', async () => {
    const bridge = createBridge();
    let callCount = 0;
    const trajectories = [
      {
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 1,
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { modifiedResponse: 'co-creator，我活着，' },
            },
          ],
        },
      },
      {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 1,
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { modifiedResponse: 'co-creator，我活着，喵。' },
            },
          ],
        },
      },
    ];
    mock.method(bridge, 'getTrajectory', async () => trajectories[callCount++]);
    mock.method(bridge, 'getTrajectorySteps', async () => []);

    const yielded = [];
    for await (const batch of bridge.pollForSteps('cascade-1', 0, 5000, 50)) {
      yielded.push(batch);
    }

    assert.equal(yielded.length, 2, `should emit partial + terminal delta, got ${yielded.length} batches`);
    assert.equal(yielded[0].steps[0].plannerResponse.modifiedResponse, 'co-creator，我活着，');
    assert.equal(yielded[0].cursor.terminalSeen, false);
    assert.equal(yielded[1].steps[0].plannerResponse.modifiedResponse, '喵。');
    assert.equal(yielded[1].cursor.lastDeliveredStepCount, 1);
    assert.equal(yielded[1].cursor.terminalSeen, true);
  });

  test('AC-G2/G3: emits heartbeat liveness when trajectory timestamp advances without new steps', async () => {
    const bridge = createBridge();
    let callCount = 0;
    const trajectories = [
      {
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 0,
        updatedAt: 1770000000000,
      },
      {
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 0,
        updatedAt: 1770000002000,
      },
      {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 1,
        updatedAt: 1770000003000,
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { response: 'finished after timestamp heartbeat' },
            },
          ],
        },
      },
    ];
    mock.method(bridge, 'getTrajectory', async () => trajectories[Math.min(callCount++, trajectories.length - 1)]);
    mock.method(bridge, 'getTrajectorySteps', async () => trajectories[2].trajectory.steps);

    const yielded = [];
    for await (const batch of bridge.pollForSteps('cascade-1', 0, 5000, 10)) {
      yielded.push(batch);
    }

    const heartbeat = yielded.find((batch) => batch.steps.length === 0 && batch.cursor.livenessEvidence);
    assert.ok(heartbeat, 'timestamp progress should emit an internal heartbeat batch');
    assert.equal(heartbeat.cursor.livenessEvidence.kind, 'trajectory_timestamp_progress');
    assert.equal(heartbeat.cursor.lastTrajectoryAt, 1770000002000);
    assert.equal(yielded.at(-1).steps[0].plannerResponse.response, 'finished after timestamp heartbeat');
  });

  test('keeps polling when cascade is IDLE but planner response is still generating', async () => {
    const bridge = createBridge();
    let callCount = 0;
    const trajectories = [
      {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 1,
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'CORTEX_STEP_STATUS_GENERATING',
              plannerResponse: { modifiedResponse: '让我写成 artifact——' },
            },
          ],
        },
      },
      {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 1,
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { modifiedResponse: '让我写成 artifact——\n\n# 背景文档\n完整正文。' },
            },
          ],
        },
      },
    ];
    mock.method(bridge, 'getTrajectory', async () => trajectories[Math.min(callCount++, trajectories.length - 1)]);
    mock.method(bridge, 'getTrajectorySteps', async () => []);

    const yielded = [];
    for await (const batch of bridge.pollForSteps('cascade-1', 0, 5000, 10)) {
      yielded.push(batch);
    }

    assert.equal(yielded.length, 2, `should emit partial + final mutation, got ${yielded.length} batches`);
    assert.equal(yielded[0].steps[0].plannerResponse.modifiedResponse, '让我写成 artifact——');
    assert.equal(yielded[0].cursor.terminalSeen, false);
    assert.equal(yielded[1].steps[0].plannerResponse.modifiedResponse, '\n\n# 背景文档\n完整正文。');
    assert.equal(yielded[1].cursor.terminalSeen, true);
  });

  test('does not replay already-delivered steps on terminal-first resumed poll', async () => {
    const bridge = createBridge();
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 4,
      trajectory: {
        steps: [
          { type: 'CORTEX_STEP_TYPE_CHECKPOINT', status: 'DONE' },
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'DONE',
            plannerResponse: { modifiedResponse: 'old partial' },
          },
          {
            type: 'CORTEX_STEP_TYPE_TOOL_CALL',
            status: 'DONE',
            toolCall: { toolName: 'search' },
          },
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status: 'DONE',
            plannerResponse: { modifiedResponse: 'new delta' },
          },
        ],
      },
    }));
    mock.method(bridge, 'getTrajectorySteps', async () => []);

    const yielded = [];
    for await (const batch of bridge.pollForSteps('cascade-1', 3, 5000, 50)) {
      yielded.push(batch);
    }

    assert.equal(yielded.length, 1, `should emit exactly one terminal batch, got ${yielded.length}`);
    assert.equal(yielded[0].steps.length, 1, 'should only emit the truly new step');
    assert.equal(yielded[0].steps[0].plannerResponse.modifiedResponse, 'new delta');
    assert.equal(yielded[0].cursor.lastDeliveredStepCount, 4);
    assert.equal(yielded[0].cursor.terminalSeen, true);
  });

  test('does not emit baseline planner mutations as text for a later user turn', async () => {
    const bridge = createBridge();
    let callCount = 0;
    const trajectories = [
      {
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 2,
        trajectory: {
          steps: [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'DONE' },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { modifiedResponse: 'previous answer partial' },
            },
          ],
        },
      },
      {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 3,
        trajectory: {
          steps: [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'DONE' },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { modifiedResponse: 'previous answer partial finalized' },
            },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { modifiedResponse: 'current answer' },
            },
          ],
        },
      },
    ];
    mock.method(bridge, 'getTrajectory', async () => trajectories[Math.min(callCount++, trajectories.length - 1)]);
    mock.method(bridge, 'getTrajectorySteps', async () => []);

    const yielded = [];
    for await (const batch of bridge.pollForSteps('cascade-1', 2, 5000, 10)) {
      yielded.push(batch);
    }

    const emittedPlannerTexts = plannerTextsFromBatches(yielded);

    assert.deepEqual(emittedPlannerTexts, ['current answer']);
    assert.equal(yielded.at(-1).cursor.terminalSeen, true);
  });

  test('does not treat skipped baseline-only mutation as current-turn progress', async () => {
    const bridge = createBridge();
    let callCount = 0;
    const trajectories = [
      {
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 2,
        trajectory: {
          steps: [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'DONE' },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { modifiedResponse: 'previous answer partial' },
            },
          ],
        },
      },
      {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 2,
        trajectory: {
          steps: [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'DONE' },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { modifiedResponse: 'previous answer partial finalized' },
            },
          ],
        },
      },
      {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 3,
        trajectory: {
          steps: [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'DONE' },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { modifiedResponse: 'previous answer partial finalized' },
            },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { modifiedResponse: 'current answer' },
            },
          ],
        },
      },
    ];
    mock.method(bridge, 'getTrajectory', async () => trajectories[Math.min(callCount++, trajectories.length - 1)]);
    mock.method(bridge, 'getTrajectorySteps', async () => []);

    const yielded = [];
    for await (const batch of bridge.pollForSteps('cascade-1', 2, 5000, 10)) {
      yielded.push(batch);
    }

    const emittedPlannerTexts = plannerTextsFromBatches(yielded);

    assert.deepEqual(emittedPlannerTexts, ['current answer']);
    assert.equal(yielded.length, 1, 'baseline-only mutation must not emit an empty terminal batch');
    assert.equal(yielded.at(-1).cursor.terminalSeen, true);
  });

  test('replays current-turn mutation when retry resumes after the original baseline', async () => {
    const bridge = createBridge();
    let callCount = 0;
    const trajectories = [
      {
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 2,
        trajectory: {
          steps: [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'DONE' },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { modifiedResponse: 'current answer partial' },
            },
          ],
        },
      },
      {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 2,
        trajectory: {
          steps: [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'DONE' },
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: { modifiedResponse: 'current answer partial finalized' },
            },
          ],
        },
      },
    ];
    mock.method(bridge, 'getTrajectory', async () => trajectories[Math.min(callCount++, trajectories.length - 1)]);
    mock.method(bridge, 'getTrajectorySteps', async () => []);

    const yielded = [];
    for await (const batch of bridge.pollForSteps('cascade-1', 2, 80, 10, undefined, false, 1)) {
      yielded.push(batch);
    }

    const emittedPlannerTexts = plannerTextsFromBatches(yielded);

    assert.deepEqual(emittedPlannerTexts, [' finalized']);
    assert.equal(yielded.length, 1, 'retry mutation should emit one delta batch, not an empty terminal batch');
    assert.equal(yielded.at(-1).cursor.baselineStepCount, 1);
    assert.equal(yielded.at(-1).cursor.lastDeliveredStepCount, 2);
    assert.equal(yielded.at(-1).cursor.terminalSeen, true);
  });

  test('does not repeatedly fetch full trajectory on terminal resume without inline steps', async () => {
    const bridge = createBridge();
    let trajectoryFetches = 0;
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 3,
    }));
    mock.method(bridge, 'getTrajectorySteps', async () => {
      trajectoryFetches += 1;
      return [
        { type: 'CORTEX_STEP_TYPE_CHECKPOINT', status: 'DONE' },
        {
          type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
          status: 'DONE',
          plannerResponse: { modifiedResponse: 'already delivered' },
        },
        {
          type: 'CORTEX_STEP_TYPE_TOOL_CALL',
          status: 'DONE',
          toolCall: { toolName: 'search' },
        },
      ];
    });

    const yielded = [];
    for await (const batch of bridge.pollForSteps('cascade-1', 3, 200, 10)) {
      yielded.push(batch);
    }

    const last = yielded[yielded.length - 1];
    assert.equal(last.cursor.terminalSeen, true);
    assert.equal(last.cursor.lastDeliveredStepCount, 3);
    assert.equal(trajectoryFetches, 1, 'terminal resume should seed at most once, not poll full history repeatedly');
  });
});

// ── G8a: DeliveryCursor ────────────────────────────────────────────

describe('G8a: DeliveryCursor fields', () => {
  test('cursor has all four fields', async () => {
    const bridge = createBridge();
    let callCount = 0;
    mock.method(bridge, 'getTrajectory', async () => {
      callCount++;
      if (callCount === 1) {
        return {
          status: 'CASCADE_RUN_STATUS_RUNNING',
          numTotalSteps: 2,
          trajectory: {
            steps: [
              { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'DONE' },
              { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'DONE', plannerResponse: { response: 'hi' } },
            ],
          },
        };
      }
      return {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 2,
        trajectory: {
          steps: [
            { type: 'CORTEX_STEP_TYPE_USER_INPUT', status: 'DONE' },
            { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'DONE', plannerResponse: { response: 'hi' } },
          ],
        },
      };
    });

    const cursors = [];
    for await (const batch of bridge.pollForSteps('cascade-1', 0, 5000, 50)) {
      cursors.push(batch.cursor);
    }

    const cursor = cursors[0];
    assert.equal(typeof cursor.baselineStepCount, 'number');
    assert.equal(typeof cursor.lastDeliveredStepCount, 'number');
    assert.equal(typeof cursor.terminalSeen, 'boolean');
    assert.equal(typeof cursor.lastActivityAt, 'number');
    assert.equal(cursor.baselineStepCount, 0);
  });

  test('cursor tracks step progression correctly', async () => {
    const bridge = createBridge();
    let callCount = 0;
    const trajectories = [
      {
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 2,
        trajectory: {
          steps: [
            { type: 'A', status: 'D' },
            { type: 'B', status: 'D' },
          ],
        },
      },
      {
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 4,
        trajectory: {
          steps: [
            { type: 'A', status: 'D' },
            { type: 'B', status: 'D' },
            { type: 'C', status: 'D' },
            { type: 'D', status: 'D' },
          ],
        },
      },
      {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 4,
        trajectory: {
          steps: [
            { type: 'A', status: 'D' },
            { type: 'B', status: 'D' },
            { type: 'C', status: 'D' },
            { type: 'D', status: 'D' },
          ],
        },
      },
    ];
    mock.method(bridge, 'getTrajectory', async () => trajectories[callCount++]);

    const batches = [];
    for await (const batch of bridge.pollForSteps('cascade-1', 0, 5000, 50)) {
      batches.push(batch);
    }

    assert.equal(batches[0].cursor.lastDeliveredStepCount, 2);
    assert.equal(batches[0].steps.length, 2);
    assert.equal(batches[1].cursor.lastDeliveredStepCount, 4);
    assert.equal(batches[1].steps.length, 2);
    const last = batches[batches.length - 1];
    assert.equal(last.cursor.terminalSeen, true);
    assert.equal(last.cursor.lastDeliveredStepCount, 4);
  });
});

// ── Cloud P1: Stale IDLE race condition ──────────────────────────

describe('Cloud P1: stale IDLE must not drop real steps', () => {
  test('survives stale IDLE/0 then delivers steps after RUNNING', async () => {
    const bridge = createBridge();
    let callCount = 0;
    const trajectories = [
      { status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 0 },
      {
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 1,
        trajectory: {
          steps: [
            { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'DONE', plannerResponse: { response: 'hello' } },
          ],
        },
      },
      {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 1,
        trajectory: {
          steps: [
            { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'DONE', plannerResponse: { response: 'hello' } },
          ],
        },
      },
    ];
    mock.method(bridge, 'getTrajectory', async () => trajectories[callCount++]);

    const yielded = [];
    for await (const batch of bridge.pollForSteps('cascade-1', 0, 5000, 10)) {
      yielded.push(batch);
    }

    const stepsDelivered = yielded.flatMap((b) => b.steps);
    assert.ok(stepsDelivered.length >= 1, `must deliver the real step, got ${stepsDelivered.length}`);
    assert.equal(stepsDelivered[0].plannerResponse.response, 'hello');
  });
});

// ── Cloud P1-r3: extended stale IDLE (4+ polls) ─────────────────

describe('Cloud P1-r3: extended stale IDLE does not drop steps', () => {
  test('survives 3+ stale IDLE polls then delivers when RUNNING', async () => {
    const bridge = createBridge();
    let callCount = 0;
    const trajectories = [
      { status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 0 },
      { status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 0 },
      { status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 0 },
      {
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 1,
        trajectory: {
          steps: [
            { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'DONE', plannerResponse: { response: 'delayed' } },
          ],
        },
      },
      {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 1,
        trajectory: {
          steps: [
            { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'DONE', plannerResponse: { response: 'delayed' } },
          ],
        },
      },
    ];
    mock.method(bridge, 'getTrajectory', async () => trajectories[callCount++]);

    const yielded = [];
    for await (const batch of bridge.pollForSteps('cascade-1', 0, 5000, 10)) {
      yielded.push(batch);
    }

    const steps = yielded.flatMap((b) => b.steps);
    assert.ok(steps.length >= 1, `must deliver step after extended stale IDLE, got ${steps.length}`);
    assert.equal(steps[0].plannerResponse.response, 'delayed');
  });
});

// ── Cloud P1-r2: genuine terminal with no new steps ─────────────

describe('Cloud P1-r2: genuine empty terminal returns cleanly', () => {
  test('terminal with no new steps returns clean after idle timeout', async () => {
    const bridge = createBridge();
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_IDLE',
      numTotalSteps: 3,
    }));
    mock.method(bridge, 'getTrajectorySteps', async () => []);

    const yielded = [];
    for await (const batch of bridge.pollForSteps('cascade-1', 3, 200, 10)) {
      yielded.push(batch);
    }

    const last = yielded[yielded.length - 1];
    assert.equal(last.cursor.terminalSeen, true);
    assert.equal(last.cursor.lastDeliveredStepCount, 3);
  });
});

// ── G7: AbortSignal penetrates poll ────────────────────────────────

describe('G7: AbortSignal in pollForSteps', () => {
  test('aborts mid-poll when signal fires', async () => {
    const bridge = createBridge();
    mock.method(bridge, 'getTrajectory', async () => ({
      status: 'CASCADE_RUN_STATUS_RUNNING',
      numTotalSteps: 0,
    }));

    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);

    await assert.rejects(async () => {
      for await (const _ of bridge.pollForSteps('cascade-1', 0, 10000, 30, ac.signal)) {
        // consume
      }
    }, /abort/i);
  });
});

// ── Regression: thinking duplication on delta replay ──────────────

describe('thinking is stripped from delta replay steps', () => {
  test('replay step carries text delta but NOT thinking when response grows in place', async () => {
    const bridge = createBridge();
    let callCount = 0;
    const trajectories = [
      {
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 1,
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: {
                thinking: 'Let me analyze this carefully...',
                modifiedResponse: 'Hello',
              },
            },
          ],
        },
      },
      {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 1,
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: {
                thinking: 'Let me analyze this carefully...',
                modifiedResponse: 'Hello World',
              },
            },
          ],
        },
      },
    ];
    mock.method(bridge, 'getTrajectory', async () => trajectories[callCount++]);
    mock.method(bridge, 'getTrajectorySteps', async () => []);

    const yielded = [];
    for await (const batch of bridge.pollForSteps('cascade-1', 0, 5000, 50)) {
      yielded.push(batch);
    }

    assert.equal(yielded.length, 2, 'should emit initial + delta batch');

    // First batch: full delivery including thinking
    const firstStep = yielded[0].steps[0];
    assert.equal(firstStep.plannerResponse.thinking, 'Let me analyze this carefully...');
    assert.equal(firstStep.plannerResponse.modifiedResponse, 'Hello');

    // Second batch (delta replay): text delta only, NO thinking
    const replayStep = yielded[1].steps[0];
    assert.equal(replayStep.plannerResponse.modifiedResponse, ' World');
    assert.equal(
      replayStep.plannerResponse.thinking,
      undefined,
      'replay step must NOT carry thinking — it was already delivered in the first batch',
    );
  });

  test('replay step emits only the non-overlapping suffix for non-prefix rewrites', async () => {
    const bridge = createBridge();
    let callCount = 0;
    const trajectories = [
      {
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 1,
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: {
                modifiedResponse: '第一段。第二段。',
              },
            },
          ],
        },
      },
      {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 1,
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: {
                modifiedResponse: '第二段。第三段。',
              },
            },
          ],
        },
      },
    ];
    mock.method(bridge, 'getTrajectory', async () => trajectories[callCount++]);
    mock.method(bridge, 'getTrajectorySteps', async () => []);

    const yielded = [];
    for await (const batch of bridge.pollForSteps('cascade-1', 0, 5000, 50)) {
      yielded.push(batch);
    }

    assert.equal(yielded.length, 2, 'should emit initial + overlap-aware replay batch');
    const replayStep = yielded[1].steps[0];
    assert.equal(replayStep.plannerResponse.modifiedResponse, '第三段。');
  });

  test('non-prefix rewrite replays full corrected snapshot with replace mode', async () => {
    const bridge = createBridge();
    let callCount = 0;
    const trajectories = [
      {
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 1,
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: {
                modifiedResponse: '第一段。第二段。',
              },
            },
          ],
        },
      },
      {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 1,
        trajectory: {
          steps: [
            {
              type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
              status: 'DONE',
              plannerResponse: {
                modifiedResponse: '第一段。插入一句。第二段。',
              },
            },
          ],
        },
      },
    ];
    mock.method(bridge, 'getTrajectory', async () => trajectories[callCount++]);
    mock.method(bridge, 'getTrajectorySteps', async () => []);

    const yielded = [];
    for await (const batch of bridge.pollForSteps('cascade-1', 0, 5000, 50)) {
      yielded.push(batch);
    }

    assert.equal(yielded.length, 2, 'should emit initial + rewrite replay batch');
    const replayStep = yielded[1].steps[0];
    assert.equal(replayStep.plannerResponse.modifiedResponse, '第一段。插入一句。第二段。');
    assert.equal(replayStep.catCafeTextMode, 'replace');
  });
});
