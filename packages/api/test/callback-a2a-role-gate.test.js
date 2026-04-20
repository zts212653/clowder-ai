/**
 * F167 L3 AC-A7: role-gate must also cover the callback-a2a-trigger path.
 *
 * Regression for codex review P1-2: without gating the callback path, designer + coding
 * handoffs bypass L3 entirely (route-serial gate only catches the text-scan path).
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

function createMockInvocationQueue() {
  const enqueued = [];
  return {
    enqueued,
    enqueue(entry) {
      enqueued.push(entry);
      return { outcome: 'enqueued', entry: { id: `entry-${enqueued.length}`, createdAt: Date.now() } };
    },
    countAgentEntriesForThread() {
      return 0;
    },
    hasQueuedAgentForCat() {
      return false;
    },
    backfillMessageId() {},
    appendMergedMessageId() {},
    list() {
      return [];
    },
  };
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

describe('F167 L3: callback-a2a-trigger role-gate integration', () => {
  test('designer (gemini) + coding handoff via callback → NOT enqueued + a2a_role_rejected broadcast', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
      const invocationQueue = createMockInvocationQueue();
      const socketManager = createMockSocketManager();

      const result = await enqueueA2ATargets(
        {
          router: null,
          invocationRecordStore: null,
          socketManager,
          invocationQueue,
          log: createMockLog(),
        },
        {
          targetCats: ['gemini'],
          content: '@gemini fix 这个 bug',
          userId: 'user1',
          threadId: 'thread-cb-rg1',
          triggerMessage: {
            id: 'msg-1',
            userId: 'user1',
            catId: 'opus',
            content: '@gemini fix 这个 bug',
            mentions: ['gemini'],
            timestamp: Date.now(),
          },
          callerCatId: 'opus',
        },
      );

      assert.strictEqual(
        invocationQueue.enqueued.length,
        0,
        'designer cat must NOT be enqueued for coding handoff via callback',
      );
      assert.ok(!result.enqueued.includes('gemini'), 'result.enqueued must not contain the rejected target');
      const rejected = socketManager.broadcasts.find(
        (m) => m.type === 'system_info' && typeof m.content === 'string' && m.content.includes('a2a_role_rejected'),
      );
      assert.ok(rejected, 'callback path must broadcast a2a_role_rejected system_info');
      assert.match(rejected.content, /gemini/);
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('non-designer (codex) + coding via callback → allowed (enqueued normally)', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
      const invocationQueue = createMockInvocationQueue();
      const socketManager = createMockSocketManager();

      const result = await enqueueA2ATargets(
        {
          router: null,
          invocationRecordStore: null,
          socketManager,
          invocationQueue,
          log: createMockLog(),
        },
        {
          targetCats: ['codex'],
          content: '@codex 去 fix 一下',
          userId: 'user1',
          threadId: 'thread-cb-rg2',
          triggerMessage: {
            id: 'msg-2',
            userId: 'user1',
            catId: 'opus',
            content: '@codex 去 fix 一下',
            mentions: ['codex'],
            timestamp: Date.now(),
          },
          callerCatId: 'opus',
        },
      );

      assert.strictEqual(invocationQueue.enqueued.length, 1, 'non-designer must be enqueued');
      assert.ok(result.enqueued.includes('codex'));
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('standalone fallback (no invocationQueue + no worklist) must also apply role-gate filter (cloud P1)', async () => {
    // Cloud codex review P1: enqueueA2ATargets filters targetCats at the top, but the standalone
    // fallback at line 314 calls triggerA2AInvocation(deps, opts) using UNFILTERED opts.targetCats.
    // Regression: designer cat bypasses filter via the legacy fallback path.
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
      const socketManager = createMockSocketManager();
      const createdTargets = [];
      const invocationRecordStore = {
        create({ targetCats }) {
          createdTargets.push([...targetCats]);
          return { outcome: 'created', invocationId: `inv-${createdTargets.length}` };
        },
        update() {},
      };
      const router = {
        async *routeExecution() {
          // Empty generator — we only care about invocationRecordStore.create args.
        },
      };

      const result = await enqueueA2ATargets(
        {
          router,
          invocationRecordStore,
          socketManager,
          invocationQueue: undefined,
          invocationTracker: undefined,
          queueProcessor: undefined,
          log: createMockLog(),
        },
        {
          targetCats: ['gemini', 'codex'],
          content: '@gemini @codex fix 这个 bug',
          userId: 'user1',
          threadId: 'thread-cb-rg4',
          triggerMessage: {
            id: 'msg-4',
            userId: 'user1',
            catId: 'opus',
            content: '@gemini @codex fix 这个 bug',
            mentions: ['gemini', 'codex'],
            timestamp: Date.now(),
          },
          callerCatId: 'opus',
        },
      );

      // Give the fire-and-forget invocation a tick to call invocationRecordStore.create.
      await new Promise((resolve) => setTimeout(resolve, 10));

      assert.ok(!result.enqueued.includes('gemini'), 'result.enqueued must not contain rejected designer');
      assert.strictEqual(createdTargets.length, 1, 'exactly one standalone invocation should be created');
      assert.deepStrictEqual(
        createdTargets[0],
        ['codex'],
        'standalone fallback must receive FILTERED targetCats (cloud P1: opts.targetCats bypasses filter)',
      );
      const rejected = socketManager.broadcasts.find(
        (m) => m.type === 'system_info' && typeof m.content === 'string' && m.content.includes('a2a_role_rejected'),
      );
      assert.ok(rejected, 'standalone fallback path must still broadcast a2a_role_rejected');
      assert.match(rejected.content, /gemini/);
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });

  test('designer (gemini) + design review via callback → allowed (no coding keyword)', async () => {
    const original = catRegistry.getAllConfigs();
    await loadRealRoster();
    try {
      const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
      const invocationQueue = createMockInvocationQueue();
      const socketManager = createMockSocketManager();

      const result = await enqueueA2ATargets(
        {
          router: null,
          invocationRecordStore: null,
          socketManager,
          invocationQueue,
          log: createMockLog(),
        },
        {
          targetCats: ['gemini'],
          content: '@gemini review 一下配色',
          userId: 'user1',
          threadId: 'thread-cb-rg3',
          triggerMessage: {
            id: 'msg-3',
            userId: 'user1',
            catId: 'opus',
            content: '@gemini review 一下配色',
            mentions: ['gemini'],
            timestamp: Date.now(),
          },
          callerCatId: 'opus',
        },
      );

      assert.strictEqual(invocationQueue.enqueued.length, 1, 'designer must be enqueued for non-coding handoff');
      assert.ok(result.enqueued.includes('gemini'));
    } finally {
      catRegistry.reset();
      for (const [id, config] of Object.entries(original)) {
        catRegistry.register(id, config);
      }
    }
  });
});
