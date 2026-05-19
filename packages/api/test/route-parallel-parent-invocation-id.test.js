/**
 * #573 / opencode dup bubble regression:
 * route-parallel must persist messages with the OUTER parentInvocationId
 * (the socket broadcast identity from messages.ts), not the per-cat INNER
 * invocation_created id. Otherwise live/IDB bubbles use parent id while
 * server hydration uses per-cat id, producing duplicate bubbles after F5.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

function createMockService(catId, text) {
  return {
    async *invoke() {
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createMockDeps(services, appendCalls) {
  let invocationSeq = 0;
  let messageSeq = 0;
  const storedById = new Map();

  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inner-inv-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` }),
        verify: () => ({ ok: false, reason: 'unknown_invocation' }),
      },
      sessionManager: {
        get: async () => null,
        getOrCreate: async () => ({}),
        resolveWorkingDirectory: () => '/tmp/test',
      },
      threadStore: {
        get: async () => null,
        getParticipantsWithActivity: async () => [],
        updateParticipantActivity: async () => {},
      },
      apiUrl: 'http://127.0.0.1:3004',
    },
    messageStore: {
      append: async (msg) => {
        const stored = {
          id: `msg-${++messageSeq}`,
          ...msg,
          threadId: msg.threadId ?? 'default',
        };
        appendCalls.push(msg);
        storedById.set(stored.id, stored);
        return stored;
      },
      getById: async (id) => storedById.get(id) ?? null,
      getRecent: () => [],
      getMentionsFor: () => [],
      getRecentMentionsFor: () => [],
      getBefore: () => [],
      getByThread: () => [],
      getByThreadAfter: () => [],
      getByThreadBefore: () => [],
    },
    draftStore: {
      delete: () => Promise.resolve(),
      touch: () => Promise.resolve(),
      upsert: () => Promise.resolve(),
    },
    socketManager: {
      broadcastToRoom: () => {},
    },
  };
}

describe('F194 Phase Z2: route-parallel must propagate parentInvocationId to invokeSingleCat → registry.create', () => {
  it('registry.create receives parentInvocationId as 4th arg for every cat in parallel chain (砚砚 acceptance gap)', async () => {
    // F194 Phase Z2 (砚砚 catch 2026-05-09 17:09)：route-serial.ts:725 调 invokeSingleCat 传了
    // options.parentInvocationId，route-parallel.ts:399 漏传 → parallel/ideate 场景下 child registry
    // record 缺 parentInvocationId → helper namespace bridge 失效 → 又裂气泡。
    //
    // RED 测试：监听 registry.create 调用，断言每个 cat 的 child invocation create 都带 parentInvocationId。
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const outerParentInvocationId = 'cat-cafe-outer-z2-parent';
    const registryCreateCalls = [];

    // 自定 deps，spy registry.create 第 4 参数
    const services = {
      qwen: createMockService('qwen', 'qwen reply'),
      kimi: createMockService('kimi', 'kimi reply'),
    };
    let invocationSeq = 0;
    let messageSeq = 0;
    const storedById = new Map();
    const deps = {
      services,
      invocationDeps: {
        registry: {
          create: (userId, catId, threadId, parentInvocationId, a2aTriggerMessageId) => {
            registryCreateCalls.push({ userId, catId, threadId, parentInvocationId, a2aTriggerMessageId });
            return { invocationId: `inner-inv-${++invocationSeq}`, callbackToken: `tok-${invocationSeq}` };
          },
          verify: () => ({ ok: false, reason: 'unknown_invocation' }),
        },
        sessionManager: {
          get: async () => null,
          getOrCreate: async () => ({}),
          resolveWorkingDirectory: () => '/tmp/test',
        },
        threadStore: {
          get: async () => null,
          getParticipantsWithActivity: async () => [],
          updateParticipantActivity: async () => {},
        },
        apiUrl: 'http://127.0.0.1:3004',
      },
      messageStore: {
        append: async (msg) => {
          const stored = { id: `msg-${++messageSeq}`, ...msg, threadId: msg.threadId ?? 'default' };
          storedById.set(stored.id, stored);
          return stored;
        },
        getById: async (id) => storedById.get(id) ?? null,
        getRecent: () => [],
        getMentionsFor: () => [],
        getRecentMentionsFor: () => [],
        getBefore: () => [],
        getByThread: () => [],
        getByThreadAfter: () => [],
        getByThreadBefore: () => [],
      },
      draftStore: {
        delete: () => Promise.resolve(),
        touch: () => Promise.resolve(),
        upsert: () => Promise.resolve(),
      },
      socketManager: {
        broadcastToRoom: () => {},
      },
    };

    for await (const _msg of routeParallel(deps, ['qwen', 'kimi'], 'parallel hello', 'user1', 'thread1', {
      parentInvocationId: outerParentInvocationId,
    })) {
      // drain
    }

    // 每只 cat 至少一次 registry.create（child invocation 注册）
    assert.ok(registryCreateCalls.length >= 2, `expected ≥2 registry.create calls, got ${registryCreateCalls.length}`);
    for (const call of registryCreateCalls) {
      assert.equal(
        call.parentInvocationId,
        outerParentInvocationId,
        `${call.catId} registry.create must receive parentInvocationId='${outerParentInvocationId}' (4th arg) — was undefined when route-parallel.ts:399 漏传 options.parentInvocationId`,
      );
    }
  });

  it('persists each cat message with parentInvocationId when parent is provided', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const appendCalls = [];
    const outerParentInvocationId = 'cat-cafe-outer-parallel-123';
    const deps = createMockDeps(
      {
        qwen: createMockService('qwen', 'qwen reply'),
        kimi: createMockService('kimi', 'kimi reply'),
      },
      appendCalls,
    );

    for await (const _msg of routeParallel(deps, ['qwen', 'kimi'], 'parallel hello', 'user1', 'thread1', {
      parentInvocationId: outerParentInvocationId,
    })) {
      // drain
    }

    const agentAppends = appendCalls.filter((call) => call.catId && call.origin === 'stream');
    assert.equal(agentAppends.length, 2, 'one persisted message per cat');
    for (const call of agentAppends) {
      assert.equal(
        call.extra?.stream?.invocationId,
        outerParentInvocationId,
        `${call.catId} persisted record must use OUTER parentInvocationId`,
      );
      assert.doesNotMatch(
        call.extra?.stream?.invocationId ?? '',
        /^inner-inv-/,
        `${call.catId} must not persist the per-cat invocation_created id`,
      );
    }
  });
});
