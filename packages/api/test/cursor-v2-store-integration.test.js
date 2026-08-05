/**
 * #1200 — v2 cursor store integration tests (§8.7).
 *
 * Tests cursor behavior through the MessageStore layer:
 *   - getByThreadAfter injects visibilitySeq for graded cursorFor issuance
 *   - getLatestVisibleCursor returns visibility-domain latest (not time-domain)
 *   - canonicalizeCursor converts raw IDs to v2 cursors for CAS ingress
 *
 * Split from cursor-v2-format.test.js (format/parsing tests) per 350-line limit.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { parseCursor, cursorFor } = await import('../dist/domains/cats/services/stores/cursor.js');

describe('#1200 v2 cursor in getByThreadAfter (§8.7 graded issuance)', () => {
  it('returned messages carry visibilitySeq for cursorFor issuance', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `cursor-v2-test-${Date.now()}`;

    store.append({
      userId: 'u1',
      catId: null,
      content: 'hello',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });

    const page = store.getByThreadAfter(threadId);
    assert.equal(page.length, 1);
    assert.ok(page[0].visibilitySeq !== undefined, 'Message from getByThreadAfter must carry visibilitySeq');

    // cursorFor should produce a v2 token
    const token = cursorFor(page[0]);
    assert.ok(token.startsWith('v2:'), `Expected v2 token, got "${token}"`);
  });

  it('v2 cursor works as afterId in getByThreadAfter', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `cursor-v2-roundtrip-${Date.now()}`;

    store.append({
      userId: 'u1',
      catId: null,
      content: 'msg1',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId,
    });
    store.append({
      userId: 'u1',
      catId: null,
      content: 'msg2',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });

    const page1 = store.getByThreadAfter(threadId, undefined, 1);
    assert.equal(page1.length, 1);
    assert.equal(page1[0].content, 'msg1');

    // Use the v2 cursor from page1 to get page2
    const cursor = cursorFor(page1[0]);
    const page2 = store.getByThreadAfter(threadId, cursor, 1);
    assert.equal(page2.length, 1);
    assert.equal(page2[0].content, 'msg2');
  });

  it('v1 cursor (raw ID) still works in getByThreadAfter', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `cursor-v1-compat-${Date.now()}`;

    const msg1 = store.append({
      userId: 'u1',
      catId: null,
      content: 'first',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId,
    });
    store.append({
      userId: 'u1',
      catId: null,
      content: 'second',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });

    // Pass raw message ID (v1 cursor) — backward compat
    const page = store.getByThreadAfter(threadId, msg1.id);
    assert.equal(page.length, 1);
    assert.equal(page[0].content, 'second');
  });
});

describe('#1200 getLatestVisibleCursor (§8.7 read-state)', () => {
  it('returns latest visible message as v2 cursor', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `latest-vis-cursor-${Date.now()}`;

    store.append({ userId: 'u1', catId: null, content: 'first', mentions: [], timestamp: Date.now() - 2000, threadId });
    store.append({
      userId: 'u1',
      catId: null,
      content: 'second',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId,
    });
    store.append({ userId: 'u1', catId: null, content: 'third', mentions: [], timestamp: Date.now(), threadId });

    const result = store.getLatestVisibleCursor(threadId);
    assert.ok(result, 'Should return a cursor');
    assert.ok(result.cursor.startsWith('v2:'), 'Should be a v2 cursor');
    assert.ok(result.messageId, 'Should include messageId');

    // The latest visible message should be 'third'
    const msg = await store.getById(result.messageId);
    assert.equal(msg?.content, 'third');
  });

  it('skips hidden queued messages (not yet visible)', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `latest-skip-queued-${Date.now()}`;

    store.append({
      userId: 'u1',
      catId: null,
      content: 'direct',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId,
    });
    // #1269: hidden queued work (non-cat-speech) is not timeline-published,
    // so it has no visibilitySeq and is not returned by getLatestVisibleCursor.
    // Timeline-published cat speech (catId: 'opus') WOULD be visible at append.
    store.append({
      userId: 'scheduler',
      catId: 'system',
      content: 'queued-hidden',
      mentions: [],
      timestamp: Date.now(),
      threadId,
      deliveryStatus: 'queued',
    });

    const result = store.getLatestVisibleCursor(threadId);
    assert.ok(result, 'Should return a cursor');
    const msg = await store.getById(result.messageId);
    assert.equal(msg?.content, 'direct', 'Latest visible should be "direct", not hidden queued');
  });

  it('returns null for empty thread', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `latest-empty-${Date.now()}`;

    const result = store.getLatestVisibleCursor(threadId);
    assert.equal(result, null, 'Empty thread should return null');
  });

  it('includes late-delivered Q as latest when delivered after C', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `latest-late-deliver-${Date.now()}`;
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

    const result = store.getLatestVisibleCursor(threadId);
    assert.ok(result, 'Should return a cursor');
    // Q was delivered AFTER C, so Q has a higher visibilitySeq → Q is latest visible
    const msg = await store.getById(result.messageId);
    assert.equal(msg?.content, 'Q-queued', 'Late-delivered Q should be latest visible');
  });
});

describe('#1200 canonicalizeCursor (§8.7 CAS ingress)', () => {
  it('returns v2 cursor for a delivered message', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `canon-delivered-${Date.now()}`;

    const m = store.append({
      userId: 'u1',
      catId: null,
      content: 'direct',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });

    const cursor = store.canonicalizeCursor(m.id, threadId);
    assert.ok(cursor.startsWith('v2:'), `Expected v2 cursor, got "${cursor}"`);

    // Round-trip: parsing the cursor should recover the message ID
    const parsed = parseCursor(cursor);
    assert.equal(parsed.version, 2);
    assert.equal(parsed.id, m.id);
  });

  it('returns raw ID for hidden queued (not-yet-visible) message', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `canon-queued-${Date.now()}`;

    // #1269: hidden queued work (non-cat-speech) has no visibilitySeq → raw ID fallback.
    // Timeline-published cat speech (catId: 'opus') would get v2 at append.
    const q = store.append({
      userId: 'scheduler',
      catId: 'system',
      content: 'queued-hidden',
      mentions: [],
      timestamp: Date.now(),
      threadId,
      deliveryStatus: 'queued',
    });

    // Hidden queued message has no visibility position → falls back to raw ID
    const cursor = store.canonicalizeCursor(q.id, threadId);
    assert.equal(cursor, q.id, 'Hidden queued message should return raw ID (v1 fallback)');
  });

  it('returns v2 for late-delivered message', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `canon-late-${Date.now()}`;

    const q = store.append({
      userId: 'u1',
      catId: 'opus',
      content: 'late-Q',
      mentions: [],
      timestamp: Date.now() - 1000,
      threadId,
      deliveryStatus: 'queued',
    });
    store.markDelivered(q.id, Date.now());

    const cursor = store.canonicalizeCursor(q.id, threadId);
    assert.ok(cursor.startsWith('v2:'), `Expected v2 cursor after delivery, got "${cursor}"`);
    const parsed = parseCursor(cursor);
    assert.equal(parsed.id, q.id);
  });

  it('returns raw ID for unknown message', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const cursor = store.canonicalizeCursor('nonexistent-id', 'any-thread');
    assert.equal(cursor, 'nonexistent-id', 'Unknown message should return raw ID');
  });

  it('refuses to sign v2 cursor for message in wrong thread', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadA = `canon-xthread-a-${Date.now()}`;
    const threadB = `canon-xthread-b-${Date.now()}`;

    const m = store.append({
      userId: 'u1',
      catId: null,
      content: 'in-thread-A',
      mentions: [],
      timestamp: Date.now(),
      threadId: threadA,
    });

    // Canonicalize with correct thread → v2
    const correct = store.canonicalizeCursor(m.id, threadA);
    assert.ok(correct.startsWith('v2:'), 'Correct thread should produce v2');

    // Canonicalize with wrong thread → raw ID fallback (not v2)
    const wrong = store.canonicalizeCursor(m.id, threadB);
    assert.equal(wrong, m.id, 'Wrong thread must return raw ID, not v2');
  });

  it('v2 cursor from canonicalize beats v1 raw ID in lex comparison', async () => {
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const store = new MessageStore();
    const threadId = `canon-lex-${Date.now()}`;

    const m = store.append({
      userId: 'u1',
      catId: null,
      content: 'test',
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });

    const v2Cursor = store.canonicalizeCursor(m.id, threadId);
    const v1Cursor = m.id;

    // This is the critical invariant: v2 must always lex-exceed v1
    // so SET_IF_GREATER always advances from v1 → v2
    assert.ok(v2Cursor > v1Cursor, `v2 "${v2Cursor}" must lex-exceed v1 "${v1Cursor}"`);
  });
});
