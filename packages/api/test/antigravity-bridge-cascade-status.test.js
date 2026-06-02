import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, mock, test } from 'node:test';
import { AntigravityBridge } from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityBridge.js';

function tempStorePath() {
  return path.join(os.tmpdir(), `antigravity-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function createBridge(rpcImpl) {
  const bridge = new AntigravityBridge(
    { port: 1234, csrfToken: 'test', useTls: false },
    { sessionStorePath: tempStorePath() },
  );
  mock.method(bridge, 'ensureConnected', async () => ({ port: 1234, csrfToken: 'test', useTls: false }));
  Object.getPrototypeOf(bridge).rpc = rpcImpl;
  return bridge;
}

describe('F211-REG9: getCascadeStatus — cheap poll change-signal', () => {
  test('uses the lightweight GetAllCascadeTrajectories summary (NOT the ~4MB GetCascadeTrajectory) and extracts the change-signal', async () => {
    let usedMethod;
    const bridge = createBridge(async (_conn, method) => {
      usedMethod = method;
      return {
        trajectorySummaries: {
          'cascade-A': {
            stepCount: 357,
            status: 'CASCADE_RUN_STATUS_IDLE',
            lastModifiedTime: '2026-05-30T16:11:10.709994Z',
            trajectoryId: 'tA',
          },
          'cascade-B': { stepCount: 5, status: 'CASCADE_RUN_STATUS_RUNNING', lastModifiedTime: '2026-05-31T01:00:00Z' },
        },
      };
    });
    const s = await bridge.getCascadeStatus('cascade-A');
    assert.equal(usedMethod, 'GetAllCascadeTrajectories', 'must use the lightweight summary RPC');
    assert.deepEqual(s, {
      stepCount: 357,
      status: 'CASCADE_RUN_STATUS_IDLE',
      lastModifiedTime: '2026-05-30T16:11:10.709994Z',
    });
  });

  test('returns null when the cascade is absent — caller must fall back to a full fetch, not assume "no change"', async () => {
    const bridge = createBridge(async () => ({ trajectorySummaries: { other: { stepCount: 1 } } }));
    assert.equal(await bridge.getCascadeStatus('missing'), null);
  });

  test('tolerates missing/garbage summary fields (stepCount→0, status/time→undefined)', async () => {
    const bridge = createBridge(async () => ({ trajectorySummaries: { c: { status: 123, lastModifiedTime: 5 } } }));
    assert.deepEqual(await bridge.getCascadeStatus('c'), {
      stepCount: 0,
      status: undefined,
      lastModifiedTime: undefined,
    });
  });
});
