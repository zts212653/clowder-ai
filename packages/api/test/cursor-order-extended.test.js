/**
 * Cursor Order — Extended RED tests (§8.8 tests 10–23 subset)
 *
 * These tests validate invariants protected by the P1-A, P1-B, and P3 fixes:
 *   - #10: Clock rollback — allocator stays monotonic
 *   - #12: Token stability — same message → same position after reassign
 *   - #15: Append atomicity — immediate messages carry visibilitySeq
 *   - #17: Padded-token CAS order — v2 lex ordering invariant
 *   - #23a,b,c: Read-state at visibility high-water
 *
 * Architecture ref: docs/architecture/1200-cursor-order-analysis.md §8.8
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { parseCursor, cursorFor } = await import('../dist/domains/cats/services/stores/cursor.js');

describe('Cursor Order — Extended RED tests (§8.8)', () => {
  // ---- RED #10: Clock rollback ----
  // The allocator uses max(hwm+1, Date.now()). If wall-clock rolls back (or tests
  // run faster than 1ms), hwm+1 wins → strictly monotonic.
  it('RED #10 — Clock rollback: allocator stays strictly monotonic', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `red10-${Date.now()}`;

    // Append 3 messages — timestamps don't matter, seq must be strictly monotonic
    const m1 = store.append({
      userId: 'u1',
      catId: null,
      content: 'a',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });
    const m2 = store.append({
      userId: 'u1',
      catId: null,
      content: 'b',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });
    const m3 = store.append({
      userId: 'u1',
      catId: null,
      content: 'c',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });

    const page = store.getByThreadAfter(threadId);
    assert.equal(page.length, 3);

    // Strict monotonicity: seq[i] < seq[i+1] for all i
    for (let i = 1; i < page.length; i++) {
      assert.ok(
        page[i].visibilitySeq > page[i - 1].visibilitySeq,
        `seq[${i}]=${page[i].visibilitySeq} must be > seq[${i - 1}]=${page[i - 1].visibilitySeq}`,
      );
    }
  });

  // ---- RED #12: Token stability ----
  // Same v2 token resolves to the same position. visibilitySeq is immutable after assignment.
  it('RED #12 — Token stability: same message always produces same v2 token', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `red12-${Date.now()}`;

    store.append({
      userId: 'u1',
      catId: null,
      content: 'stable',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });

    const page1 = store.getByThreadAfter(threadId);
    const token1 = cursorFor(page1[0]);

    // Read again — same token
    const page2 = store.getByThreadAfter(threadId);
    const token2 = cursorFor(page2[0]);

    assert.equal(token1, token2, 'Same message must produce identical v2 tokens');
    assert.ok(token1.startsWith('v2:'), 'Must be v2');
  });

  // ---- RED #15: Append atomicity ----
  // Every immediately-visible message carries visibilitySeq at append time.
  // Timeline-published queued cat speech also carries it (isTimelinePublished).
  // Hidden queued work (system/scheduler) does NOT carry it.
  it('RED #15 — Append atomicity: immediate message has seq, hidden queued does not', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `red15-${Date.now()}`;

    const direct = store.append({
      userId: 'u1',
      catId: null,
      content: 'direct',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });

    // Hidden queued work (system/scheduler) — NOT timeline-published
    const queued = store.append({
      userId: 'scheduler',
      catId: 'system',
      content: 'hidden-queued',
      mentions: [],
      timestamp: Date.now(),
      threadId,
      deliveryStatus: 'queued',
    });

    // Verify via getByThreadAfter (which injects visibilitySeq)
    const page = store.getByThreadAfter(threadId);
    assert.equal(page.length, 1, 'Only the direct message should be visible');
    assert.ok(page[0].visibilitySeq !== undefined, 'Direct message must have visibilitySeq');

    // Hidden queued message should NOT be in visibility (no visibilitySeq)
    assert.equal(queued.visibilitySeq, undefined, 'Hidden queued must not get visibilitySeq');
    const token = cursorFor({ id: queued.id }); // no visibilitySeq → v1
    assert.equal(token, queued.id, 'Hidden queued message should produce v1 cursor (no seq)');
  });

  // ---- RED #17: Padded-token CAS order ----
  // v2(seq=10) > v2(seq=9) > any v1 raw ID — critical for SET_IF_GREATER
  it('RED #17 — Padded-token CAS order: v2 ordering + v1 dominance', () => {
    const t9 = cursorFor({ id: 'msg-a', visibilitySeq: 9 });
    const t10 = cursorFor({ id: 'msg-b', visibilitySeq: 10 });
    const v1 = '9999999999999-zzz'; // max realistic v1 ID

    // v2(10) > v2(9) — seq ordering
    assert.ok(t10 > t9, `v2(seq=10) must lex-exceed v2(seq=9)`);

    // v2(9) > any v1 — version dominance
    assert.ok(t9 > v1, `v2(seq=9) must lex-exceed any v1 ID`);

    // Parser rejects malformed
    assert.throws(() => parseCursor('v2:42:msg'), /16 digits/);
    assert.throws(() => parseCursor('v3:0000000000000001:msg'), /Unknown cursor version/);
  });

  // ---- RED #23a: Read-state at visibility high-water ----
  // C direct → Q late-delivered → getLatestVisibleCursor anchors at Q's visibility
  // position, not C's time-tail.
  it('RED #23a — Read-state at visibility high-water: late-delivered Q is latest', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `red23a-${Date.now()}`;
    const baseTs = Date.now() - 10000;

    const c = store.append({
      userId: 'u1',
      catId: null,
      content: 'C-direct',
      mentions: [],
      timestamp: baseTs + 100,
      threadId,
    });
    const q = store.append({
      userId: 'u1',
      catId: 'opus',
      content: 'Q-queued',
      mentions: [],
      timestamp: baseTs + 50,
      threadId,
      deliveryStatus: 'queued',
    });
    store.markDelivered(q.id, baseTs + 200);

    const latest = store.getLatestVisibleCursor(threadId);
    assert.ok(latest, 'Should return a cursor');
    assert.ok(latest.cursor.startsWith('v2:'), 'Should be v2');
    assert.equal(latest.messageId, q.id, 'Latest visible should be Q (delivered after C)');

    // The cursor's seq should be > C's seq
    const cPage = store.getByThreadAfter(threadId, undefined, 1);
    const cSeq = cPage[0].visibilitySeq;
    const qParsed = parseCursor(latest.cursor);
    assert.ok(qParsed.seq > cSeq, 'Q seq must be > C seq (Q delivered after C)');
  });

  // ---- RED #23b: /read/latest response contract ----
  // messageId is a raw message ID (never a v2 token), cursor is a v2 token.
  it('RED #23b — getLatestVisibleCursor contract: messageId is raw, cursor is v2', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `red23b-${Date.now()}`;

    store.append({
      userId: 'u1',
      catId: null,
      content: 'msg',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });

    const latest = store.getLatestVisibleCursor(threadId);
    assert.ok(latest);
    assert.ok(!latest.messageId.startsWith('v2:'), 'messageId must be raw ID (not v2 token)');
    assert.ok(latest.cursor.startsWith('v2:'), 'cursor must be v2 token');
  });

  // ---- RED #23c: manual PATCH /read canonicalization ----
  // Raw late-delivered upToMessageId lex-below stored cursor → canonicalized → advances.
  it('RED #23c — canonicalizeCursor: late-delivered raw ID resolves to v2', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `red23c-${Date.now()}`;

    const c = store.append({
      userId: 'u1',
      catId: null,
      content: 'C',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId,
    });
    const q = store.append({
      userId: 'u1',
      catId: 'opus',
      content: 'Q',
      mentions: [],
      timestamp: Date.now() - 2000,
      threadId,
      deliveryStatus: 'queued',
    });
    store.markDelivered(q.id, Date.now());

    // Q.id < C.id (lex order) but Q's visibilitySeq > C's visibilitySeq
    // canonicalizeCursor should return a v2 token that reflects Q's true position
    const qCanon = store.canonicalizeCursor(q.id, threadId);
    const cCanon = store.canonicalizeCursor(c.id, threadId);
    assert.ok(qCanon.startsWith('v2:'), 'Q should canonicalize to v2');
    assert.ok(cCanon.startsWith('v2:'), 'C should canonicalize to v2');
    assert.ok(qCanon > cCanon, 'Q canon must lex-exceed C canon (Q delivered after C)');

    // Without canonicalization, raw Q.id < C.id would wrongly reject the ack
    assert.ok(q.id < c.id, 'Raw Q.id < C.id (the original disease)');
  });

  // ---- RED #13: Cancel hygiene ----
  // Queued-then-canceled never enters visibility index; doesn't appear in pages.
  it('RED #13 — Cancel hygiene: canceled queued message never visible', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `red13-${Date.now()}`;

    const direct = store.append({
      userId: 'u1',
      catId: null,
      content: 'visible',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId,
    });
    const q = store.append({
      userId: 'u1',
      catId: 'opus',
      content: 'will-cancel',
      mentions: [],
      timestamp: Date.now(),
      threadId,
      deliveryStatus: 'queued',
    });
    store.markCanceled(q.id);

    const page = store.getByThreadAfter(threadId);
    assert.equal(page.length, 1, 'Only direct message visible');
    assert.equal(page[0].content, 'visible');
  });

  // ---- RED #19: Queued lifecycle ----
  // Timeline-published cat speech: seq assigned at append, preserved at delivery.
  // Not visible in getByThreadAfter while queued (display filter), visible after delivery.
  it('RED #19 — Queued lifecycle: timeline-published → seq preserved at delivery', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `red19-${Date.now()}`;

    const q = store.append({
      userId: 'u1',
      catId: 'opus',
      content: 'queued-msg',
      mentions: [],
      timestamp: Date.now(),
      threadId,
      deliveryStatus: 'queued',
    });

    // Before delivery: not visible
    const before = store.getByThreadAfter(threadId);
    assert.equal(before.length, 0, 'Queued message not visible before delivery');

    // Deliver
    store.markDelivered(q.id, Date.now());

    // After delivery: visible with seq
    const after = store.getByThreadAfter(threadId);
    assert.equal(after.length, 1, 'Delivered message is now visible');
    assert.ok(after[0].visibilitySeq !== undefined, 'Must have visibilitySeq');

    // Second delivery: no-op (already delivered — deliveryTransitioned=false)
    const result = store.markDelivered(q.id, Date.now() + 1000);
    assert.ok(result !== null, 'markDelivered returns result for existing msg');
    assert.equal(result.deliveryTransitioned, false, 'Second delivery is CAS no-op');
  });

  // ---- Delivery preserves immutable visibility position ----
  // Q (timeline-published queued cat speech) gets visibilitySeq at append.
  // Later ordinary B gets a higher seq. markDelivered(Q) must NOT reallocate —
  // Q's cursor and position must remain unchanged.
  it('Delivery preserves append-time visibility position for timeline-published speech', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `deliver-preserve-${Date.now()}`;

    const q = store.append({
      userId: 'u1',
      catId: 'codex-sol',
      content: 'timeline-published cat speech',
      mentions: ['opus'],
      timestamp: Date.now() - 1000,
      threadId,
      deliveryStatus: 'queued',
    });

    // Q gets visibilitySeq at append (timeline-published)
    const qCursorBefore = cursorFor(q);
    assert.ok(qCursorBefore.startsWith('v2:'), 'Q must have v2 cursor at append');
    const qSeqBefore = parseCursor(qCursorBefore).seq;

    // Append later ordinary B — gets a higher seq
    const b = store.append({
      userId: 'u1',
      catId: null,
      content: 'ordinary B',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });
    const bSeq = parseCursor(cursorFor(b)).seq;
    assert.ok(bSeq > qSeqBefore, 'B seq must be > Q seq (B appended later)');

    // Deliver Q — must NOT reallocate
    store.markDelivered(q.id, Date.now());

    // Q's cursor must be unchanged
    const latest = store.getLatestVisibleCursor(threadId);
    assert.ok(latest, 'Should return a cursor');
    assert.equal(latest.messageId, b.id, 'Latest visible should be B (higher seq)');

    // Q's seq must be preserved (not moved after B)
    const page = store.getByThreadAfter(threadId);
    const qInPage = page.find((m) => m.id === q.id);
    assert.ok(qInPage, 'Q must be visible after delivery');
    assert.equal(qInPage.visibilitySeq, qSeqBefore, 'Q visibilitySeq must be preserved');
    assert.equal(cursorFor(qInPage), qCursorBefore, 'Q cursor must be identical to pre-delivery');
  });

  // ---- Hidden queued work: delivery allocates first position ----
  // Non-timeline-published queued work (system/scheduler) has NO visibilitySeq
  // at append. markDelivered must allocate its first canonical position.
  it('Hidden queued work gets visibilitySeq at delivery, not append', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `hidden-queued-${Date.now()}`;

    const hidden = store.append({
      userId: 'scheduler',
      catId: 'system',
      content: 'hidden system queued work',
      mentions: [],
      timestamp: Date.now(),
      threadId,
      deliveryStatus: 'queued',
    });

    // Hidden queued: NO visibilitySeq at append
    assert.equal(hidden.visibilitySeq, undefined, 'Hidden queued must not get visibilitySeq');
    assert.equal(cursorFor(hidden), hidden.id, 'Hidden queued produces v1 cursor');

    // Deliver → allocates first position
    store.markDelivered(hidden.id, Date.now());

    const latest = store.getLatestVisibleCursor(threadId);
    assert.ok(latest, 'Should return a cursor after delivery');
    assert.ok(latest.cursor.startsWith('v2:'), 'Delivered hidden msg gets v2 cursor');
    assert.equal(latest.messageId, hidden.id);
  });

  // ---- Pruned v1 cursor fallback: FM-4 parity ----
  // When a v1 cursor's message is not found, Memory must rescan from start
  // (same as Redis), NOT filter by id > cursor.id (that reintroduces FM-3).
  it('Pruned v1 cursor fallback rescans from start, not lex-filter', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `pruned-v1-${Date.now()}`;

    // Create 3 messages
    store.append({ userId: 'u1', catId: null, content: 'M1', mentions: [], timestamp: Date.now() - 2000, threadId });
    store.append({ userId: 'u1', catId: null, content: 'M2', mentions: [], timestamp: Date.now() - 1000, threadId });
    store.append({ userId: 'u1', catId: null, content: 'M3', mentions: [], timestamp: Date.now(), threadId });

    // Use a fake cursor ID that doesn't exist (simulates pruned message)
    const fakeCursor = 'zzz-pruned-cursor-id';
    const page = store.getByThreadAfter(threadId, fakeCursor);

    // Pruned fallback must return ALL messages (rescan from start), not filter by lex
    assert.equal(page.length, 3, 'Pruned v1 cursor must rescan from start');
    assert.equal(page[0].content, 'M1');
  });
});
