/**
 * Cursor Order — RED #22: Late mention exactly-once + no starvation (§8.8)
 *
 * (a) mention C (direct) + mention Q (queued, Q.id < C.id) → ack C →
 *     deliver Q → next mention page contains Q exactly once.
 * (b) ack C → ≥20 NON-mention messages → then mention Q →
 *     getMentionsFor(limit=20) returns Q (match-counted scan).
 *
 * Architecture ref: docs/architecture/1200-cursor-order-analysis.md §8.8 #22
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { cursorFor } = await import('../dist/domains/cats/services/stores/cursor.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

describe('Cursor Order — RED #22: Late mention exactly-once', () => {
  // ---- RED #22a: Late-delivered mention appears exactly once ----
  it('RED #22a — Late mention: deliver Q after ack C → Q in next page', async () => {
    const store = new MessageStore();
    const threadId = `red22a-${Date.now()}`;
    const baseTs = Date.now() - 10000;

    // C: direct mention (visible immediately)
    const c = store.append({
      userId: 'u1',
      catId: null,
      content: '@opus direct mention',
      mentions: ['opus'],
      timestamp: baseTs + 200,
      threadId,
    });

    // Q: genuinely hidden queued work (catId: null, scheduler-originated) — NOT
    // timeline-published, so invisible before delivery.  Q.id < C.id because
    // of the earlier timestamp.  After markDelivered, Q becomes visible and
    // must appear exactly once in the next mention page.
    const q = store.append({
      userId: 'scheduler',
      catId: null,
      content: '@opus queued mention',
      mentions: ['opus'],
      timestamp: baseTs + 50,
      threadId,
      deliveryStatus: 'queued',
    });

    // Before delivery: only C visible in mentions
    const mentions1 = store.getMentionsFor('opus', 20, undefined, threadId);
    assert.equal(mentions1.length, 1, 'Only C visible before Q delivery');
    assert.equal(mentions1[0].id, c.id);

    // Ack C
    const cCursor = cursorFor(mentions1[0]);

    // Deliver Q (late)
    store.markDelivered(q.id, baseTs + 300);

    // After delivery: getMentionsFor after C's cursor → Q appears
    const mentions2 = store.getMentionsFor('opus', 20, undefined, threadId, cCursor);
    assert.equal(mentions2.length, 1, 'Q should appear exactly once after ack C');
    assert.equal(mentions2[0].id, q.id, 'The late-delivered mention should be Q');
  });

  // ---- RED #22b: Match-counted scan prevents starvation ----
  // ≥20 non-mention messages between ack cursor and next mention →
  // getMentionsFor(limit=20) still returns the mention (not starved by non-mentions).
  it('RED #22b — Starvation: 25 non-mentions then 1 mention → mention found', async () => {
    const store = new MessageStore();
    const threadId = `red22b-${Date.now()}`;
    const baseTs = Date.now() - 50000;

    // First mention (will be acked)
    const _anchor = store.append({
      userId: 'u1',
      catId: null,
      content: '@opus anchor',
      mentions: ['opus'],
      timestamp: baseTs,
      threadId,
    });
    const anchorCursor = cursorFor(store.getByThreadAfter(threadId)[0]);

    // 25 non-mention messages (would eat a page-then-filter window)
    for (let i = 0; i < 25; i++) {
      store.append({
        userId: 'u1',
        catId: null,
        content: `filler-${i}`,
        mentions: [],
        timestamp: baseTs + 100 + i * 10,
        threadId,
      });
    }

    // 1 mention at the end
    const lateMention = store.append({
      userId: 'u1',
      catId: null,
      content: '@opus late mention',
      mentions: ['opus'],
      timestamp: baseTs + 500,
      threadId,
    });

    // getMentionsFor with limit=20, cursor after anchor
    const mentions = store.getMentionsFor('opus', 20, undefined, threadId, anchorCursor);

    // Match-counted scan should find the mention despite 25 non-mentions
    assert.ok(mentions.length >= 1, 'Match-counted scan must find mention past 25 fillers');
    assert.ok(
      mentions.some((m) => m.id === lateMention.id),
      'Late mention must be in results',
    );
  });
});
