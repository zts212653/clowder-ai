import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RuntimeInteractionRequest } from '@cat-cafe/shared';
import {
  buildRuntimeInteractionCard,
  MessageRuntimeInteractionCardPublisher,
} from '../src/domains/runtime-interaction/RuntimeInteractionCardPublisher.js';

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

    const cardRef = await publisher.publish(request);
    assert.deepEqual(cardRef, {
      threadId: 'thread-1',
      messageId: 'message-card',
      blockId: 'runtime-interaction:card-interaction',
    });
    assert.equal(appended.length, 1);
    assert.equal(appended[0].idempotencyKey, 'runtime-interaction:card-interaction');
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

    assert.equal((await publisher.publish(request)).messageId, 'message-recovered');
  });
});
