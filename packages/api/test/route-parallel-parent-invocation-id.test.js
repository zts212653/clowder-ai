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

describe('#573: route-parallel parentInvocationId vs per-cat invocationId', () => {
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
