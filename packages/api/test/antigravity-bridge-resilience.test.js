import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { describe, mock, test } from 'node:test';
import {
  AntigravityBridge,
  antigravityRpcTimeoutMs,
} from '../dist/domains/cats/services/agents/providers/antigravity/AntigravityBridge.js';

function createBridge() {
  return new AntigravityBridge({ port: 1234, csrfToken: 'test', useTls: false });
}

async function listenOnEphemeralPort(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert.equal(typeof address, 'object');
  return address.port;
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
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
  test('RunCommand RPC request timeout follows controlled command timeout with buffer', () => {
    assert.equal(antigravityRpcTimeoutMs('GetTrajectory', {}), 30_000);
    assert.equal(
      antigravityRpcTimeoutMs('RunCommand', { command: 'sleep 45', cwd: '/tmp', timeoutMs: 45_000 }),
      50_000,
    );
    assert.equal(antigravityRpcTimeoutMs('RunCommand', { command: 'echo hi', cwd: '/tmp', timeoutMs: 10 }), 30_000);
    assert.equal(antigravityRpcTimeoutMs('RunCommand', { command: 'echo hi', cwd: '/tmp', timeoutMs: 0.5 }), 30_000);
    assert.equal(
      antigravityRpcTimeoutMs('RunCommand', { command: 'echo hi', cwd: '/tmp', timeoutMs: 3_000_000_000 }),
      30_000,
    );
    assert.equal(
      antigravityRpcTimeoutMs('RunCommand', { command: 'echo hi', cwd: '/tmp', timeoutMs: Infinity }),
      30_000,
    );
  });

  test('callRpc abort signal closes an in-flight RunCommand HTTP request', async () => {
    let runCommandStarted;
    let runCommandClosed;
    const started = new Promise((resolve) => {
      runCommandStarted = resolve;
    });
    const closed = new Promise((resolve) => {
      runCommandClosed = resolve;
    });
    const server = http.createServer((req, res) => {
      if (req.url?.endsWith('/GetUserStatus')) {
        req.resume();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ cascadeModelConfigData: [] }));
        return;
      }
      if (req.url?.endsWith('/RunCommand')) {
        runCommandStarted();
        req.on('close', runCommandClosed);
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });

    try {
      const port = await listenOnEphemeralPort(server);
      const bridge = new AntigravityBridge({ port, csrfToken: 'test', useTls: false });
      const controller = new AbortController();
      const request = bridge.callRpc(
        'RunCommand',
        { command: 'sleep 999', cwd: '/tmp', timeoutMs: 10_000 },
        { signal: controller.signal },
      );

      await started;
      controller.abort(new Error('abort probe'));

      await assert.rejects(request, /abort probe/);
      await closed;
    } finally {
      await closeServer(server);
    }
  });

  test('callRpc attaches request error listener before abort-race destroy', async () => {
    const bridge = createBridge();
    bridge.modelMapRefreshed = true;
    let destroyedBeforeErrorListener = false;

    class FakeRequest extends EventEmitter {
      write() {}
      end() {}
      destroy() {
        if (this.listenerCount('error') === 0) {
          destroyedBeforeErrorListener = true;
        }
      }
    }

    const requestMock = mock.method(http, 'request', () => new FakeRequest());
    const signal = {
      aborted: false,
      reason: new Error('abort race'),
      addEventListener() {
        this.aborted = true;
      },
      removeEventListener() {},
    };

    try {
      await assert.rejects(
        () => bridge.callRpc('RunCommand', { command: 'sleep 999', cwd: '/tmp', timeoutMs: 10_000 }, { signal }),
        /abort race/,
      );
      assert.equal(
        destroyedBeforeErrorListener,
        false,
        'request error listener must be attached before abort-race destroy',
      );
    } finally {
      requestMock.mock.restore();
    }
  });

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

  test('startCascade auto-recovers on ECONNREFUSED via rpcSafe', async () => {
    const bridge = createBridge();
    let rpcCallCount = 0;

    mock.method(bridge, 'rpc', async (_conn, method) => {
      rpcCallCount++;
      if (rpcCallCount === 1 && method === 'StartCascade') {
        throw new Error('connect ECONNREFUSED 127.0.0.1:62743');
      }
      if (method === 'GetUserStatus') return { cascadeModelConfigData: [] };
      if (method === 'StartCascade') return { cascadeId: 'recovered-cascade' };
      return {};
    });

    const cascadeId = await bridge.startCascade();
    assert.equal(cascadeId, 'recovered-cascade', 'should recover after ECONNREFUSED');
    assert.ok(rpcCallCount >= 2, 'should have retried the RPC');
  });

  test('rpcSafe does NOT retry on non-connection errors', async () => {
    const bridge = createBridge();
    mock.method(bridge, 'rpc', async (_conn, method) => {
      if (method === 'GetUserStatus') return { cascadeModelConfigData: [] };
      throw new Error('LS StartCascade: 500 — internal server error');
    });

    await assert.rejects(
      () => bridge.startCascade(),
      /500 — internal server error/,
      'non-connection errors should propagate without retry',
    );
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

  test('pollForSteps surfaces terminal idle before timestamp heartbeat', async () => {
    const bridge = createBridge();
    let now = 0;
    let callCount = 0;

    mock.method(Date, 'now', () => now);
    mock.method(bridge, 'getTrajectory', async () => {
      callCount++;
      if (callCount === 1) {
        return {
          status: 'CASCADE_RUN_STATUS_RUNNING',
          numTotalSteps: 0,
          updatedAt: 100,
        };
      }
      now = 2;
      return {
        status: 'CASCADE_RUN_STATUS_IDLE',
        numTotalSteps: 0,
        updatedAt: 100 + callCount,
      };
    });

    const iterator = bridge.pollForSteps('cascade-terminal-heartbeat', 0, 1, 0);
    const first = await iterator.next();
    await iterator.return?.();

    assert.equal(first.done, false);
    assert.equal(
      first.value.cursor.terminalSeen,
      true,
      'terminal completion must not be masked by timestamp heartbeat',
    );
    assert.equal(first.value.steps.length, 0);
    assert.ok(callCount >= 2);
  });

  test('pollForSteps bounds non-terminal timestamp heartbeat by idle timeout', async () => {
    const bridge = createBridge();
    let now = 0;
    let callCount = 0;

    mock.method(Date, 'now', () => now);
    mock.method(bridge, 'getTrajectory', async () => {
      callCount++;
      now += 10;
      return {
        status: 'CASCADE_RUN_STATUS_RUNNING',
        numTotalSteps: 0,
        updatedAt: now,
      };
    });

    const iterator = bridge.pollForSteps('cascade-running-heartbeat', 0, 25, 0);
    const heartbeat = await iterator.next();

    assert.equal(heartbeat.done, false);
    assert.equal(heartbeat.value.cursor.livenessEvidence?.kind, 'trajectory_timestamp_progress');

    await assert.rejects(
      () => iterator.next(),
      /Antigravity stall: no activity/,
      'timestamp-only heartbeat must not keep non-terminal cascades alive forever',
    );
    await iterator.return?.();
    assert.ok(callCount >= 3);
  });
});
