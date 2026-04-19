import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import { AntigravityBridge } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityBridge.js';

function createBridge() {
  return new AntigravityBridge({ port: 1234, csrfToken: 'test', useTls: false });
}

// ── G5: Dynamic model discovery ────────────────────────────────────

describe('G5: dynamic model map from GetUserStatus', () => {
  test('refreshModelMap populates from cascadeModelConfigData', async () => {
    const bridge = createBridge();
    // Mock the rpc call to return model config
    const mockConfigData = [
      { modelId: 'MODEL_PLACEHOLDER_M99', displayName: 'gemini-4-ultra' },
      { modelId: 'MODEL_PLACEHOLDER_M100', displayName: 'claude-opus-5' },
    ];
    mock.method(bridge, 'rpc', async (_conn, method) => {
      if (method === 'GetUserStatus') {
        return { cascadeModelConfigData: mockConfigData };
      }
      return {};
    });
    // Force connection so rpc works
    await bridge.ensureConnected();

    await bridge.refreshModelMap();

    assert.equal(bridge.resolveModelId('gemini-4-ultra'), 'MODEL_PLACEHOLDER_M99');
    assert.equal(bridge.resolveModelId('claude-opus-5'), 'MODEL_PLACEHOLDER_M100');
  });

  test('ensureConnected triggers refreshModelMap on first connection', async () => {
    const bridge = createBridge();
    const mockConfigData = [{ modelId: 'MODEL_NEW_1', displayName: 'future-model' }];
    mock.method(bridge, 'rpc', async (_conn, method) => {
      if (method === 'GetUserStatus') {
        return { cascadeModelConfigData: mockConfigData };
      }
      return {};
    });

    await bridge.ensureConnected();

    assert.equal(bridge.resolveModelId('future-model'), 'MODEL_NEW_1');
    assert.equal(bridge.resolveModelId('gemini-3.1-pro'), 'MODEL_PLACEHOLDER_M37');
  });

  test('falls back to hardcoded map when GetUserStatus fails', async () => {
    const bridge = createBridge();
    mock.method(bridge, 'rpc', async () => {
      throw new Error('connection refused');
    });
    await bridge.ensureConnected();

    await bridge.refreshModelMap();

    // Should still have hardcoded entries
    assert.equal(bridge.resolveModelId('gemini-3.1-pro'), 'MODEL_PLACEHOLDER_M37');
  });
});

// ── G6: Connection self-healing ────────────────────────────────────

describe('G6: connection invalidation and reconnect', () => {
  test('invalidateConnection clears cached connection', async () => {
    const bridge = createBridge();
    const conn1 = await bridge.ensureConnected();
    assert.ok(conn1.port);

    bridge.invalidateConnection();

    // After invalidation, ensureConnected should re-discover
    // (with explicit config, it just re-creates from constructor args)
    const conn2 = await bridge.ensureConnected();
    assert.ok(conn2.port);
  });

  test('getOrCreateSession rejects RUNNING cascade and creates new', async () => {
    const bridge = createBridge();
    const startCalls = [];
    mock.method(bridge, 'getTrajectory', async (cascadeId) => {
      if (cascadeId === 'stuck-cascade') {
        return { status: 'CASCADE_RUN_STATUS_RUNNING', numTotalSteps: 7 };
      }
      return { status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 0 };
    });
    mock.method(bridge, 'startCascade', async () => {
      startCalls.push(1);
      return 'fresh-cascade';
    });
    // Pre-seed the session map with a stuck cascade
    bridge.sessionMap.set('thread-1:cat-1', 'stuck-cascade');
    bridge.sessionMapLoaded = true;

    const result = await bridge.getOrCreateSession('thread-1', 'cat-1');

    assert.equal(result, 'fresh-cascade', 'should create new cascade, not reuse stuck one');
    assert.equal(startCalls.length, 1, 'should have called startCascade');
  });

  test('getOrCreateSession reuses IDLE cascade', async () => {
    const bridge = createBridge();
    mock.method(bridge, 'getTrajectory', async () => {
      return { status: 'CASCADE_RUN_STATUS_IDLE', numTotalSteps: 5 };
    });
    bridge.sessionMap.set('thread-2:cat-2', 'idle-cascade');
    bridge.sessionMapLoaded = true;

    const result = await bridge.getOrCreateSession('thread-2', 'cat-2');

    assert.equal(result, 'idle-cascade', 'should reuse IDLE cascade');
  });

  test('pollForSteps invalidates connection on RPC error then retries', async () => {
    const bridge = createBridge();
    let callCount = 0;

    mock.method(bridge, 'getTrajectory', async () => {
      callCount++;
      if (callCount === 1) throw new Error('LS disconnected');
      return {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 1,
        trajectory: {
          steps: [
            { type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE', status: 'D', plannerResponse: { response: 'recovered' } },
          ],
        },
      };
    });

    const batches = [];
    for await (const batch of bridge.pollForSteps('cascade-1', 0, 5000, 50)) {
      batches.push(batch);
    }

    assert.ok(batches.length >= 1, 'should recover and yield steps');
    assert.equal(batches[0].steps[0].plannerResponse.response, 'recovered');
  });
});
