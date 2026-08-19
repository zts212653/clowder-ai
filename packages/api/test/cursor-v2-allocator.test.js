/**
 * #1200 — P1-A: visibilitySeq allocator uses server time, not payload timestamp.
 *
 * Tests that far-future payload timestamps do NOT poison the hwm/counter,
 * and that seq values are always derived from server wall-clock (Date.now()
 * for Memory, redis.call('TIME') for Redis).
 *
 * Split from cursor-v2-store-integration.test.js per 350-line limit.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { parseCursor } = await import('../dist/domains/cats/services/stores/cursor.js');

describe('#1200 P1-A: allocator uses server time, not payload timestamp', () => {
  it('far-future payload timestamp does NOT poison visibilitySeq', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `p1a-future-${Date.now()}`;

    const farFuture = Date.now() + 365 * 24 * 60 * 60 * 1000; // +1 year
    store.append({
      userId: 'u1',
      catId: null,
      content: 'far-future',
      mentions: [],
      timestamp: farFuture,
      threadId,
    });

    const page = store.getByThreadAfter(threadId);
    assert.equal(page.length, 1);
    assert.ok(page[0].visibilitySeq !== undefined);
    // seq must be near wall-clock, NOT near the far-future timestamp
    // Allow 10s tolerance for slow CI
    assert.ok(page[0].visibilitySeq < farFuture, `seq ${page[0].visibilitySeq} must be << far-future ${farFuture}`);
    assert.ok(page[0].visibilitySeq >= Date.now() - 10_000, `seq ${page[0].visibilitySeq} must be ≥ wall-clock - 10s`);
  });

  it('seq is monotonic across messages with varying timestamps', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `p1a-mono-${Date.now()}`;

    // Append with past, normal, and far-future timestamps
    store.append({ userId: 'u1', catId: null, content: 'past', mentions: [], timestamp: 1000, threadId });
    store.append({ userId: 'u1', catId: null, content: 'normal', mentions: [], timestamp: Date.now(), threadId });
    store.append({
      userId: 'u1',
      catId: null,
      content: 'future',
      mentions: [],
      timestamp: Date.now() + 1_000_000_000,
      threadId,
    });

    const page = store.getByThreadAfter(threadId);
    assert.equal(page.length, 3);
    // All must have visibilitySeq, and seq must be strictly monotonic
    for (let i = 0; i < page.length; i++) {
      assert.ok(page[i].visibilitySeq !== undefined, `msg[${i}] must have visibilitySeq`);
      if (i > 0) {
        assert.ok(
          page[i].visibilitySeq > page[i - 1].visibilitySeq,
          `seq[${i}]=${page[i].visibilitySeq} must be > seq[${i - 1}]=${page[i - 1].visibilitySeq}`,
        );
      }
    }
    // The far-future msg's seq must still be near wall-clock, not near its timestamp
    const futureMsg = page[2];
    assert.ok(
      futureMsg.visibilitySeq < Date.now() + 1_000_000_000,
      `future seq ${futureMsg.visibilitySeq} must be << its payload timestamp`,
    );
  });

  it('markDelivered uses server time for seq, not deliveredAt', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `p1a-deliver-${Date.now()}`;

    const q = store.append({
      userId: 'u1',
      catId: 'opus',
      content: 'queued',
      mentions: [],
      timestamp: Date.now(),
      threadId,
      deliveryStatus: 'queued',
    });

    // Deliver with a far-future timestamp — seq must NOT use it
    const farFutureDeliveredAt = Date.now() + 365 * 24 * 60 * 60 * 1000;
    store.markDelivered(q.id, farFutureDeliveredAt);

    const cursor = store.canonicalizeCursor(q.id, threadId);
    assert.ok(cursor.startsWith('v2:'), 'Delivered message should have v2 cursor');
    const parsed = parseCursor(cursor);
    assert.ok(
      parsed.seq < farFutureDeliveredAt,
      `seq ${parsed.seq} must be << far-future deliveredAt ${farFutureDeliveredAt}`,
    );
  });
});
