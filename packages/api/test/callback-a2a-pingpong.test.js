/**
 * F167 L1 AC-A4: callback-a2a-trigger 也必须消费 streak 熔断。
 *
 * 场景：worklist 已有 streak=3（opus↔codex × 3 pushes），第 4 轮通过 callback-a2a 触发 →
 * enqueueA2ATargets 必须：
 *   1. 不 enqueue（result.enqueued=[]）
 *   2. 广播 `a2a_pingpong_terminated` system_info（与 route-serial 路径格式对齐）
 *
 * 注意：为了走 legacy worklist 分支（pushToWorklist 触发路径），
 * test 必须 invocationQueue=undefined + 预先 registerWorklist（模拟 route-serial 正在跑）。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';

async function loadRealRoster() {
  const { loadCatConfig, toAllCatConfigs } = await import('../dist/config/cat-config-loader.js');
  const runtimeConfigs = toAllCatConfigs(loadCatConfig());
  catRegistry.reset();
  for (const [id, config] of Object.entries(runtimeConfigs)) {
    catRegistry.register(id, config);
  }
}

function createMockSocketManager() {
  const broadcasts = [];
  return {
    broadcasts,
    emitToUser() {},
    broadcastToRoom() {},
    broadcastAgentMessage(msg) {
      broadcasts.push(msg);
    },
  };
}

function createMockLog() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

describe('F167 L1 AC-A4: callback-a2a-trigger ping-pong circuit breaker', () => {
  test('streak=4 via callback (worklist path) → not enqueued + emit a2a_pingpong_terminated', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
      const { registerWorklist, unregisterWorklist, pushToWorklist } = await import(
        '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
      );

      const threadId = 'thread-cb-pp-block';
      // Simulate route-serial registering worklist at start with opus as the first cat.
      const entry = registerWorklist(threadId, ['opus'], 20);
      try {
        // Preload 3 rounds of ping-pong (opus↔codex) to bring streak to 3.
        pushToWorklist(threadId, ['codex'], 'opus'); // streak=1
        entry.executedIndex = 1;
        pushToWorklist(threadId, ['opus'], 'codex'); // streak=2 (warn)
        entry.executedIndex = 2;
        pushToWorklist(threadId, ['codex'], 'opus'); // streak=3 (warn)
        entry.executedIndex = 3; // now codex is current — ready to push opus (round 4)

        const socketManager = createMockSocketManager();
        const result = await enqueueA2ATargets(
          {
            router: null,
            invocationRecordStore: null,
            socketManager,
            invocationQueue: undefined, // force legacy worklist path
            invocationTracker: undefined,
            queueProcessor: undefined,
            log: createMockLog(),
          },
          {
            targetCats: ['opus'],
            content: '@opus 再确认一下',
            userId: 'user1',
            threadId,
            triggerMessage: {
              id: 'msg-cb-4',
              userId: 'user1',
              catId: 'codex',
              content: '@opus 再确认一下',
              mentions: ['opus'],
              timestamp: Date.now(),
            },
            callerCatId: 'codex',
          },
        );

        assert.deepStrictEqual(result.enqueued, [], 'streak=4 via callback must not enqueue');
        assert.strictEqual(result.fallback, false, 'blocked push must not fall through to standalone');

        const terminated = socketManager.broadcasts.find(
          (m) =>
            m.type === 'system_info' && typeof m.content === 'string' && m.content.includes('a2a_pingpong_terminated'),
        );
        assert.ok(terminated, 'callback path must broadcast a2a_pingpong_terminated system_info');
        const parsed = JSON.parse(terminated.content);
        assert.strictEqual(parsed.type, 'a2a_pingpong_terminated');
        assert.strictEqual(parsed.fromCatId, 'codex');
        assert.strictEqual(parsed.targetCatId, 'opus');
        assert.ok(parsed.pairCount >= 4, `pairCount must be >=4, got ${parsed.pairCount}`);
      } finally {
        unregisterWorklist(threadId, entry);
      }
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('streak=4 via callback (MODERN invocationQueue path) → not enqueued + emit a2a_pingpong_terminated (P1-1)', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
      const { registerWorklist, unregisterWorklist, pushToWorklist } = await import(
        '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
      );
      const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');

      const threadId = 'thread-cb-pp-block-modern';
      const entry = registerWorklist(threadId, ['opus'], 20);
      try {
        // Preload 3 rounds of ping-pong (opus↔codex) on the worklist (route-serial-style).
        pushToWorklist(threadId, ['codex'], 'opus');
        entry.executedIndex = 1;
        pushToWorklist(threadId, ['opus'], 'codex');
        entry.executedIndex = 2;
        pushToWorklist(threadId, ['codex'], 'opus');
        entry.executedIndex = 3; // streak=3, next 1:1 push should trip block threshold

        // Real InvocationQueue wired in — forces MODERN path (not forced undefined).
        const invocationQueue = new InvocationQueue();

        const socketManager = createMockSocketManager();
        const result = await enqueueA2ATargets(
          {
            router: null,
            invocationRecordStore: null,
            socketManager,
            invocationQueue,
            invocationTracker: undefined,
            queueProcessor: undefined,
            log: createMockLog(),
          },
          {
            targetCats: ['opus'],
            content: '@opus 第四轮',
            userId: 'user1',
            threadId,
            triggerMessage: {
              id: 'msg-cb-modern-4',
              userId: 'user1',
              catId: 'codex',
              content: '@opus 第四轮',
              mentions: ['opus'],
              timestamp: Date.now(),
            },
            callerCatId: 'codex',
          },
        );

        assert.deepStrictEqual(result.enqueued, [], 'modern path streak=4 must not enqueue');
        assert.strictEqual(result.fallback, false);

        const terminated = socketManager.broadcasts.find(
          (m) =>
            m.type === 'system_info' && typeof m.content === 'string' && m.content.includes('a2a_pingpong_terminated'),
        );
        assert.ok(terminated, 'modern invocationQueue path must broadcast a2a_pingpong_terminated system_info');
        const parsed = JSON.parse(terminated.content);
        assert.strictEqual(parsed.type, 'a2a_pingpong_terminated');
        assert.strictEqual(parsed.fromCatId, 'codex');
        assert.strictEqual(parsed.targetCatId, 'opus');
        assert.ok(parsed.pairCount >= 4, `pairCount must be >=4, got ${parsed.pairCount}`);

        // Defense-in-depth: the blocked target must NOT appear in invocationQueue.
        const queued = invocationQueue.list(threadId, 'user1');
        const hasBlockedCat = queued.some((e) => e.targetCats?.includes('opus'));
        assert.ok(!hasBlockedCat, 'blocked target must not be enqueued into InvocationQueue');
      } finally {
        unregisterWorklist(threadId, entry);
      }
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('streak<4 via callback (normal push) → enqueues + no terminated broadcast', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
      const { registerWorklist, unregisterWorklist } = await import(
        '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
      );

      const threadId = 'thread-cb-pp-ok';
      const entry = registerWorklist(threadId, ['opus'], 20);
      try {
        const socketManager = createMockSocketManager();
        const result = await enqueueA2ATargets(
          {
            router: null,
            invocationRecordStore: null,
            socketManager,
            invocationQueue: undefined,
            invocationTracker: undefined,
            queueProcessor: undefined,
            log: createMockLog(),
          },
          {
            targetCats: ['codex'],
            content: '@codex 帮忙看看',
            userId: 'user1',
            threadId,
            triggerMessage: {
              id: 'msg-cb-1',
              userId: 'user1',
              catId: 'opus',
              content: '@codex 帮忙看看',
              mentions: ['codex'],
              timestamp: Date.now(),
            },
            callerCatId: 'opus',
          },
        );

        assert.deepStrictEqual(result.enqueued, ['codex'], 'first push must enqueue normally');
        const terminated = socketManager.broadcasts.find(
          (m) =>
            m.type === 'system_info' && typeof m.content === 'string' && m.content.includes('a2a_pingpong_terminated'),
        );
        assert.ok(!terminated, 'normal push must not broadcast a2a_pingpong_terminated');
      } finally {
        unregisterWorklist(threadId, entry);
      }
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });
});
