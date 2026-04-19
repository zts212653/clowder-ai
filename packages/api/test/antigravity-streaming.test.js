import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import { AntigravityBridge } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityBridge.js';

function createBridge() {
  return new AntigravityBridge({ port: 1234, csrfToken: 'test', useTls: false });
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
              plannerResponse: { modifiedResponse: '铲屎官，我活着，' },
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
              plannerResponse: { modifiedResponse: '铲屎官，我活着，喵。' },
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
    assert.equal(yielded[0].steps[0].plannerResponse.modifiedResponse, '铲屎官，我活着，');
    assert.equal(yielded[0].cursor.terminalSeen, false);
    assert.equal(yielded[1].steps[0].plannerResponse.modifiedResponse, '喵。');
    assert.equal(yielded[1].cursor.lastDeliveredStepCount, 1);
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
});
