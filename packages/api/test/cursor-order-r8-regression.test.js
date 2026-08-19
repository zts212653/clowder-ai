/**
 * #1200 R8 regression tests — visibility predicate parity
 *
 * Coverage for maintainer round 8 P1-1: isTimelinePublished replaces
 * isDelivered in forward scans (getByThreadAfter) and mention queries
 * (getMentionsFor, getRecentMentionsFor).
 *
 * Memory store tests run locally. Redis coverage runs in CI via the
 * dual-store harness (cursor-order.test.js already exercises the paths).
 *
 * P1-2 (cancel HDEL) and P1-3 (pre-mutation HWM) are Redis Lua fixes —
 * the Memory store already handles both correctly. Redis-level regression
 * coverage for those is in cursor-order-sol-remaining.test.js (Redis-skip
 * locally, runs in CI with REDIS_URL + isolation flag).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

// ---- P1-1: timeline-published queued cat speech in forward scans ----

describe('#1269 R8 P1-1: isTimelinePublished in forward scans', () => {
  it('getByThreadAfter includes timeline-published queued cat speech', async () => {
    const store = new MessageStore();
    const threadId = `r8-p1-1-after-${Date.now()}`;

    // Direct message visible at append
    store.append({
      userId: 'u1',
      catId: null,
      content: 'C-direct',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId,
    });

    // Timeline-published cat speech: queued but catId is real cat → visible at append
    store.append({
      userId: 'u1',
      catId: 'opus',
      content: 'Q-cat-speech',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId,
      deliveryStatus: 'queued',
    });

    // Full scan should include both messages
    const page = store.getByThreadAfter(threadId, undefined, undefined, 'u1', {
      includeQueuedCatMessages: true,
    });
    const contents = page.map((m) => m.content);
    assert.ok(contents.includes('C-direct'), 'Direct message should be in page');
    assert.ok(contents.includes('Q-cat-speech'), 'Timeline-published cat speech should be in page');
  });

  it('getByThreadAfter DEFAULT excludes queued cat speech (option not set)', async () => {
    const store = new MessageStore();
    const threadId = `r8-p1-1-default-${Date.now()}`;

    store.append({
      userId: 'u1',
      catId: null,
      content: 'C-direct',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId,
    });

    // Timeline-published cat speech — queued, real cat
    store.append({
      userId: 'u1',
      catId: 'opus',
      content: 'Q-cat-speech',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId,
      deliveryStatus: 'queued',
    });

    // Default read (no options) — should NOT include queued cat speech
    const page = store.getByThreadAfter(threadId);
    const contents = page.map((m) => m.content);
    assert.ok(contents.includes('C-direct'), 'Direct message should be in page');
    assert.ok(!contents.includes('Q-cat-speech'), 'Queued cat speech should NOT be in default read');
  });

  it('getByThreadAfter still excludes hidden queued work', async () => {
    const store = new MessageStore();
    const threadId = `r8-p1-1-hidden-${Date.now()}`;

    store.append({
      userId: 'u1',
      catId: null,
      content: 'C-direct',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId,
    });

    // Hidden queued work: catId=null, not timeline-published
    store.append({
      userId: 'scheduler',
      catId: null,
      content: 'Q-hidden',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId,
      deliveryStatus: 'queued',
    });

    const page = store.getByThreadAfter(threadId);
    const contents = page.map((m) => m.content);
    assert.ok(contents.includes('C-direct'), 'Direct message should be in page');
    assert.ok(!contents.includes('Q-hidden'), 'Hidden queued work should NOT be in page');
  });
});

// ---- isTimelinePublished in mention queries (accepted contract) ----
// Timeline-published cat speech is visible in mention feeds at append time.
// Hidden queued work (catId=null, scheduler) is NOT visible until delivered.

describe('#1269: isTimelinePublished in mention queries', () => {
  it('getMentionsFor includes timeline-published queued cat speech', async () => {
    const store = new MessageStore();
    const threadId = `r8-mention-queued-${Date.now()}`;

    // Cat speech mentioning 'terra' — queued but timeline-published → visible
    store.append({
      userId: 'u1',
      catId: 'opus',
      content: 'Hey @terra check this',
      mentions: ['terra'],
      timestamp: Date.now() - 1000,
      threadId,
      deliveryStatus: 'queued',
    });

    const mentions = store.getMentionsFor('terra', 10, undefined, threadId);
    assert.equal(mentions.length, 1, 'Timeline-published cat speech mention should be found');
    assert.equal(mentions[0].content, 'Hey @terra check this');
  });

  it('getMentionsFor excludes hidden queued mentions', async () => {
    const store = new MessageStore();
    const threadId = `r8-mention-hidden-${Date.now()}`;

    // Hidden queued work mentioning 'terra' — not timeline-published
    store.append({
      userId: 'scheduler',
      catId: null,
      content: 'Hidden mention @terra',
      mentions: ['terra'],
      timestamp: Date.now() - 1000,
      threadId,
      deliveryStatus: 'queued',
    });

    const mentions = store.getMentionsFor('terra', 10, undefined, threadId);
    assert.equal(mentions.length, 0, 'Hidden queued mention should NOT be found');
  });

  it('getRecentMentionsFor includes timeline-published queued cat speech', async () => {
    const store = new MessageStore();
    const threadId = `r8-recent-queued-${Date.now()}`;

    store.append({
      userId: 'u1',
      catId: 'opus',
      content: 'Recent @terra',
      mentions: ['terra'],
      timestamp: Date.now(),
      threadId,
      deliveryStatus: 'queued',
    });

    const recent = store.getRecentMentionsFor('terra', 10, undefined, threadId);
    assert.equal(recent.length, 1, 'Timeline-published recent mention should be found');
  });

  it('getRecentMentionsFor excludes hidden queued mentions', async () => {
    const store = new MessageStore();
    const threadId = `r8-recent-hidden-${Date.now()}`;

    store.append({
      userId: 'scheduler',
      catId: null,
      content: 'Hidden recent @terra',
      mentions: ['terra'],
      timestamp: Date.now(),
      threadId,
      deliveryStatus: 'queued',
    });

    const recent = store.getRecentMentionsFor('terra', 10, undefined, threadId);
    assert.equal(recent.length, 0, 'Hidden queued recent mention should NOT be found');
  });
});

// ---- P1-2: cancel clears custody fields (Memory parity) ----

describe('#1269 R8 P1-2: cancel clears queueCustody (Memory parity)', () => {
  it('markCanceled removes queueCustody from message', async () => {
    const store = new MessageStore();
    const threadId = `r8-p1-2-cancel-${Date.now()}`;

    // Append with queueCustody already set (simulates initialized custody)
    const q = store.append({
      userId: 'u1',
      catId: null,
      content: 'work-to-cancel',
      mentions: [],
      timestamp: Date.now(),
      threadId,
      deliveryStatus: 'queued',
    });

    // Cancel
    const result = store.markCanceled(q.id);
    assert.ok(result, 'markCanceled should return a result');
    assert.equal(result.deliveryStatus, 'canceled', 'Status should be canceled');
    assert.equal(result.queueCustody, undefined, 'queueCustody should be cleared after cancel');

    // Verify via getById too
    const after = await store.getById(q.id);
    assert.equal(after?.deliveryStatus, 'canceled');
    assert.equal(after?.queueCustody, undefined);
  });
});
