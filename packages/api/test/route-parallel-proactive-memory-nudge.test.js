import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

function createCapturingService(catId) {
  const prompts = [];
  return {
    prompts,
    async *invoke(prompt) {
      prompts.push(prompt);
      yield { type: 'text', catId, content: `${catId} reply`, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

function createDeps(services, proactiveMemoryNudgeService) {
  let sequence = 0;
  const storedById = new Map();
  return {
    services,
    invocationDeps: {
      registry: {
        create: () => ({ invocationId: `inv-${++sequence}`, callbackToken: `tok-${sequence}` }),
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
      append: async (message) => {
        const stored = {
          id: `msg-${++sequence}`,
          ...message,
          threadId: message.threadId ?? 'default',
        };
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
    socketManager: { broadcastToRoom: () => {} },
    proactiveMemoryNudgeService,
  };
}

describe('F282 Phase A: parallel proactive-memory carrier', () => {
  test('every in-scene cat receives one lane-neutral carrier and the receipt finalizes once', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const opus = createCapturingService('opus');
    const codex = createCapturingService('codex');
    const prepared = {
      context:
        '\n[proactive-memory-candidate]\n' +
        '以下仅为机械重复统计；未分类，也未判断重要性：\n' +
        '- 「Alden」: 2 threads / 3 messages\n' +
        '  ↳ thread-a#message-a | thread-b#message-b,message-c\n' +
        '[/proactive-memory-candidate]',
      candidates: [],
      claimIds: ['claim-parallel'],
    };
    let delivered = false;
    let finalizeCalls = 0;
    const proactiveMemoryNudgeService = {
      prepare: async (input) => {
        assert.deepEqual(input, {
          ownerUserId: 'owner-1',
          currentUserMessageId: 'message-current',
        });
        return prepared;
      },
      finalize: (received) => {
        assert.equal(received, prepared);
        finalizeCalls += 1;
        if (delivered) return 0;
        delivered = true;
        return 1;
      },
    };
    const deps = createDeps({ opus, codex }, proactiveMemoryNudgeService);

    for await (const _event of routeParallel(deps, ['opus', 'codex'], 'Alden', 'owner-1', 'thread-current', {
      currentUserMessageId: 'message-current',
    })) {
      // Drain both streams.
    }

    for (const service of [opus, codex]) {
      assert.equal(service.prompts.length, 1);
      const prompt = service.prompts[0];
      assert.equal(prompt.includes('[proactive-memory-candidate]'), true);
      assert.equal(prompt.includes('Alden'), true);
      assert.equal(prompt.includes('[registration-candidate]'), false);
      assert.equal(prompt.includes('propose_entity'), false);
    }
    assert.equal(finalizeCalls, 2, 'parallel cats share one prepared carrier and each reaches prompt assembly');
    assert.equal(delivered, true, 'the shared receipt has one successful idempotent delivery transition');
  });
});
