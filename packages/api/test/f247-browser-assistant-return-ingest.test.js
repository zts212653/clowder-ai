import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { CloudAssistantReturnIngestService } from '../dist/domains/cats/services/cloud-bridge/cloud-assistant-return-ingest.js';
import { MemoryCloudReturnGrantStore } from '../dist/domains/cats/services/cloud-bridge/cloud-return-grant.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

function idempotencyKey(scope) {
  const digest = createHash('sha256')
    .update(JSON.stringify({ v: 1, ...scope }))
    .digest('hex');
  return `f247-cloud-return:${digest}`;
}

function fixture() {
  const store = new MessageStore();
  // F117: append requires MessageFrom sender identity
  const source = store.append(
    canonicalTestMessageInput({
      userId: 'alice',
      catId: 'codex-sol',
      threadId: 'thread-f247-browser-return',
      content: '@gpt-pro answer this exact source',
      mentions: ['gpt-pro'],
      timestamp: 1_000,
    }),
  );
  const grantStore = new MemoryCloudReturnGrantStore();
  const broadcasts = [];
  const service = new CloudAssistantReturnIngestService({
    messageStore: store,
    grantStore,
    socketManager: { broadcastAgentMessage: (message, threadId) => broadcasts.push({ message, threadId }) },
    logger: { error() {}, warn() {} },
  });
  return { store, source, grantStore, broadcasts, service };
}

describe('F247 browser-captured assistant return ingest', () => {
  it('persists and broadcasts one exact-source gpt-pro reply through the server grant', async () => {
    const { store, source, grantStore, broadcasts, service } = fixture();
    const scope = {
      threadId: source.threadId,
      userId: source.userId,
      sourceMessageId: source.id,
      targetCatId: 'gpt-pro',
    };
    await grantStore.issue({ ...scope, dispatchInvocationId: 'dispatch-browser-return-1' });

    const outcome = await service.ingest({
      sourceMessageId: source.id,
      content: 'ordinary ChatGPT assistant final without an MCP callback',
    });

    assert.equal(outcome.status, 'persisted');
    const stored = await store.getById(outcome.messageId);
    assert.equal(stored.catId, 'gpt-pro');
    assert.equal(stored.replyTo, source.id);
    assert.equal(stored.origin, 'callback');
    assert.equal(stored.extra.isExplicitPost, true);
    assert.equal(
      (await store.getByIdempotencyKey(source.userId, source.threadId, idempotencyKey(scope))).id,
      stored.id,
    );
    assert.equal(broadcasts.length, 1);
    assert.equal(broadcasts[0].threadId, source.threadId);
    assert.equal(broadcasts[0].message.messageId, stored.id);

    const replay = await service.ingest({ sourceMessageId: source.id, content: stored.content });
    assert.equal(replay.status, 'duplicate');
    assert.equal(replay.messageId, stored.id);
    assert.equal((await store.getByThread(source.threadId)).filter((message) => message.catId === 'gpt-pro').length, 1);
  });

  it('loses safely to an already-persisted MCP return and never replaces its content', async () => {
    const { store, source, grantStore, service } = fixture();
    const scope = {
      threadId: source.threadId,
      userId: source.userId,
      sourceMessageId: source.id,
      targetCatId: 'gpt-pro',
    };
    // F117: append requires MessageFrom sender identity
    const mcpWinner = store.append(
      canonicalTestMessageInput({
        userId: source.userId,
        catId: 'gpt-pro',
        threadId: source.threadId,
        content: 'MCP won the exact source race',
        mentions: [],
        origin: 'callback',
        timestamp: 1_100,
        extra: { isExplicitPost: true },
        replyTo: source.id,
        idempotencyKey: idempotencyKey(scope),
      }),
    );
    await grantStore.issue({ ...scope, dispatchInvocationId: 'dispatch-browser-return-2' });

    const outcome = await service.ingest({
      sourceMessageId: source.id,
      content: 'browser fallback must not create a second reply',
    });

    assert.deepEqual(outcome, { status: 'duplicate', messageId: mcpWinner.id });
    assert.equal((await store.getByThread(source.threadId)).filter((message) => message.catId === 'gpt-pro').length, 1);
    assert.equal((await store.getById(mcpWinner.id)).content, 'MCP won the exact source race');
  });

  it('rejects a browser return without a server grant or for a non-public source', async () => {
    const { store, source, grantStore, service } = fixture();
    assert.deepEqual(await service.ingest({ sourceMessageId: source.id, content: 'no dispatch grant' }), {
      status: 'rejected',
      reason: 'grant_not_found',
    });

    // F117: append requires MessageFrom sender identity
    const whisper = store.append(
      canonicalTestMessageInput({
        userId: source.userId,
        catId: 'codex-sol',
        threadId: source.threadId,
        content: 'private source must not be projected into a public browser return',
        mentions: ['gpt-pro'],
        visibility: 'whisper',
        whisperTo: ['gpt-pro'],
        timestamp: 1_200,
      }),
    );
    await grantStore.issue({
      threadId: whisper.threadId,
      userId: whisper.userId,
      sourceMessageId: whisper.id,
      targetCatId: 'gpt-pro',
      dispatchInvocationId: 'dispatch-browser-return-private',
    });

    assert.deepEqual(await service.ingest({ sourceMessageId: whisper.id, content: 'must remain rejected' }), {
      status: 'rejected',
      reason: 'source_ineligible',
    });
    assert.equal((await store.getByThread(source.threadId)).filter((message) => message.catId === 'gpt-pro').length, 0);
  });
});
