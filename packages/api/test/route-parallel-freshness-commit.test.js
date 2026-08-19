import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { InMemoryFreshnessClosureStore } = await import(
  '../dist/domains/cats/services/freshness/FreshnessClosureStore.js'
);
const { FreshnessOutputCommitCoordinator } = await import(
  '../dist/domains/cats/services/freshness/glass-box/FreshnessOutputCommitCoordinator.js'
);

function service(catId, content) {
  return {
    supportsToolExecutionPolicy: () => true,
    async *invoke() {
      yield { type: 'text', catId, content, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

describe('F254 Phase E — route-parallel output commit', () => {
  it('stamps parallel batch identity when the provider emits no invocation-created event', async () => {
    const messageStore = new MessageStore();
    const deps = {
      services: { opus: service('opus', 'identity-less parallel answer') },
      invocationDeps: {
        registry: {
          create: () => ({ invocationId: 'inner-opus', callbackToken: 'tok-opus' }),
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
      messageStore,
      socketManager: { broadcastToRoom: () => {} },
    };

    for await (const _event of routeParallel(deps, ['opus'], 'question', 'user-1', 'thread-1')) {
      // drain
    }

    const [stored] = (await messageStore.getByThread('thread-1')).filter((message) => message.catId === 'opus');
    assert.ok(stored, 'parallel answer persisted');
    assert.equal(
      stored.extra?.stream?.invocationId,
      'inner-opus',
      'invokeCat must supply the registry identity even when the provider emits no identity event',
    );
    assert.ok(stored.extra?.stream?.parallelBatchId, 'same-batch exclusion identity must be stamped');
  });

  it('publishes a known-stale parallel answer and queues one typed supplement', async () => {
    const messageStore = new MessageStore();
    const seen = await messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'question',
      mentions: ['opus'],
      timestamp: 100,
      threadId: 'thread-1',
    });
    const unseen = await messageStore.append({
      userId: 'user-1',
      catId: 'codex-sol',
      content: 'late visible cat analysis',
      mentions: [],
      origin: 'stream',
      timestamp: 150,
      threadId: 'thread-1',
    });
    const closureStore = new InMemoryFreshnessClosureStore();
    const enqueued = [];
    const deps = {
      services: { opus: service('opus', 'stale parallel answer') },
      invocationDeps: {
        registry: {
          create: () => ({ invocationId: 'inner-opus', callbackToken: 'tok-opus' }),
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
      messageStore,
      deliveryCursorStore: {
        getSeenCursor: async () => seen.id,
        getCursor: async () => seen.id,
        ackSeenCursor: async () => {},
        ackCursor: async () => {},
      },
      freshnessOutputCommitCoordinator: new FreshnessOutputCommitCoordinator({ messageStore, closureStore }),
      socketManager: { broadcastToRoom: () => {} },
    };

    for await (const _event of routeParallel(deps, ['opus'], 'question', 'user-1', 'thread-1', {
      parentInvocationId: 'outer-parallel',
      ownerAuthProvenance: 'strict',
      thinkingMode: 'play',
      freshnessReinvokeEnqueue: (entry) => enqueued.push(entry),
    })) {
      // drain
    }

    const catFinals = (await messageStore.getByThread('thread-1')).filter((message) => message.catId === 'opus');
    assert.equal(catFinals.length, 1);
    assert.equal(catFinals[0].content, 'stale parallel answer');
    assert.deepEqual(catFinals[0].extra.freshness.generatedWithUnseen, [unseen.id]);
    const [supplement] = await closureStore.listSupplementsByLineage(catFinals[0].id);
    assert.deepEqual(supplement.requiredMessageIds, [unseen.id]);
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].ownerAuthProvenance, 'strict');
    assert.equal(enqueued[0].freshnessSupplementId, supplement.id);
    assert.deepEqual(enqueued[0].readOnlyToolPolicy, { mode: 'read_only', replayDeniedToolNames: [] });
  });

  it('keeps a stale parallel answer published when the supplement queue is full', async () => {
    const messageStore = new MessageStore();
    const seen = await messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'question',
      mentions: ['opus'],
      timestamp: 100,
      threadId: 'thread-1',
    });
    await messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'late correction',
      mentions: ['opus'],
      timestamp: 150,
      threadId: 'thread-1',
    });
    const closureStore = new InMemoryFreshnessClosureStore();
    const deps = {
      services: { opus: service('opus', 'stale parallel answer') },
      invocationDeps: {
        registry: {
          create: () => ({ invocationId: 'inner-opus', callbackToken: 'tok-opus' }),
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
      messageStore,
      deliveryCursorStore: {
        getSeenCursor: async () => seen.id,
        getCursor: async () => seen.id,
        ackSeenCursor: async () => {},
        ackCursor: async () => {},
      },
      freshnessOutputCommitCoordinator: new FreshnessOutputCommitCoordinator({ messageStore, closureStore }),
      socketManager: { broadcastToRoom: () => {} },
    };

    for await (const _event of routeParallel(deps, ['opus'], 'question', 'user-1', 'thread-1', {
      parentInvocationId: 'outer-parallel-full',
      freshnessReinvokeEnqueue: () => ({ outcome: 'full' }),
    })) {
      // drain
    }

    const [published] = (await messageStore.getByThread('thread-1')).filter((message) => message.catId === 'opus');
    assert.equal(published.content, 'stale parallel answer');
    const [supplement] = await closureStore.listSupplementsByLineage(published.id);
    assert.equal(supplement.status, 'failed');
    assert.equal(supplement.failureReason, 'queue_full');
  });

  it('commits an adopted parallel supplement as a reply in its exact lineage', async () => {
    const messageStore = new MessageStore();
    const original = await messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'published original',
      mentions: [],
      timestamp: 100,
      threadId: 'thread-1',
      extra: { freshness: { kind: 'fresh', priorFrontierMessageId: null } },
    });
    const required = await messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'late correction',
      mentions: ['opus'],
      timestamp: 150,
      threadId: 'thread-1',
    });
    const closureStore = new InMemoryFreshnessClosureStore();
    const offered = await closureStore.offerSupplement({
      lineageId: original.id,
      originalMessageId: original.id,
      userId: 'user-1',
      threadId: 'thread-1',
      catId: 'opus',
      requiredMessageIds: [required.id],
      requiredFrontierMessageId: required.id,
      now: 200,
    });
    await closureStore.claimSupplement(offered.supplement.id, {
      invocationId: 'outer-parallel-successor',
      now: 250,
    });
    const deps = {
      services: { opus: service('opus', 'current supplement') },
      invocationDeps: {
        registry: {
          create: () => ({ invocationId: 'inner-opus', callbackToken: 'tok-opus' }),
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
      messageStore,
      deliveryCursorStore: {
        getSeenCursor: async () => required.id,
        getCursor: async () => required.id,
        ackSeenCursor: async () => {},
        ackCursor: async () => {},
      },
      freshnessOutputCommitCoordinator: new FreshnessOutputCommitCoordinator({ messageStore, closureStore }),
      socketManager: { broadcastToRoom: () => {} },
    };

    for await (const _event of routeParallel(deps, ['opus'], 'supplement', 'user-1', 'thread-1', {
      parentInvocationId: 'outer-parallel-successor',
      freshnessSupplementId: offered.supplement.id,
      freshnessSupplementRequiredMessageIds: [required.id],
      toolExecutionPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
    })) {
      // drain
    }

    const committed = await closureStore.getSupplement(offered.supplement.id);
    assert.equal(committed?.status, 'committed');
    const catFinals = (await messageStore.getByThread('thread-1')).filter((message) => message.catId === 'opus');
    assert.equal(catFinals.length, 2);
    assert.equal(catFinals[1].content, 'current supplement');
    assert.equal(catFinals[1].replyTo, original.id);
    assert.equal(catFinals[1].extra.supplement.supplementId, offered.supplement.id);
  });

  it('publishes a side-effecting parallel answer and carries its replay fence into the supplement', async () => {
    const messageStore = new MessageStore();
    const seen = await messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'question',
      mentions: ['opus'],
      timestamp: 100,
      threadId: 'thread-1',
    });
    await messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'late correction',
      mentions: ['opus'],
      timestamp: 150,
      threadId: 'thread-1',
    });
    const closureStore = new InMemoryFreshnessClosureStore();
    const enqueued = [];
    const deps = {
      services: {
        opus: {
          supportsToolExecutionPolicy: () => true,
          async *invoke() {
            yield {
              type: 'tool_use',
              catId: 'opus',
              toolName: 'mcp__cat-cafe-collab__cat_cafe_hold_ball',
              toolUseId: 'parallel-hold',
              timestamp: Date.now(),
            };
            yield { type: 'text', catId: 'opus', content: 'stale after hold', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          },
        },
      },
      invocationDeps: {
        registry: {
          create: () => ({ invocationId: 'inner-opus', callbackToken: 'tok-opus' }),
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
      messageStore,
      deliveryCursorStore: {
        getSeenCursor: async () => seen.id,
        getCursor: async () => seen.id,
        ackSeenCursor: async () => {},
        ackCursor: async () => {},
      },
      freshnessOutputCommitCoordinator: new FreshnessOutputCommitCoordinator({ messageStore, closureStore }),
      socketManager: { broadcastToRoom: () => {} },
    };

    for await (const _event of routeParallel(deps, ['opus'], 'question', 'user-1', 'thread-1', {
      parentInvocationId: 'outer-parallel-side-effect',
      freshnessReinvokeEnqueue: (entry) => enqueued.push(entry),
    })) {
      // drain
    }

    assert.equal(enqueued.length, 1);
    const [published] = (await messageStore.getByThread('thread-1')).filter((message) => message.catId === 'opus');
    assert.equal(published.content, 'stale after hold');
    const [supplement] = await closureStore.listSupplementsByLineage(published.id);
    assert.deepEqual(supplement.replayUnsafeToolNames, ['mcp__cat-cafe-collab__cat_cafe_hold_ball']);
    assert.deepEqual(enqueued[0].readOnlyToolPolicy.replayDeniedToolNames, supplement.replayUnsafeToolNames);
  });

  it('publishes a tool-only audit record and offers a read-only supplement', async () => {
    const messageStore = new MessageStore();
    const seen = await messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'question',
      mentions: ['opus'],
      timestamp: 100,
      threadId: 'thread-1',
    });
    await messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'late correction',
      mentions: ['opus'],
      timestamp: 150,
      threadId: 'thread-1',
    });
    const closureStore = new InMemoryFreshnessClosureStore();
    const enqueued = [];
    const deps = {
      services: {
        opus: {
          supportsToolExecutionPolicy: () => true,
          async *invoke() {
            yield {
              type: 'tool_use',
              catId: 'opus',
              toolName: 'mcp__cat-cafe-collab__cat_cafe_hold_ball',
              toolUseId: 'parallel-tool-only-hold',
              timestamp: Date.now(),
            };
            yield {
              type: 'tool_result',
              catId: 'opus',
              toolUseId: 'parallel-tool-only-hold',
              content: '{"status":"ok"}',
              timestamp: Date.now(),
            };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          },
        },
      },
      invocationDeps: {
        registry: {
          create: () => ({ invocationId: 'inner-opus', callbackToken: 'tok-opus' }),
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
      messageStore,
      deliveryCursorStore: {
        getSeenCursor: async () => seen.id,
        getCursor: async () => seen.id,
        ackSeenCursor: async () => {},
        ackCursor: async () => {},
      },
      freshnessOutputCommitCoordinator: new FreshnessOutputCommitCoordinator({ messageStore, closureStore }),
      socketManager: { broadcastToRoom: () => {} },
    };

    for await (const _event of routeParallel(deps, ['opus'], 'question', 'user-1', 'thread-1', {
      parentInvocationId: 'outer-parallel-tool-only-side-effect',
      freshnessReinvokeEnqueue: (entry) => enqueued.push(entry),
    })) {
      // drain
    }

    assert.equal(enqueued.length, 1);
    const catFinals = (await messageStore.getByThread('thread-1')).filter((message) => message.catId === 'opus');
    assert.equal(catFinals.length, 1);
    assert.equal(catFinals[0].toolEvents.length, 2);
    const [supplement] = await closureStore.listSupplementsByLineage(catFinals[0].id);
    assert.deepEqual(supplement.replayUnsafeToolNames, ['mcp__cat-cafe-collab__cat_cafe_hold_ball']);
  });

  for (const scenario of [
    { name: 'text', service: service('opus', 'retained text') },
    {
      name: 'answer-bearing no-text',
      service: {
        async *invoke() {
          yield {
            type: 'system_info',
            catId: 'opus',
            content: JSON.stringify({ type: 'thinking', text: 'retained thinking' }),
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      },
    },
    {
      name: 'replay-unsafe tool-only',
      service: {
        async *invoke() {
          yield {
            type: 'tool_use',
            catId: 'opus',
            toolName: 'mcp__cat-cafe-collab__cat_cafe_hold_ball',
            toolUseId: 'parallel-retained-tool',
            timestamp: Date.now(),
          };
          yield {
            type: 'tool_result',
            catId: 'opus',
            toolUseId: 'parallel-retained-tool',
            content: '{"status":"ok"}',
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        },
      },
    },
  ]) {
    it(`IR-5 parallel ${scenario.name}: retained custody keeps the DraftStore record`, async () => {
      const messageStore = new MessageStore();
      const deletedDrafts = [];
      const deps = {
        services: { opus: scenario.service },
        invocationDeps: {
          registry: {
            create: () => ({ invocationId: 'inner-opus', callbackToken: 'tok-opus' }),
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
        messageStore,
        deliveryCursorStore: {
          getSeenCursor: async () => null,
          getCursor: async () => null,
          ackSeenCursor: async () => {},
          ackCursor: async () => {},
        },
        freshnessOutputCommitCoordinator: {
          commit: async (input) => ({
            kind: 'blocked_known_closure',
            closureId: 'unavailable:user-1:thread-1:opus',
            reason: 'closure_store_unavailable',
            turnOutcome: 'retained',
            turnInvocationId: input.turnInvocationId,
            draftCustody: { kind: 'retained', invocationId: input.turnInvocationId },
          }),
        },
        draftStore: {
          upsert: () => {},
          touch: () => {},
          delete: (...args) => deletedDrafts.push(args),
          getByThread: () => [],
          deleteByThread: () => {},
        },
        socketManager: { broadcastToRoom: () => {} },
      };

      for await (const _event of routeParallel(deps, ['opus'], 'question', 'user-1', 'thread-1')) {
        // drain
      }

      assert.deepEqual(deletedDrafts, [], 'a retained decision is not durable elsewhere and cannot authorize delete');
    });
  }
});
