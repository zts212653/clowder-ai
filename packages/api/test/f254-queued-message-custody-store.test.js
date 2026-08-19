import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { makeQueuedMessageCustody as makeCustody } from './helpers/queued-message-custody.js';

function appendQueued(store, custody = makeCustody()) {
  return store.append({
    userId: 'user-1',
    catId: null,
    content: 'durable queued work',
    mentions: ['opus', 'codex'],
    timestamp: 1_000,
    threadId: 'thread-1',
    deliveryStatus: 'queued',
    queueCustody: custody,
  });
}

describe('F254 queued message custody store', () => {
  test('persists one revisioned custody projection on the exact queued message', () => {
    const store = new MessageStore();
    const message = appendQueued(store);

    assert.deepEqual(store.getById(message.id)?.queueCustody, makeCustody());

    const next = makeCustody({
      revision: 2,
      status: 'processing',
      seenByCatIds: ['opus'],
      seenInvocationIdByCatId: { opus: 'inv-opus-1' },
      processingStartedAt: 1_100,
      updatedAt: 1_100,
    });
    const result = store.transitionQueueCustody(message.id, {
      expectedRevision: 1,
      next,
    });

    assert.equal(result.kind, 'updated');
    assert.equal(result.deliveryTransitioned, false);
    assert.deepEqual(result.message.queueCustody, next);
    assert.equal(result.message.deliveryStatus, 'queued');
  });

  test('rejects stale custody writers without mutating the current projection', () => {
    const store = new MessageStore();
    const message = appendQueued(store);
    const revisionTwo = makeCustody({ revision: 2, updatedAt: 1_100 });

    assert.equal(store.transitionQueueCustody(message.id, { expectedRevision: 1, next: revisionTwo }).kind, 'updated');

    const stale = store.transitionQueueCustody(message.id, {
      expectedRevision: 1,
      next: makeCustody({ revision: 2, status: 'processing', updatedAt: 1_200 }),
    });

    assert.deepEqual(stale, { kind: 'revision_mismatch', actualRevision: 2 });
    assert.deepEqual(store.getById(message.id)?.queueCustody, revisionTwo);
  });

  test('atomically terminalizes custody and delivers only after every target is handled', () => {
    const store = new MessageStore();
    const message = appendQueued(store);
    const terminal = makeCustody({
      revision: 2,
      status: 'terminal',
      pendingTargetCats: [],
      seenByCatIds: ['opus', 'codex'],
      handledByCatIds: ['opus', 'codex'],
      updatedAt: 1_200,
    });

    const result = store.transitionQueueCustody(message.id, {
      expectedRevision: 1,
      next: terminal,
      deliveredAt: 1_200,
    });

    assert.equal(result.kind, 'updated');
    assert.equal(result.deliveryTransitioned, true);
    assert.equal(result.message.deliveryStatus, 'delivered');
    assert.equal(result.message.deliveredAt, 1_200);
    assert.deepEqual(result.message.queueCustody, terminal);
  });

  test('refuses the legacy markDelivered escape hatch while custody is active', () => {
    const store = new MessageStore();
    const message = appendQueued(store);

    const result = store.markDelivered(message.id, 1_200);

    assert.equal(result.deliveryTransitioned, false);
    assert.equal(store.getById(message.id).deliveryStatus, 'queued');
    assert.equal(store.getById(message.id).queueCustody.status, 'queued');
  });

  test('forward queued-inclusive reads preserve raw thread order across an exposed queued cursor', () => {
    const store = new MessageStore();
    const threadId = 'thread-queued-inclusive-forward-memory';
    const before = store.append({
      userId: 'user-1',
      catId: null,
      content: 'before',
      mentions: [],
      timestamp: 1_000,
      threadId,
    });
    const exposed = store.append({
      userId: 'user-1',
      catId: null,
      content: 'exposed queued body',
      mentions: ['opus'],
      timestamp: 2_000,
      threadId,
      deliveryStatus: 'queued',
      queueCustody: makeCustody({
        allTargetCats: ['opus'],
        pendingTargetCats: ['opus'],
        seenByCatIds: ['opus'],
        seenInvocationIdByCatId: { opus: 'sealed-child' },
        bodyExposures: [{ targetCatId: 'opus', invocationId: 'sealed-child', seenAt: 2_100 }],
      }),
    });
    const after = store.append({
      userId: 'user-1',
      catId: 'codex',
      content: 'after',
      mentions: [],
      timestamp: 2_000,
      threadId,
    });
    const options = {
      includeQueuedCatMessages: true,
      includeExposedQueuedUserMessagesForCatId: 'opus',
    };

    assert.deepEqual(
      store.getByThreadAfter(threadId, before.id, 20, 'user-1', options).map((message) => message.id),
      [exposed.id, after.id],
    );
    assert.deepEqual(
      store.getByThreadAfter(threadId, exposed.id, 20, 'user-1', options).map((message) => message.id),
      [after.id],
    );
    assert.deepEqual(
      store
        .getByThreadAfter(threadId, before.id, 20, 'user-1', {
          ...options,
          includeExposedQueuedUserMessagesForCatId: 'codex-sol',
        })
        .map((message) => message.id),
      [after.id],
    );
  });
});
