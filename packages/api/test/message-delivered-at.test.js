/**
 * F098 Phase D: deliveredAt — 消息交付时间戳
 *
 * Tests for markDelivered() on MessageStore (in-memory).
 * When a queued message is dequeued for processing, deliveredAt is set.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { MessageStore, generateSortableId } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

describe('MessageStore.markDelivered', () => {
  test('sets deliveredAt on a queued message', () => {
    const store = new MessageStore();
    const msg = store.append({
      userId: 'u1',
      catId: null,
      content: 'queued message',
      mentions: ['opus'],
      timestamp: 1000,
      deliveryStatus: 'queued',
    });

    const now = Date.now();
    const updated = store.markDelivered(msg.id, now);

    assert.ok(updated, 'should return updated message');
    assert.equal(updated.deliveredAt, now);
    assert.equal(updated.deliveryStatus, 'delivered');
    assert.equal(updated.content, 'queued message');
  });

  test('returns null for non-existent message', () => {
    const store = new MessageStore();
    const result = store.markDelivered('non-existent', Date.now());
    assert.equal(result, null);
  });

  test('deliveredAt is persisted and visible via getById', () => {
    const store = new MessageStore();
    const msg = store.append({
      userId: 'u1',
      catId: null,
      content: 'test',
      mentions: [],
      timestamp: 1000,
      deliveryStatus: 'queued',
    });

    store.markDelivered(msg.id, 5000);

    const fetched = store.getById(msg.id);
    assert.equal(fetched.deliveredAt, 5000);
    assert.equal(fetched.deliveryStatus, 'delivered');
  });

  test('deliveredAt field exists on StoredMessage type (not set by default)', () => {
    const store = new MessageStore();
    const msg = store.append({
      userId: 'u1',
      catId: null,
      content: 'immediate message',
      mentions: [],
      timestamp: 1000,
    });

    // Immediate messages should NOT have deliveredAt
    assert.equal(msg.deliveredAt, undefined);
  });
});

describe('MessageStore.getByThreadAfter', () => {
  test('falls back to lexicographic ID filtering when cursor message is missing', () => {
    const store = new MessageStore();
    store.append({
      threadId: 'thread-a',
      userId: 'u1',
      catId: null,
      content: 'before cursor',
      mentions: [],
      timestamp: 1000,
    });
    const afterCursor = store.append({
      threadId: 'thread-a',
      userId: 'u1',
      catId: null,
      content: 'after missing cursor',
      mentions: [],
      timestamp: 2000,
    });
    store.append({
      threadId: 'thread-b',
      userId: 'u1',
      catId: null,
      content: 'other thread',
      mentions: [],
      timestamp: 3000,
    });

    const missingCursor = generateSortableId(1500);
    const results = store.getByThreadAfter('thread-a', missingCursor, 5, 'u1');

    assert.deepEqual(
      results.map((m) => m.id),
      [afterCursor.id],
    );
  });
});
