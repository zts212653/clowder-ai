import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

const { routeParallel } = await import('../dist/domains/cats/services/agents/routing/route-parallel.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');

function service(catId, content) {
  return {
    supportsToolExecutionPolicy: () => true,
    async *invoke() {
      yield { type: 'text', catId, content, timestamp: Date.now() };
      yield { type: 'done', catId, timestamp: Date.now() };
    },
  };
}

describe('route-parallel output commit', () => {
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

  it('keeps a same-wave sibling in delivery custody until a later directed turn', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const prompts = [];
    let invocationSequence = 0;
    const source = await messageStore.append(
      canonicalTestMessageInput({
        userId: 'user-1',
        catId: null,
        content: '@codex-sol @fable-5 think independently',
        mentions: ['codex-sol', 'fable-5'],
        timestamp: 100,
        threadId: 'thread-1',
      }),
    );
    const sibling = await messageStore.append(
      canonicalTestMessageInput({
        userId: 'user-1',
        catId: 'codex-sol',
        content: 'SOL COMPLETE PARALLEL BODY sentinel-tail',
        mentions: [],
        origin: 'stream',
        timestamp: 150,
        threadId: 'thread-1',
        extra: {
          stream: { parallelBatchId: 'original-parallel-batch' },
          causal: { kind: 'invocation_reply', triggerMessageId: source.id },
        },
      }),
    );
    const deps = {
      services: {
        'fable-5': {
          async *invoke(prompt) {
            prompts.push(prompt);
            yield { type: 'text', catId: 'fable-5', content: 'fable answer', timestamp: Date.now() };
            yield { type: 'done', catId: 'fable-5', timestamp: Date.now() };
          },
        },
      },
      invocationDeps: {
        registry: {
          create: () => ({
            invocationId: `inner-fable-${++invocationSequence}`,
            callbackToken: `tok-fable-${invocationSequence}`,
          }),
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
      deliveryCursorStore,
      socketManager: { broadcastToRoom: () => {} },
    };

    for await (const _event of routeParallel(deps, ['fable-5'], source.content, 'user-1', 'thread-1', {
      currentUserMessageId: source.id,
      thinkingMode: 'play',
    })) {
      // drain independent turn
    }
    assert.ok(!prompts[0].includes(sibling.content));

    const synthesis = await messageStore.append(
      canonicalTestMessageInput({
        userId: 'user-1',
        catId: null,
        content: '@fable-5 synthesize the two parallel answers',
        mentions: ['fable-5'],
        timestamp: 200,
        threadId: 'thread-1',
      }),
    );
    for await (const _event of routeParallel(deps, ['fable-5'], synthesis.content, 'user-1', 'thread-1', {
      currentUserMessageId: synthesis.id,
      thinkingMode: 'play',
    })) {
      // drain synthesis turn
    }

    assert.ok(prompts[1].includes(sibling.content));
    assert.ok(prompts[1].includes('sentinel-tail'), 'the route must deliver the complete sibling body');
  });
});
