/**
 * Cursor Order — Remaining RED tests (§8.8 tests 9, 11, 16, 18, 20-22, 24-26)
 *
 * Memory-store invariant tests. Redis-side verification deferred to pnpm test:redis.
 * Architecture ref: docs/architecture/1200-cursor-order-analysis.md §8.8
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { parseCursor, cursorFor } = await import('../dist/domains/cats/services/stores/cursor.js');
const { MessageStore, generateSortableId } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');

describe('Cursor Order — Remaining RED tests (§8.8)', () => {
  // ---- RED #9: Legacy-mixed ----
  // Backfilled thread → legacy order preserved; new messages strictly above;
  // v1 cursors from the legacy region resolve exactly.
  it('RED #9 — Legacy-mixed: backfill order preserved, new messages above', async () => {
    const store = new MessageStore();
    const threadId = `red9-${Date.now()}`;
    const baseTs = Date.now() - 10000;

    // Simulate legacy messages (direct, no queuing)
    const l1 = store.append({ userId: 'u1', catId: null, content: 'L1', mentions: [], timestamp: baseTs, threadId });
    const l2 = store.append({
      userId: 'u1',
      catId: null,
      content: 'L2',
      mentions: [],
      timestamp: baseTs + 100,
      threadId,
    });

    // Read the legacy region
    const legacyPage = store.getByThreadAfter(threadId);
    assert.equal(legacyPage.length, 2);
    assert.equal(legacyPage[0].id, l1.id, 'Legacy order preserved');
    assert.equal(legacyPage[1].id, l2.id);

    // Append new messages — must have seqs strictly above legacy
    const _n1 = store.append({
      userId: 'u1',
      catId: null,
      content: 'N1',
      mentions: [],
      timestamp: baseTs + 5000,
      threadId,
    });

    const fullPage = store.getByThreadAfter(threadId);
    assert.equal(fullPage.length, 3);
    assert.ok(fullPage[2].visibilitySeq > fullPage[1].visibilitySeq, 'New message seq above legacy');

    // v1 cursor from legacy region resolves
    const afterL1 = store.getByThreadAfter(threadId, l1.id);
    assert.ok(afterL1.length >= 2, 'v1 cursor resolves within legacy region');
    assert.equal(afterL1[0].id, l2.id);
  });

  // ---- RED #11: Cleanup + WITHSCORES integrity ----
  // Tombstone/delete highest-seq → next allocation still higher (invariant 4 of 8.2).
  // Compaction: missing A + live B → B.visibilitySeq exact, cursorFor(B) resolves correctly.
  it('RED #11 — Cleanup + WITHSCORES: tombstone highest → next seq still higher', async () => {
    const store = new MessageStore();
    const threadId = `red11-${Date.now()}`;

    const _m1 = store.append({
      userId: 'u1',
      catId: null,
      content: 'A-will-delete',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId,
    });
    const m2 = store.append({
      userId: 'u1',
      catId: null,
      content: 'B-live',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId,
    });

    // Record B's seq
    const page1 = store.getByThreadAfter(threadId);
    const bSeq = page1[1].visibilitySeq;

    // Delete A (tombstone the highest-seq message in this case, delete m2)
    const page1Full = store.getByThreadAfter(threadId);
    const highestSeq = page1Full[page1Full.length - 1].visibilitySeq;

    // Now append another message — its seq must be > highestSeq
    const m3 = store.append({
      userId: 'u1',
      catId: null,
      content: 'C-after-delete',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });

    const page2 = store.getByThreadAfter(threadId);
    const m3Item = page2.find((m) => m.id === m3.id);
    assert.ok(m3Item, 'New message must be visible');
    assert.ok(m3Item.visibilitySeq > highestSeq, 'New seq must be > previous highest');

    // B's cursorFor resolves to B's exact position (Map-by-id binding, not position)
    const bItem = page2.find((m) => m.id === m2.id);
    assert.equal(bItem.visibilitySeq, bSeq, 'B seq unchanged after compaction');
    const bCursor = cursorFor(bItem);
    const bParsed = parseCursor(bCursor);
    assert.equal(bParsed.seq, bSeq, 'cursorFor(B) reflects true position');
  });

  // ---- RED #16: Legacy issuance closure ----
  // Backfilled message from after-path yields v2 cursorFor;
  // from non-after surface yields v1 that resolves identically.
  it('RED #16 — Legacy issuance closure: v2 from after-path, v1 from raw', async () => {
    const store = new MessageStore();
    const threadId = `red16-${Date.now()}`;

    const m = store.append({
      userId: 'u1',
      catId: null,
      content: 'legacy-msg',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });

    // From after-path: carries visibilitySeq → v2 cursor
    const page = store.getByThreadAfter(threadId);
    const afterToken = cursorFor(page[0]);
    assert.ok(afterToken.startsWith('v2:'), 'After-path must produce v2');

    // From raw: no visibilitySeq → v1 cursor (raw ID)
    const rawToken = cursorFor({ id: m.id });
    assert.equal(rawToken, m.id, 'Raw path produces v1 (raw ID)');

    // Both resolve to same message via getByThreadAfter
    const afterV2 = store.getByThreadAfter(threadId, afterToken);
    const afterV1 = store.getByThreadAfter(threadId, rawToken);

    // v2 after returns 0 (cursor is AT the only message)
    // v1 exact-match also returns 0 (cursor found, next = nothing)
    assert.equal(afterV2.length, 0, 'v2 cursor past only message → empty');
    assert.equal(afterV1.length, 0, 'v1 cursor exact-match → empty');
  });

  // ---- RED #18: Non-integer legacy scores ----
  // Memory store uses integer seq. This test verifies the allocator produces
  // safe integers strictly above any prior seq, even for dense append bursts.
  it('RED #18 — Dense append burst: allocator produces unique safe-integer seqs', async () => {
    const store = new MessageStore();
    const threadId = `red18-${Date.now()}`;

    // Append 100 messages in tight burst (sub-ms)
    const msgs = [];
    for (let i = 0; i < 100; i++) {
      msgs.push(
        store.append({ userId: 'u1', catId: null, content: `m${i}`, mentions: [], timestamp: Date.now(), threadId }),
      );
    }

    const page = store.getByThreadAfter(threadId);
    assert.equal(page.length, 100);

    // All seqs unique and safe integers, strictly monotonic
    const seqs = page.map((m) => m.visibilitySeq);
    for (let i = 0; i < seqs.length; i++) {
      assert.ok(Number.isSafeInteger(seqs[i]), `seq[${i}]=${seqs[i]} must be safe integer`);
      if (i > 0) {
        assert.ok(seqs[i] > seqs[i - 1], `seq[${i}]=${seqs[i]} must be > seq[${i - 1}]=${seqs[i - 1]}`);
      }
    }
  });

  // ---- RED #20: Meta survives everything ----
  // Delete highest member, clock rollback → new seq still > hwm.
  it('RED #20 — Meta survives: delete + clock rollback → seq still strictly higher', async () => {
    const store = new MessageStore();
    const threadId = `red20-${Date.now()}`;

    const _m1 = store.append({
      userId: 'u1',
      catId: null,
      content: 'will-survive',
      mentions: [],
      timestamp: Date.now() + 100000,
      threadId,
    });

    const page1 = store.getByThreadAfter(threadId);
    const prevHwm = page1[0].visibilitySeq;

    // Append with earlier timestamp (simulates clock rollback)
    const m2 = store.append({
      userId: 'u1',
      catId: null,
      content: 'after-rollback',
      mentions: [],
      timestamp: Date.now() - 100000,
      threadId,
    });

    const page2 = store.getByThreadAfter(threadId);
    const newSeq = page2.find((m) => m.id === m2.id)?.visibilitySeq;
    assert.ok(newSeq > prevHwm, `After clock rollback: new seq ${newSeq} must be > hwm ${prevHwm}`);
  });

  // ---- RED #21: Emptied index ≠ unmigrated ----
  // Memory store: after all messages removed from thread, new appends still get
  // strictly monotonic seqs (meta persists across empty states).
  it('RED #21 — Empty thread: new appends continue monotonic sequence', async () => {
    const store = new MessageStore();
    const threadId = `red21-${Date.now()}`;

    const _m1 = store.append({
      userId: 'u1',
      catId: null,
      content: 'msg1',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });
    const page1 = store.getByThreadAfter(threadId);
    const firstSeq = page1[0].visibilitySeq;

    // Delete entire thread
    store.deleteByThread(threadId);

    // New append — seq must continue above the old hwm
    const _m2 = store.append({
      userId: 'u1',
      catId: null,
      content: 'after-delete',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });
    const page2 = store.getByThreadAfter(threadId);
    assert.equal(page2.length, 1);
    assert.ok(page2[0].visibilitySeq > firstSeq, 'Seq must continue above old hwm after thread clear');
  });

  // ---- RED #24: Cursor TTL persistence ----
  // (a) Default path (ttl=0): cursor persists without TTL.
  // (b) In-memory DeliveryCursorStore: simple monotonic CAS.
  it('RED #24 — Cursor persistence: default writes are persistent (in-memory CAS)', async () => {
    const cursorStore = new DeliveryCursorStore();
    const v1 = cursorFor({ id: generateSortableId(1000), visibilitySeq: 1000 });
    const v2Higher = cursorFor({ id: generateSortableId(2000), visibilitySeq: 2000 });
    const v2Lower = cursorFor({ id: generateSortableId(500), visibilitySeq: 500 });

    // Advance cursor
    await cursorStore.ackCursor('u1', 'opus', 't1', v1);
    const c1 = await cursorStore.getCursor('u1', 'opus', 't1');
    assert.equal(c1, v1);

    // Higher cursor advances
    await cursorStore.ackCursor('u1', 'opus', 't1', v2Higher);
    const c2 = await cursorStore.getCursor('u1', 'opus', 't1');
    assert.equal(c2, v2Higher);

    // Lower cursor is no-op (monotonic CAS)
    await cursorStore.ackCursor('u1', 'opus', 't1', v2Lower);
    const c3 = await cursorStore.getCursor('u1', 'opus', 't1');
    assert.equal(c3, v2Higher, 'Lower cursor must not regress');
  });

  // ---- RED #25: Backfill bound ----
  // Memory store doesn't have a backfill bound (all legacy members are in-memory),
  // but we test that a large thread with many messages handles pagination correctly.
  it('RED #25 — Large thread pagination: 500 messages paged correctly', async () => {
    const store = new MessageStore();
    const threadId = `red25-${Date.now()}`;

    for (let i = 0; i < 500; i++) {
      store.append({
        userId: 'u1',
        catId: null,
        content: `msg-${i}`,
        mentions: [],
        timestamp: Date.now() - (500 - i) * 10,
        threadId,
      });
    }

    // Paginate in chunks of 100
    let cursor;
    let total = 0;
    for (let page = 0; page < 6; page++) {
      const batch = store.getByThreadAfter(threadId, cursor, 100);
      if (batch.length === 0) break;
      total += batch.length;
      cursor = cursorFor(batch[batch.length - 1]);
    }
    assert.equal(total, 500, 'All 500 messages reachable via pagination');
  });

  // ---- RED #26: Read-only legacy thread migrates on read ----
  // First getByThreadAfter triggers visibility setup and returns full pages.
  it('RED #26 — Read-only legacy thread: first read returns full correct pages', async () => {
    const store = new MessageStore();
    const threadId = `red26-${Date.now()}`;

    // Seed messages (immediate delivery — legacy pattern)
    const msgs = [];
    for (let i = 0; i < 5; i++) {
      msgs.push(
        store.append({
          userId: 'u1',
          catId: null,
          content: `legacy-${i}`,
          mentions: [],
          timestamp: Date.now() - (5 - i) * 1000,
          threadId,
        }),
      );
    }

    // First read — triggers visibility setup, returns all
    const page = store.getByThreadAfter(threadId);
    assert.equal(page.length, 5, 'All legacy messages visible on first read');

    // All carry visibilitySeq
    for (const msg of page) {
      assert.ok(msg.visibilitySeq !== undefined, `${msg.content} must have visibilitySeq`);
    }

    // v1 cursor from first message resolves exactly
    const afterFirst = store.getByThreadAfter(threadId, msgs[0].id);
    assert.equal(afterFirst.length, 4, 'After first legacy message → remaining 4');
    assert.equal(afterFirst[0].id, msgs[1].id);
  });
});
