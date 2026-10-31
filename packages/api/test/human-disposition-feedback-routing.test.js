import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const FEEDBACK_CONTEXT =
  '\n[human-disposition-feedback]\n' +
  '- scope=exact_subject reason=bad_evidence correction=verify_source\n' +
  '[/human-disposition-feedback]';
const PROACTIVE_CONTEXT = '\n[proactive-memory-candidate]\n- Alden\n[/proactive-memory-candidate]';

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

function createDeps(services, feedbackService, proactiveMemoryNudgeService) {
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
        consumeMentionRoutingFeedback: async () => null,
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
      delete: async () => {},
      touch: async () => {},
      upsert: async () => {},
    },
    socketManager: { broadcastToRoom: () => {} },
    humanDispositionFeedbackContextService: feedbackService,
    ...(proactiveMemoryNudgeService ? { proactiveMemoryNudgeService } : {}),
  };
}

async function drain(iterable) {
  for await (const _event of iterable) {
    // Drain the route.
  }
}

describe('F281 Phase C: bounded feedback routing carrier', () => {
  test('direct-owner serial appends one block after other route-level context in legacy and incremental modes', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');

    for (const currentUserMessageId of [undefined, 'message-current']) {
      const opus = createCapturingService('opus');
      const prepareInputs = [];
      const deps = createDeps(
        { opus },
        {
          prepare: async (input) => {
            prepareInputs.push(input);
            return FEEDBACK_CONTEXT;
          },
        },
        currentUserMessageId
          ? {
              prepare: async () => ({ context: PROACTIVE_CONTEXT, candidates: [], claimIds: ['claim-1'] }),
              finalize: () => 1,
            }
          : undefined,
      );

      await drain(
        routeSerial(deps, ['opus'], '周玉晶最近怎么样', 'owner-1', 'thread-1', {
          humanDispositionInvocationOrigin: 'direct_owner',
          ...(currentUserMessageId ? { currentUserMessageId } : {}),
        }),
      );

      assert.deepEqual(prepareInputs, [{ ownerUserId: 'owner-1', text: '周玉晶最近怎么样' }]);
      assert.equal(opus.prompts.length, 1);
      assert.equal(opus.prompts[0].split('[human-disposition-feedback]').length - 1, 1);
      if (currentUserMessageId) {
        assert.ok(
          opus.prompts[0].indexOf('[proactive-memory-candidate]') <
            opus.prompts[0].indexOf('[human-disposition-feedback]'),
        );
      }
    }
  });

  test('direct-owner parallel prepares once and gives the same block to every cat', async () => {
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const opus = createCapturingService('opus');
    const codex = createCapturingService('codex');
    let calls = 0;
    const deps = createDeps(
      { opus, codex },
      {
        prepare: async () => {
          calls += 1;
          return FEEDBACK_CONTEXT;
        },
      },
    );

    await drain(
      routeParallel(deps, ['opus', 'codex'], '周玉晶', 'owner-1', 'thread-1', {
        humanDispositionInvocationOrigin: 'direct_owner',
      }),
    );

    assert.equal(calls, 1);
    for (const service of [opus, codex]) {
      assert.equal(service.prompts.length, 1);
      assert.equal(service.prompts[0].includes(FEEDBACK_CONTEXT), true);
      assert.equal(service.prompts[0].split('[human-disposition-feedback]').length - 1, 1);
    }
  });

  test('non-direct and unknown origins call no consumer in serial or parallel', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
    const excludedOrigins = ['queue_replay', 'a2a', 'callback', 'connector', 'system', 'unknown', undefined];

    for (const strategy of ['serial', 'parallel']) {
      for (const origin of excludedOrigins) {
        const opus = createCapturingService('opus');
        let calls = 0;
        const deps = createDeps(
          { opus },
          {
            prepare: async () => {
              calls += 1;
              return FEEDBACK_CONTEXT;
            },
          },
        );
        const options = origin ? { humanDispositionInvocationOrigin: origin } : {};
        const route =
          strategy === 'serial'
            ? routeSerial(deps, ['opus'], '周玉晶', 'owner-1', 'thread-1', options)
            : routeParallel(deps, ['opus'], '周玉晶', 'owner-1', 'thread-1', options);
        await drain(route);
        assert.equal(calls, 0, `${strategy}/${origin ?? 'omitted'} must fail closed`);
        assert.equal(opus.prompts[0].includes('[human-disposition-feedback]'), false);
      }
    }
  });

  test('consumer failure fails closed without crashing either strategy', async () => {
    const { routeSerial } = await import('../dist/domains/cats/services/agents/routing/route-serial.js');
    const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');

    for (const strategy of ['serial', 'parallel']) {
      const opus = createCapturingService('opus');
      const deps = createDeps(
        { opus },
        {
          prepare: async () => {
            throw new Error('ledger unavailable');
          },
        },
      );
      const options = { humanDispositionInvocationOrigin: 'direct_owner' };
      await drain(
        strategy === 'serial'
          ? routeSerial(deps, ['opus'], '周玉晶', 'owner-1', 'thread-1', options)
          : routeParallel(deps, ['opus'], '周玉晶', 'owner-1', 'thread-1', options),
      );
      assert.equal(opus.prompts.length, 1);
      assert.equal(opus.prompts[0].includes('[human-disposition-feedback]'), false);
    }
  });
});
