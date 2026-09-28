import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RuntimeInteractionRecord, RuntimeInteractionRequest } from '@cat-cafe/shared';
import {
  buildRuntimeInteractionCard,
  MessageRuntimeInteractionCardPublisher,
} from '../src/domains/runtime-interaction/RuntimeInteractionCardPublisher.js';
import { RuntimeInteractionService } from '../src/domains/runtime-interaction/RuntimeInteractionService.js';
import { InMemoryRuntimeInteractionStore } from '../src/domains/runtime-interaction/stores/InMemoryRuntimeInteractionStore.js';

const request: RuntimeInteractionRequest = {
  version: 1,
  interactionId: 'card-interaction',
  kind: 'question',
  owner: { userId: 'user-1', threadId: 'thread-1', catId: 'codex-sol', invocationId: 'inv-1' },
  provider: {
    providerId: 'openai',
    method: 'item/tool/requestUserInput',
    requestId: 'rpc-card',
    threadId: 'provider-thread',
    turnId: 'provider-turn',
    itemId: 'provider-item',
  },
  createdAt: 1000,
  title: 'Need deployment answers',
  questions: [{ id: 'token', header: 'Token', question: 'One-time token?', isSecret: true }],
};

describe('runtime interaction card publisher', () => {
  it('builds a specialized inert-by-default card with only canonical interaction metadata', () => {
    const block = buildRuntimeInteractionCard(request);
    assert.equal(block.id, 'runtime-interaction:card-interaction');
    assert.equal(block.kind, 'card');
    assert.equal(block.meta?.kind, 'runtime_interaction');
    assert.equal(block.meta?.interactionId, 'card-interaction');
    assert.deepEqual(block.meta, {
      kind: 'runtime_interaction',
      interactionId: 'card-interaction',
      interactionKind: 'question',
    });
    assert.equal(block.actions, undefined);
  });

  it('persists one idempotent timeline card and broadcasts the stored message', async () => {
    const appended = [];
    const broadcasts = [];
    const stored = {
      id: 'message-card',
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'codex-sol',
      content: '需要你回答：Need deployment answers',
      mentions: [],
      timestamp: 1000,
      extra: { rich: { v: 1, blocks: [buildRuntimeInteractionCard(request)] } },
    };
    const publisher = new MessageRuntimeInteractionCardPublisher({
      messageStore: {
        append: async (input) => {
          appended.push(input);
          return stored;
        },
        getByIdempotencyKey: async () => null,
        getById: async () => stored,
      },
      socketManager: {
        broadcastToRoom: (rooms, event, payload) => broadcasts.push({ rooms, event, payload }),
      },
    });

    const cardRef = await publisher.prepare(request);
    assert.deepEqual(cardRef, {
      threadId: 'thread-1',
      messageId: 'message-card',
      blockId: 'runtime-interaction:card-interaction',
    });
    assert.equal(appended.length, 1);
    assert.equal(appended[0].idempotencyKey, 'runtime-interaction:card-interaction');
    assert.equal(broadcasts.length, 0, 'prepared cards must remain inert until durable ownership is anchored');
    await publisher.publish(request, cardRef);
    assert.deepEqual(broadcasts[0].rooms, ['thread:thread-1', 'user:user-1']);
    assert.equal(broadcasts[0].event, 'connector_message');
    assert.equal(broadcasts[0].payload.message.id, 'message-card');
    assert.equal(await publisher.isLive(request, cardRef), true);
  });

  it('recovers an idempotent append acknowledgement loss instead of creating a second card', async () => {
    const block = buildRuntimeInteractionCard(request);
    const recovered = {
      id: 'message-recovered',
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'codex-sol',
      content: '需要你回答：Need deployment answers',
      timestamp: 1000,
      extra: { rich: { v: 1, blocks: [block] } },
    };
    let lookupCount = 0;
    const publisher = new MessageRuntimeInteractionCardPublisher({
      messageStore: {
        append: async () => Promise.reject(new Error('ack lost')),
        getByIdempotencyKey: async () => {
          lookupCount += 1;
          return lookupCount === 1 ? null : recovered;
        },
        getById: async () => recovered,
      },
      socketManager: { broadcastToRoom: () => {} },
    });

    assert.equal((await publisher.prepare(request)).messageId, 'message-recovered');
  });

  it('anchors durable ownership before the actual publisher broadcast can trigger an answer', async () => {
    const store = new InMemoryRuntimeInteractionStore();
    const stored = {
      id: 'message-immediate-answer',
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'codex-sol',
      content: '需要你回答：Need deployment answers',
      mentions: [],
      timestamp: 1000,
      extra: { rich: { v: 1 as const, blocks: [buildRuntimeInteractionCard(request)] } },
    };
    let service!: RuntimeInteractionService;
    let answerAtBroadcast: Promise<RuntimeInteractionRecord> | undefined;
    let announceBroadcast!: () => void;
    const broadcastObserved = new Promise<void>((resolve) => {
      announceBroadcast = resolve;
    });
    const publisher = new MessageRuntimeInteractionCardPublisher({
      messageStore: {
        append: async () => stored,
        getByIdempotencyKey: async () => null,
        getById: async () => stored,
      },
      socketManager: {
        broadcastToRoom: () => {
          answerAtBroadcast = service.respond({
            interactionId: request.interactionId,
            ownerUserId: request.owner.userId,
            cardRef: {
              threadId: request.owner.threadId,
              messageId: stored.id,
              blockId: `runtime-interaction:${request.interactionId}`,
            },
            response: { kind: 'answers', answers: { token: ['one-time-secret'] } },
          });
          announceBroadcast();
        },
      },
    });
    service = new RuntimeInteractionService({ store, cardPublisher: publisher, hostEpoch: 'host-1', now: () => 1100 });

    const providerResponse = service.request(request);
    void providerResponse.catch(() => {});
    await broadcastObserved;
    if (!answerAtBroadcast) throw new Error('publisher did not trigger the immediate answer');
    const answerResult = await Promise.allSettled([answerAtBroadcast]);
    if (answerResult[0]?.status === 'rejected') {
      await service.invalidateInvocation(request.owner.invocationId, 'provider_cancelled');
      await assert.rejects(providerResponse);
      assert.fail(`immediate answer failed: ${String(answerResult[0].reason)}`);
    }

    assert.equal(answerResult[0]?.value.status, 'answered');
    assert.deepEqual(await providerResponse, {
      kind: 'answers',
      answers: { token: ['one-time-secret'] },
    });
    assert.equal((await store.get(request.interactionId))?.status, 'answered');
  });
});
