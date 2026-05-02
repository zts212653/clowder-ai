import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');

/** Helper: build a minimal enqueue input */
function entry(overrides = {}) {
  return {
    threadId: 't1',
    userId: 'u1',
    content: 'hello',
    source: 'user',
    targetCats: ['opus'],
    intent: 'execute',
    ...overrides,
  };
}

describe('InvocationQueue', () => {
  /** @type {InvocationQueue} */
  let queue;
  beforeEach(() => {
    queue = new InvocationQueue();
  });

  // ── Basic FIFO ──

  it('enqueue + dequeue FIFO order', () => {
    queue.enqueue(entry({ content: 'first' }));
    queue.enqueue(entry({ content: 'second', targetCats: ['codex'] })); // different target → no merge
    const d1 = queue.dequeue('t1', 'u1');
    assert.equal(d1.content, 'first');
    const d2 = queue.dequeue('t1', 'u1');
    assert.equal(d2.content, 'second');
  });

  it('peek does not remove entry', () => {
    queue.enqueue(entry());
    const peeked = queue.peek('t1', 'u1');
    assert.ok(peeked);
    assert.equal(queue.size('t1', 'u1'), 1);
  });

  it('returns null when dequeuing empty queue', () => {
    assert.equal(queue.dequeue('t1', 'u1'), null);
  });

  it('remove specific entry by id', () => {
    const r = queue.enqueue(entry());
    const removed = queue.remove('t1', 'u1', r.entry.id);
    assert.equal(removed.id, r.entry.id);
    assert.equal(queue.size('t1', 'u1'), 0);
  });

  it('remove returns null for non-existent entry', () => {
    assert.equal(queue.remove('t1', 'u1', 'nope'), null);
  });

  it('list returns shallow copy (not live reference)', () => {
    queue.enqueue(entry());
    const list1 = queue.list('t1', 'u1');
    list1.push(/** @type {any} */ ({})); // mutate
    assert.equal(queue.list('t1', 'u1').length, 1); // original unaffected
  });

  // ── Capacity ──

  it('enqueue returns full when at MAX_QUEUE_DEPTH', () => {
    for (let i = 0; i < 5; i++) {
      queue.enqueue(entry({ content: `msg${i}`, targetCats: [`cat${i}`] }));
    }
    const r = queue.enqueue(entry({ content: 'overflow', targetCats: ['overflow'] }));
    assert.equal(r.outcome, 'full');
    assert.equal(r.entry, undefined);
  });

  it('size only counts queued entries (not processing)', () => {
    queue.enqueue(entry({ content: 'a', targetCats: ['a'] }));
    queue.enqueue(entry({ content: 'b', targetCats: ['b'] }));
    queue.markProcessing('t1', 'u1'); // first → processing
    assert.equal(queue.size('t1', 'u1'), 1); // only 'b' counts
  });

  it('same idempotencyKey replays are deduped to one active entry', () => {
    const first = queue.enqueue(entry({ content: 'first', idempotencyKey: 'idem-1' }));
    assert.equal(first.outcome, 'enqueued');
    assert.equal(first.deduped, undefined);

    const replay = queue.enqueue(entry({ content: 'replay', idempotencyKey: 'idem-1' }));
    assert.equal(replay.outcome, 'enqueued');
    assert.equal(replay.deduped, true);
    assert.equal(replay.entry.id, first.entry.id);
    assert.equal(queue.size('t1', 'u1'), 1);
    assert.equal(queue.list('t1', 'u1')[0].content, 'first');
  });

  // ── F175: no merge — every entry is independent ──

  it('same-source same-target entries are independent (F175 no merge)', () => {
    const r1 = queue.enqueue(entry({ content: '猫猫' }));
    assert.equal(r1.outcome, 'enqueued');
    const r2 = queue.enqueue(entry({ content: '你好' }));
    assert.equal(r2.outcome, 'enqueued');
    assert.equal(queue.size('t1', 'u1'), 2);
    assert.equal(queue.list('t1', 'u1')[0].content, '猫猫');
    assert.equal(queue.list('t1', 'u1')[1].content, '你好');
  });

  it('different-source entries are independent', () => {
    queue.enqueue(entry({ source: 'user' }));
    const r2 = queue.enqueue(entry({ source: 'connector' }));
    assert.equal(r2.outcome, 'enqueued');
    assert.equal(queue.size('t1', 'u1'), 2);
  });

  it('different-targetCats entries are independent', () => {
    queue.enqueue(entry({ content: '@opus 你好', targetCats: ['opus'] }));
    const r2 = queue.enqueue(entry({ content: '@codex 帮忙看看', targetCats: ['codex'] }));
    assert.equal(r2.outcome, 'enqueued');
    assert.equal(queue.size('t1', 'u1'), 2);
  });

  it('entries after processing entry are independent', () => {
    queue.enqueue(entry({ content: 'first' }));
    queue.markProcessing('t1', 'u1');
    const r2 = queue.enqueue(entry({ content: 'second' }));
    assert.equal(r2.outcome, 'enqueued');
    assert.equal(queue.list('t1', 'u1').length, 2);
  });

  it('different-intent entries are independent', () => {
    queue.enqueue(entry({ intent: 'execute' }));
    const r2 = queue.enqueue(entry({ intent: 'whisper' }));
    assert.equal(r2.outcome, 'enqueued');
    assert.equal(queue.size('t1', 'u1'), 2);
  });

  it('consecutive connector entries are independent', () => {
    const r1 = queue.enqueue(entry({ source: 'connector', content: 'msg from user A' }));
    assert.equal(r1.outcome, 'enqueued');
    const r2 = queue.enqueue(entry({ source: 'connector', content: 'msg from user B' }));
    assert.equal(r2.outcome, 'enqueued');
    assert.equal(queue.size('t1', 'u1'), 2);
  });

  it('consecutive user entries are independent (F175)', () => {
    queue.enqueue(entry({ source: 'user', content: 'first' }));
    const r2 = queue.enqueue(entry({ source: 'user', content: 'second' }));
    assert.equal(r2.outcome, 'enqueued');
    assert.equal(queue.size('t1', 'u1'), 2);
  });

  it('preserves senderMeta on enqueued connector entry', () => {
    const r = queue.enqueue(
      entry({
        source: 'connector',
        senderMeta: { id: 'ou_abc', name: 'You' },
      }),
    );
    assert.equal(r.outcome, 'enqueued');
    assert.deepEqual(r.entry.senderMeta, { id: 'ou_abc', name: 'You' });
  });

  // ── Backfill / Merge IDs ──

  it('backfillMessageId sets messageId on new entry (null → value)', () => {
    const r = queue.enqueue(entry());
    assert.equal(r.entry.messageId, null);
    queue.backfillMessageId('t1', 'u1', r.entry.id, 'msg-123');
    assert.equal(queue.list('t1', 'u1')[0].messageId, 'msg-123');
  });

  // ── Move / reorder ──

  it('move up swaps entry with previous', () => {
    queue.enqueue(entry({ content: 'a', targetCats: ['a'] }));
    const r2 = queue.enqueue(entry({ content: 'b', targetCats: ['b'] }));
    const moved = queue.move('t1', 'u1', r2.entry.id, 'up');
    assert.equal(moved, true);
    assert.equal(queue.list('t1', 'u1')[0].content, 'b');
    assert.equal(queue.list('t1', 'u1')[1].content, 'a');
  });

  it('move down swaps entry with next', () => {
    const r1 = queue.enqueue(entry({ content: 'a', targetCats: ['a'] }));
    queue.enqueue(entry({ content: 'b', targetCats: ['b'] }));
    const moved = queue.move('t1', 'u1', r1.entry.id, 'down');
    assert.equal(moved, true);
    assert.equal(queue.list('t1', 'u1')[0].content, 'b');
  });

  it('move returns false for processing entry', () => {
    queue.enqueue(entry({ content: 'a', targetCats: ['a'] }));
    queue.enqueue(entry({ content: 'b', targetCats: ['b'] }));
    const processing = queue.markProcessing('t1', 'u1');
    assert.equal(queue.move('t1', 'u1', processing.id, 'down'), false);
  });

  it('move at boundary is no-op (returns true, idempotent)', () => {
    const r1 = queue.enqueue(entry({ content: 'only' }));
    assert.equal(queue.move('t1', 'u1', r1.entry.id, 'up'), true);
  });

  it('system continuation stays first even when user entries have explicit positions', () => {
    queue.enqueue(
      entry({
        content: 'continue sealed work',
        source: 'agent',
        sourceCategory: 'continuation',
        continuationKey: 't1:opus:inv-1:sess-1:1',
        autoExecute: true,
      }),
    );
    const user = queue.enqueue(entry({ content: 'new user request', targetCats: ['codex'] }));

    assert.equal(queue.setPosition('t1', 'u1', user.entry.id, 0), true);

    assert.equal(queue.list('t1', 'u1')[0].content, 'continue sealed work');
    assert.equal(queue.peekOldestAcrossUsers('t1').content, 'continue sealed work');
  });

  it('system continuation entries cannot be moved, promoted, or assigned user positions', () => {
    const continuation = queue.enqueue(
      entry({
        content: 'continue sealed work',
        source: 'agent',
        sourceCategory: 'continuation',
        continuationKey: 't1:opus:inv-1:sess-1:1',
        autoExecute: true,
      }),
    );
    queue.enqueue(entry({ content: 'new user request', targetCats: ['codex'] }));

    assert.equal(queue.setPosition('t1', 'u1', continuation.entry.id, 9), false);
    assert.equal(queue.move('t1', 'u1', continuation.entry.id, 'down'), false);
    assert.equal(queue.promote('t1', 'u1', continuation.entry.id), false);
    assert.equal(queue.list('t1', 'u1')[0].content, 'continue sealed work');
  });

  // ── Clear ──

  it('clear returns all removed entries', () => {
    queue.enqueue(entry({ content: 'a', targetCats: ['a'] }));
    queue.enqueue(entry({ content: 'b', targetCats: ['b'] }));
    const cleared = queue.clear('t1', 'u1');
    assert.equal(cleared.length, 2);
    assert.equal(queue.size('t1', 'u1'), 0);
  });

  // ── markProcessing / removeProcessed ──

  it('markProcessing returns entry with status=processing', () => {
    queue.enqueue(entry());
    const p = queue.markProcessing('t1', 'u1');
    assert.equal(p.status, 'processing');
    assert.equal(queue.list('t1', 'u1')[0].status, 'processing');
  });

  it('markProcessing returns null on empty queue', () => {
    assert.equal(queue.markProcessing('t1', 'u1'), null);
  });

  it('removeProcessed removes processing entry by entryId', () => {
    const r = queue.enqueue(entry());
    const marked = queue.markProcessing('t1', 'u1');
    const removed = queue.removeProcessed('t1', 'u1', marked.id);
    assert.ok(removed);
    assert.equal(removed.id, r.entry.id);
    assert.equal(queue.list('t1', 'u1').length, 0);
  });

  // ── Cross-user isolation (scopeKey) ──

  it('different users in same thread are isolated', () => {
    queue.enqueue(entry({ userId: 'alice', content: 'alice msg' }));
    queue.enqueue(entry({ userId: 'bob', content: 'bob msg' }));
    assert.equal(queue.size('t1', 'alice'), 1);
    assert.equal(queue.size('t1', 'bob'), 1);
    assert.equal(queue.list('t1', 'alice')[0].content, 'alice msg');
    assert.equal(queue.list('t1', 'bob')[0].content, 'bob msg');
  });

  // ── Cross-user system methods ──

  it('peekOldestAcrossUsers returns earliest across all users', () => {
    queue.enqueue(entry({ userId: 'bob', content: 'bob first' }));
    queue.enqueue(entry({ userId: 'alice', content: 'alice second' }));
    const oldest = queue.peekOldestAcrossUsers('t1');
    assert.equal(oldest.content, 'bob first');
  });

  it('markProcessingAcrossUsers marks oldest entry', () => {
    queue.enqueue(entry({ userId: 'bob', content: 'bob' }));
    queue.enqueue(entry({ userId: 'alice', content: 'alice' }));
    const p = queue.markProcessingAcrossUsers('t1');
    assert.equal(p.userId, 'bob');
    assert.equal(p.status, 'processing');
  });

  it('removeProcessedAcrossUsers removes processing entry by entryId', () => {
    queue.enqueue(entry({ userId: 'bob' }));
    const marked = queue.markProcessingAcrossUsers('t1');
    const removed = queue.removeProcessedAcrossUsers('t1', marked.id);
    assert.equal(removed.userId, 'bob');
    assert.equal(queue.list('t1', 'bob').length, 0);
  });

  it('hasQueuedForThread returns true when any user has queued entries', () => {
    assert.equal(queue.hasQueuedForThread('t1'), false);
    queue.enqueue(entry({ userId: 'alice' }));
    assert.equal(queue.hasQueuedForThread('t1'), true);
  });

  it('hasQueuedForThread ignores stale queued entries', () => {
    queue.enqueue(entry({ userId: 'alice' }));
    const listed = queue.list('t1', 'alice');
    listed[0].createdAt = Date.now() - InvocationQueue.STALE_QUEUED_THRESHOLD_MS - 1;

    assert.equal(
      queue.hasQueuedForThread('t1'),
      false,
      'stale queued entries must not permanently force thread-wide broadcast messages into queue mode',
    );
  });

  it('hasDispatchableQueuedForThread keeps stale user entries visible for dispatch', () => {
    queue.enqueue(entry({ userId: 'alice', source: 'user' }));
    const listed = queue.list('t1', 'alice');
    listed[0].createdAt = Date.now() - InvocationQueue.STALE_QUEUED_THRESHOLD_MS - 1;

    assert.equal(queue.hasQueuedForThread('t1'), false, 'freshness/fairness gate should still ignore stale user work');
    assert.equal(
      queue.hasDispatchableQueuedForThread('t1'),
      true,
      'dispatch gate must still see stale user work as pending queue work',
    );
  });

  it('hasDispatchableQueuedForThread keeps stale connector entries visible for dispatch', () => {
    queue.enqueue(entry({ userId: 'alice', source: 'connector' }));
    const listed = queue.list('t1', 'alice');
    listed[0].createdAt = Date.now() - InvocationQueue.STALE_QUEUED_THRESHOLD_MS - 1;

    assert.equal(
      queue.hasQueuedForThread('t1'),
      false,
      'freshness/fairness gate should still ignore stale connector work',
    );
    assert.equal(
      queue.hasDispatchableQueuedForThread('t1'),
      true,
      'dispatch gate must still see stale connector work as pending queue work',
    );
  });

  // ── Cross-thread isolation ──

  it('different threads are fully isolated', () => {
    queue.enqueue(entry({ threadId: 't1' }));
    queue.enqueue(entry({ threadId: 't2' }));
    assert.equal(queue.size('t1', 'u1'), 1);
    assert.equal(queue.size('t2', 'u1'), 1);
    queue.clear('t1', 'u1');
    assert.equal(queue.size('t1', 'u1'), 0);
    assert.equal(queue.size('t2', 'u1'), 1);
  });

  // ── queuePosition ──

  it('enqueue returns 1-based queuePosition', () => {
    const r1 = queue.enqueue(entry({ targetCats: ['a'] }));
    assert.equal(r1.queuePosition, 1);
    const r2 = queue.enqueue(entry({ targetCats: ['b'] }));
    assert.equal(r2.queuePosition, 2);
  });

  // ── P1-1 fix: removeProcessed by entryId ──

  it('removeProcessed with wrong entryId does NOT remove', () => {
    queue.enqueue(entry({ userId: 'u1', targetCats: ['a'] }));
    queue.markProcessing('t1', 'u1');
    // Pass wrong entryId — should NOT remove
    const removed = queue.removeProcessed('t1', 'u1', 'wrong-id');
    assert.equal(removed, null);
    // Entry should still be there
    assert.equal(queue.list('t1', 'u1').length, 1);
  });

  it('removeProcessedAcrossUsers with wrong entryId does NOT remove', () => {
    queue.enqueue(entry({ userId: 'u1', targetCats: ['a'] }));
    queue.markProcessingAcrossUsers('t1');
    // Pass wrong entryId — should NOT remove
    const removed = queue.removeProcessedAcrossUsers('t1', 'wrong-id');
    assert.equal(removed, null);
  });

  // ── rollbackEnqueue removes entry (F175: no merge, simplified) ──

  it('rollbackEnqueue removes the entry from queue', () => {
    const rA = queue.enqueue(entry({ content: 'A msg' }));
    queue.enqueue(entry({ content: 'B msg' }));
    queue.rollbackEnqueue('t1', 'u1', rA.entry.id);
    const afterRollback = queue.list('t1', 'u1');
    assert.equal(afterRollback.length, 1);
    assert.equal(afterRollback[0].content, 'B msg');
  });

  it('clear() purges originalContents metadata', () => {
    queue.enqueue(entry({ content: 'a' }));
    queue.enqueue(entry({ content: 'b' }));
    const cleared = queue.clear('t1', 'u1');
    assert.equal(cleared.length, 2);
    assert.equal(queue.list('t1', 'u1').length, 0);
  });

  // ── Old queued agent entry defense (review P1/P2) ──

  it('enqueue keeps old agent tail entry live while preserving F175 no-merge semantics', () => {
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'stale handoff',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    // Backdate to make it stale
    const listed = queue.list('t1', 'system');
    listed[0].createdAt = Date.now() - 120_000;

    // New A2A handoff for same cat stays independent under F175, and the old entry is not pruned.
    const r2 = queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'fresh handoff',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    assert.equal(r2.outcome, 'enqueued', 'F175 keeps queued entries independent instead of merging');
    assert.equal(queue.list('t1', 'system').length, 2, 'old queued agent work is still live pending work');
  });

  it('countAgentEntriesForThread includes old queued agent entries', () => {
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'stale',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'fresh',
      source: 'agent',
      targetCats: ['opus'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'codex',
    });
    // Backdate first entry to make it stale
    const listed = queue.list('t1', 'system');
    listed[0].createdAt = Date.now() - 120_000;

    assert.equal(
      queue.countAgentEntriesForThread('t1'),
      2,
      'old queued agent entries still count because they are pending work, not zombies',
    );
  });

  it('agent enqueue bypasses user depth while old queued agent entries remain pending work', () => {
    // Fill to MAX_QUEUE_DEPTH with agent entries, then backdate them all.
    for (let i = 0; i < 5; i++) {
      queue.enqueue({
        threadId: 't1',
        userId: 'system',
        content: `stale-${i}`,
        source: 'agent',
        targetCats: [`cat${i}`],
        intent: 'execute',
        autoExecute: true,
        callerCatId: 'opus',
      });
    }
    const listed = queue.list('t1', 'system');
    for (const e of listed) {
      e.createdAt = Date.now() - 120_000; // stale (> 60s threshold)
    }

    // F175 only depth-limits user messages; agent work bypasses user queue depth but remains counted.
    const r = queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'fresh handoff',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    assert.equal(r.outcome, 'enqueued');
    assert.equal(queue.countAgentEntriesForThread('t1'), 6);
  });

  it('hasQueuedForThread keeps old queued agent entries visible for dispatch', () => {
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'stale handoff',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    const listed = queue.list('t1', 'system');
    listed[0].createdAt = Date.now() - InvocationQueue.STALE_QUEUED_THRESHOLD_MS - 1;

    assert.equal(queue.hasQueuedForThread('t1'), true);
    assert.equal(queue.list('t1', 'system').length, 1, 'old agent row must remain queued for dispatch');
  });

  it('markProcessingAcrossUsers dispatches old queued agent entries instead of deleting them', () => {
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'stale handoff',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    const stale = queue.list('t1', 'system');
    stale[0].createdAt = Date.now() - InvocationQueue.STALE_QUEUED_THRESHOLD_MS - 1;

    queue.enqueue(entry({ userId: 'alice', content: 'fresh user work' }));
    const marked = queue.markProcessingAcrossUsers('t1');

    assert.equal(marked.userId, 'system');
    assert.equal(marked.content, 'stale handoff');
    assert.equal(queue.list('t1', 'system')[0].status, 'processing');
  });

  // ── F122B: agent source + autoExecute ──

  it('accepts agent source with autoExecute and callerCatId', () => {
    const result = queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'A2A handoff',
      source: 'agent',
      targetCats: ['opus'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'codex',
    });
    assert.equal(result.outcome, 'enqueued');
    assert.equal(result.entry.source, 'agent');
    assert.equal(result.entry.autoExecute, true);
    assert.equal(result.entry.callerCatId, 'codex');
  });

  it('autoExecute defaults to false when not provided', () => {
    const result = queue.enqueue(entry());
    assert.equal(result.entry.autoExecute, false);
    assert.equal(result.entry.callerCatId, undefined);
  });

  it('agent entries do not merge with user entries', () => {
    queue.enqueue(entry({ content: 'user msg' }));
    const r2 = queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'A2A handoff',
      source: 'agent',
      targetCats: ['opus'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'codex',
    });
    // Different userId (system vs u1) → different scope key → never merge
    assert.equal(r2.outcome, 'enqueued');
  });

  // ── hasQueuedAgentForCat: only checks 'queued' (callback-path dedup) ──

  it('hasQueuedAgentForCat returns true for queued agent entry', () => {
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'callback handoff',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    assert.equal(queue.hasQueuedAgentForCat('t1', 'codex'), true);
    assert.equal(queue.hasQueuedAgentForCat('t1', 'opus'), false);
  });

  it('hasQueuedAgentForCat returns false for processing entries (allows new handoffs to enqueue)', () => {
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'callback handoff',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    queue.markProcessing('t1', 'system');
    assert.equal(
      queue.hasQueuedAgentForCat('t1', 'codex'),
      false,
      'processing entries must not block new callback handoffs (P1-1 fix)',
    );
  });

  it('hasQueuedAgentForCat returns false for user-sourced entries', () => {
    queue.enqueue(entry({ targetCats: ['opus'] }));
    assert.equal(queue.hasQueuedAgentForCat('t1', 'opus'), false, 'user entries should not block A2A dedup');
  });

  it('hasQueuedAgentForCat returns true for old queued entry (> STALE_QUEUED_THRESHOLD_MS)', () => {
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'callback handoff',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    // Backdate createdAt to 2 minutes ago — well past the 60s stale threshold
    const listed = queue.list('t1', 'system');
    listed[0].createdAt = Date.now() - 120_000;
    assert.equal(
      queue.hasQueuedAgentForCat('t1', 'codex'),
      true,
      'old queued entry (>60s) remains valid pending work and should block duplicate A2A enqueue',
    );
  });

  it('hasQueuedAgentForCat returns false after entry completes', () => {
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'handoff',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    const e = queue.markProcessing('t1', 'system');
    queue.removeProcessed('t1', 'system', e.id);
    assert.equal(queue.hasQueuedAgentForCat('t1', 'codex'), false);
  });

  it('listAutoExecute includes old queued entries older than threshold', () => {
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'fresh',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'stale',
      source: 'agent',
      targetCats: ['opencode'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });

    // list() returns shallow-copied array with reference elements — mutating
    // createdAt here reaches the real entry inside the queue (coupling on purpose).
    const listed = queue.list('t1', 'system');
    listed[1].createdAt = Date.now() - InvocationQueue.STALE_QUEUED_THRESHOLD_MS - 1;

    const autoEntries = queue.listAutoExecute('t1');
    assert.equal(autoEntries.length, 2, 'old queued autoExecute entries must remain dispatchable');
    assert.deepEqual(autoEntries.map((entry) => entry.targetCats[0]).sort(), ['codex', 'opencode']);
  });

  it('hasQueuedOrProcessingForCat treats old queued autoExecute entries as busy', () => {
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'stale but still dispatchable',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });

    const listed = queue.list('t1', 'system');
    listed[0].createdAt = Date.now() - InvocationQueue.STALE_QUEUED_THRESHOLD_MS - 1;

    assert.equal(
      queue.hasQueuedOrProcessingForCat('t1', 'codex'),
      true,
      'busy check must match listAutoExecute: old queued autoExecute work is still dispatchable',
    );
  });

  // ── hasActiveOrQueuedAgentForCat: processing + queued entries block, regardless of queued age ──

  it('hasActiveOrQueuedAgentForCat returns true for fresh queued entry (cross-path dedup)', () => {
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'handoff',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    assert.equal(
      queue.hasActiveOrQueuedAgentForCat('t1', 'codex'),
      true,
      'fresh queued entry must block text-scan to prevent double-trigger',
    );
  });

  it('hasActiveOrQueuedAgentForCat returns true for old queued entry (> threshold)', () => {
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'handoff',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    // Simulate stale by backdating createdAt
    const q = queue.list('t1', 'system');
    q[0].createdAt = Date.now() - 120_000; // 2 minutes ago
    assert.equal(
      queue.hasActiveOrQueuedAgentForCat('t1', 'codex'),
      true,
      'old queued entry (>60s) is still pending work and must block duplicate text-scan A2A',
    );
  });

  it('hasActiveOrQueuedAgentForCat returns true for processing entry (prevents text-scan double-trigger)', () => {
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'handoff',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    queue.markProcessing('t1', 'system');
    assert.equal(
      queue.hasActiveOrQueuedAgentForCat('t1', 'codex'),
      true,
      'must detect processing entries to prevent text-scan double-trigger',
    );
  });

  it('hasActiveOrQueuedAgentForCat returns false after entry completes', () => {
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'handoff',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    const e = queue.markProcessing('t1', 'system');
    queue.removeProcessed('t1', 'system', e.id);
    assert.equal(queue.hasActiveOrQueuedAgentForCat('t1', 'codex'), false);
  });

  it('hasQueuedOrProcessingForCat does not match another thread by prefix collision', () => {
    queue.enqueue({
      threadId: 't1:child',
      userId: 'u1',
      content: 'queued in another thread',
      source: 'user',
      targetCats: ['codex'],
      intent: 'execute',
    });

    assert.equal(
      queue.hasQueuedOrProcessingForCat('t1', 'codex'),
      false,
      'thread t1 must not inherit queued entries from thread t1:child',
    );
    assert.equal(queue.hasQueuedOrProcessingForCat('t1:child', 'codex'), true);
  });

  it('hasActiveOrQueuedAgentForCat still blocks for fresh processing entry (< STALE_PROCESSING_THRESHOLD)', () => {
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'handoff',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    queue.markProcessing('t1', 'system');
    // Backdate processingStartedAt to 5 minutes — well within the 10-minute threshold
    const listed = queue.list('t1', 'system');
    listed[0].processingStartedAt = Date.now() - 5 * 60_000;
    assert.equal(
      queue.hasActiveOrQueuedAgentForCat('t1', 'codex'),
      true,
      'fresh processing entry (5 min) must still block text-scan dedup',
    );
  });

  it('hasActiveOrQueuedAgentForCat still blocks when entry queued long ago but just started processing', () => {
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'handoff',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    // Backdate createdAt to 11 minutes ago (sat in queue a long time)
    const listed = queue.list('t1', 'system');
    listed[0].createdAt = Date.now() - 11 * 60_000;
    // NOW start processing — processingStartedAt should be fresh
    queue.markProcessing('t1', 'system');
    assert.equal(
      queue.hasActiveOrQueuedAgentForCat('t1', 'codex'),
      true,
      'entry queued 11 min ago but just started processing must still block (P1 regression)',
    );
  });

  it('hasActiveOrQueuedAgentForCat returns false for stale processing entry (> STALE_PROCESSING_THRESHOLD)', () => {
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'handoff',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    queue.markProcessing('t1', 'system');
    // Backdate processingStartedAt to 11 minutes — beyond the 10-minute threshold
    const listed = queue.list('t1', 'system');
    listed[0].processingStartedAt = Date.now() - 11 * 60_000;
    assert.equal(
      queue.hasActiveOrQueuedAgentForCat('t1', 'codex'),
      false,
      'stale processing entry (11 min) must NOT block text-scan — zombie defense',
    );
  });

  // ── hasQueuedUserMessagesForThread: fairness gate must only count user-sourced entries ──

  it('hasQueuedUserMessagesForThread returns false when only agent entries are queued', () => {
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      content: 'handoff',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    assert.equal(
      queue.hasQueuedUserMessagesForThread('t1'),
      false,
      'agent-sourced entries must NOT block A2A text-scan fairness gate',
    );
    // Sanity: unfiltered hasQueuedForThread still sees it
    assert.equal(queue.hasQueuedForThread('t1'), true);
  });

  it('hasQueuedUserMessagesForThread returns true when user entry is queued', () => {
    queue.enqueue(entry({ source: 'user' }));
    assert.equal(
      queue.hasQueuedUserMessagesForThread('t1'),
      true,
      'user-sourced entries must block A2A text-scan to respect queue fairness',
    );
  });

  it('hasQueuedUserMessagesForThread ignores connector entries (treated like agent)', () => {
    queue.enqueue(entry({ source: 'connector' }));
    assert.equal(
      queue.hasQueuedUserMessagesForThread('t1'),
      false,
      'connector-sourced entries should not block A2A text-scan',
    );
  });

  // ── F175: priority / sourceCategory / position fields ──

  it('enqueue preserves priority field', () => {
    const result = queue.enqueue(entry({ priority: 'urgent', sourceCategory: 'ci' }));
    assert.equal(result.entry.priority, 'urgent');
    assert.equal(result.entry.sourceCategory, 'ci');
  });

  it('defaults priority to normal when omitted', () => {
    const result = queue.enqueue(entry());
    assert.equal(result.entry.priority, 'normal');
    assert.equal(result.entry.sourceCategory, undefined);
    assert.equal(result.entry.position, undefined);
  });

  it('priority field survives list() round-trip', () => {
    queue.enqueue(entry({ priority: 'urgent', sourceCategory: 'review' }));
    const listed = queue.list('t1', 'u1');
    assert.equal(listed[0].priority, 'urgent');
    assert.equal(listed[0].sourceCategory, 'review');
  });

  it('position field is undefined by default', () => {
    const result = queue.enqueue(entry());
    assert.equal(result.entry.position, undefined);
  });

  // ── F175: no merge — every message is independent ──

  it('same-source same-target user messages are NOT merged (F175)', () => {
    queue.enqueue(entry({ content: 'a' }));
    queue.enqueue(entry({ content: 'b' }));
    const list = queue.list('t1', 'u1');
    assert.equal(list.length, 2);
    assert.equal(list[0].content, 'a');
    assert.equal(list[1].content, 'b');
  });

  // ── F175: source-specific capacity ──

  it('connector messages bypass MAX_QUEUE_DEPTH (F175)', () => {
    for (let i = 0; i < 7; i++) {
      const r = queue.enqueue(entry({ content: `msg${i}`, source: 'connector', targetCats: ['c1'] }));
      assert.equal(r.outcome, 'enqueued', `connector entry ${i} should enqueue`);
    }
    assert.equal(queue.list('t1', 'u1').length, 7);
  });

  it('agent messages bypass MAX_QUEUE_DEPTH (F175)', () => {
    for (let i = 0; i < 7; i++) {
      const r = queue.enqueue(entry({ content: `msg${i}`, source: 'agent', targetCats: [`c${i}`] }));
      assert.equal(r.outcome, 'enqueued', `agent entry ${i} should enqueue`);
    }
  });

  it('user messages still limited by MAX_QUEUE_DEPTH (F175)', () => {
    for (let i = 0; i < 5; i++) {
      queue.enqueue(entry({ content: `msg${i}`, targetCats: [`c${i}`] }));
    }
    const r = queue.enqueue(entry({ content: 'overflow', targetCats: ['overflow'] }));
    assert.equal(r.outcome, 'full');
  });

  // ── F175: multi-dimensional dequeue ordering ──

  it('urgent entry dequeues before normal via peekOldestAcrossUsers', () => {
    queue.enqueue(entry({ userId: 'u1', content: 'normal-first', priority: 'normal' }));
    queue.enqueue(
      entry({ userId: 'u2', content: 'urgent-second', source: 'connector', targetCats: ['c1'], priority: 'urgent' }),
    );
    const next = queue.peekOldestAcrossUsers('t1');
    assert.equal(next.content, 'urgent-second');
    assert.equal(next.priority, 'urgent');
  });

  it('same priority orders by createdAt (FIFO)', () => {
    queue.enqueue(entry({ userId: 'u1', content: 'first', priority: 'normal' }));
    queue.enqueue(
      entry({ userId: 'u2', content: 'second', source: 'connector', targetCats: ['c1'], priority: 'normal' }),
    );
    const next = queue.peekOldestAcrossUsers('t1');
    assert.equal(next.content, 'first');
  });

  it('markProcessingAcrossUsers picks urgent before normal', () => {
    queue.enqueue(entry({ userId: 'u1', content: 'normal', priority: 'normal' }));
    queue.enqueue(
      entry({ userId: 'u2', content: 'urgent', source: 'connector', targetCats: ['c1'], priority: 'urgent' }),
    );
    const picked = queue.markProcessingAcrossUsers('t1');
    assert.equal(picked.content, 'urgent');
    assert.equal(picked.status, 'processing');
  });

  it('explicit position overrides priority in dequeue', () => {
    queue.enqueue(
      entry({ userId: 'u1', content: 'urgent-no-pos', source: 'connector', targetCats: ['c1'], priority: 'urgent' }),
    );
    const r = queue.enqueue(
      entry({ userId: 'u1', content: 'normal-with-pos', targetCats: ['c2'], priority: 'normal' }),
    );
    queue.setPosition('t1', 'u1', r.entry.id, 0);
    const next = queue.peekOldestAcrossUsers('t1');
    assert.equal(next.content, 'normal-with-pos');
  });

  it('setPosition returns false for processing entry', () => {
    queue.enqueue(entry({ content: 'a' }));
    const processing = queue.markProcessing('t1', 'u1');
    assert.equal(queue.setPosition('t1', 'u1', processing.id, 0), false);
  });

  it('setPosition returns false for non-existent entry', () => {
    assert.equal(queue.setPosition('t1', 'u1', 'nonexistent', 0), false);
  });

  it('position does not let one user jump ahead of another in cross-user scheduling', () => {
    queue.enqueue(entry({ userId: 'alice', content: 'alice-first' }));
    const bobEntry = queue.enqueue(entry({ userId: 'bob', content: 'bob-second' }));
    queue.setPosition('t1', 'bob', bobEntry.entry.id, 0);

    const next = queue.peekOldestAcrossUsers('t1');
    assert.equal(next.userId, 'alice', 'alice enqueued first — position should not let bob jump ahead cross-user');
  });

  // ── F175 Task 5: collectUserBatch ──

  it('collectUserBatch collects adjacent user entries with same userId+intent+targetCats', () => {
    queue.enqueue(entry({ content: 'a', source: 'user', targetCats: ['c1'], intent: 'execute' }));
    queue.enqueue(entry({ content: 'b', source: 'user', targetCats: ['c1'], intent: 'execute' }));
    queue.enqueue(entry({ content: 'c', source: 'user', targetCats: ['c1'], intent: 'execute' }));
    const batch = queue.collectUserBatch('t1', 'u1');
    assert.equal(batch.length, 3);
    assert.equal(batch.map((e) => e.content).join('\n'), 'a\nb\nc');
  });

  it('collectUserBatch stops at different intent', () => {
    queue.enqueue(entry({ content: 'a', source: 'user', targetCats: ['c1'], intent: 'execute' }));
    queue.enqueue(entry({ content: 'b', source: 'user', targetCats: ['c1'], intent: 'search' }));
    const batch = queue.collectUserBatch('t1', 'u1');
    assert.equal(batch.length, 1);
    assert.equal(batch[0].content, 'a');
  });

  it('collectUserBatch stops at connector/agent entry', () => {
    queue.enqueue(entry({ content: 'a', source: 'user', targetCats: ['c1'], intent: 'execute' }));
    queue.enqueue(entry({ content: 'b', source: 'connector', targetCats: ['c1'], intent: 'execute' }));
    queue.enqueue(entry({ content: 'c', source: 'user', targetCats: ['c1'], intent: 'execute' }));
    const batch = queue.collectUserBatch('t1', 'u1');
    assert.equal(batch.length, 1);
  });

  it('collectUserBatch does not batch across different targetCats', () => {
    queue.enqueue(entry({ content: 'a', source: 'user', targetCats: ['c1'], intent: 'execute' }));
    queue.enqueue(entry({ content: 'b', source: 'user', targetCats: ['c1', 'c2'], intent: 'execute' }));
    const batch = queue.collectUserBatch('t1', 'u1');
    assert.equal(batch.length, 1);
  });

  it('collectUserBatch returns single-entry batch for connector source', () => {
    queue.enqueue(entry({ content: 'a', source: 'connector', targetCats: ['c1'], intent: 'execute' }));
    queue.enqueue(entry({ content: 'b', source: 'connector', targetCats: ['c1'], intent: 'execute' }));
    const batch = queue.collectUserBatch('t1', 'u1');
    assert.equal(batch.length, 1);
    assert.equal(batch[0].content, 'a');
  });

  it('collectUserBatch returns empty array for empty queue', () => {
    const batch = queue.collectUserBatch('t1', 'u1');
    assert.equal(batch.length, 0);
  });

  it('collectUserBatch skips processing entries and starts from first queued', () => {
    queue.enqueue(entry({ content: 'processing', source: 'user', targetCats: ['c1'], intent: 'execute' }));
    queue.markProcessing('t1', 'u1');
    queue.enqueue(entry({ content: 'a', source: 'user', targetCats: ['c1'], intent: 'execute' }));
    queue.enqueue(entry({ content: 'b', source: 'user', targetCats: ['c1'], intent: 'execute' }));
    const batch = queue.collectUserBatch('t1', 'u1');
    assert.equal(batch.length, 2);
    assert.equal(batch[0].content, 'a');
    assert.equal(batch[1].content, 'b');
  });

  // ── P2-3 fix: markProcessing/peekNextQueued must respect comparator ──

  it('markProcessing respects position override (P2-3)', () => {
    const rA = queue.enqueue(entry({ content: 'A' }));
    const rB = queue.enqueue(entry({ content: 'B' }));
    queue.setPosition('t1', 'u1', rB.entry.id, 0);

    const processing = queue.markProcessing('t1', 'u1');
    assert.equal(processing.content, 'B', 'markProcessing should pick position-0 entry first');
  });

  it('peekNextQueued respects priority ordering (P2-3)', () => {
    queue.enqueue(entry({ content: 'normal', priority: 'normal' }));
    queue.enqueue(entry({ content: 'urgent', priority: 'urgent' }));

    const next = queue.peekNextQueued('t1', 'u1');
    assert.equal(next.content, 'urgent', 'peekNextQueued should return urgent entry first');
  });

  // ── R2-P1: promote() must win over existing position in comparator ──

  it('promote() makes entry win comparator even when another has position=0 (R2-P1)', () => {
    const rA = queue.enqueue(entry({ content: 'A' }));
    const rB = queue.enqueue(entry({ content: 'B' }));
    queue.setPosition('t1', 'u1', rB.entry.id, 0);

    queue.promote('t1', 'u1', rA.entry.id);

    const next = queue.peekNextQueued('t1', 'u1');
    assert.equal(next.content, 'A', 'promoted entry should beat position=0 in comparator');
  });

  it('move(up) swaps position with neighbor in comparator order (R2-P1)', () => {
    const rA = queue.enqueue(entry({ content: 'A' }));
    const rB = queue.enqueue(entry({ content: 'B' }));
    queue.setPosition('t1', 'u1', rA.entry.id, 5);
    queue.setPosition('t1', 'u1', rB.entry.id, 0);

    // B is at position 0 (first), A is at position 5 (second)
    // move A up → should swap with B
    queue.move('t1', 'u1', rA.entry.id, 'up');

    const next = queue.peekNextQueued('t1', 'u1');
    assert.equal(next.content, 'A', 'after move up, A should be first in comparator');
  });

  it('move(up) on 3+ entries without positions only swaps adjacent pair (R3-P1)', () => {
    queue.enqueue(entry({ content: 'A' }));
    queue.enqueue(entry({ content: 'B' }));
    const rC = queue.enqueue(entry({ content: 'C' }));

    queue.move('t1', 'u1', rC.entry.id, 'up');

    const items = queue.list('t1', 'u1').map((e) => e.content);
    assert.deepStrictEqual(items, ['A', 'C', 'B'], 'move(C, up) should only swap C and B');
  });

  it('move(down) on 3+ entries without positions only swaps adjacent pair (R3-P1)', () => {
    queue.enqueue(entry({ content: 'A' }));
    const rB = queue.enqueue(entry({ content: 'B' }));
    queue.enqueue(entry({ content: 'C' }));

    queue.move('t1', 'u1', rB.entry.id, 'down');

    const items = queue.list('t1', 'u1').map((e) => e.content);
    assert.deepStrictEqual(items, ['A', 'C', 'B'], 'move(B, down) should only swap B and C');
  });

  // ── R2-P2: collectUserBatch returns entries in comparator order ──

  it('collectUserBatch returns entries sorted by comparator (R2-P2)', () => {
    queue.enqueue(entry({ content: 'B' }));
    const rD = queue.enqueue(entry({ content: 'D' }));
    const rE = queue.enqueue(entry({ content: 'E' }));
    // Array order: B, D, E. Set positions: D=0, E=1, B=2
    queue.setPosition('t1', 'u1', rD.entry.id, 0);
    queue.setPosition('t1', 'u1', rE.entry.id, 1);
    // B has no position → comparator puts it after positioned entries

    // Mark D as processing (simulating processNext picked it)
    queue.markProcessing('t1', 'u1');

    const batch = queue.collectUserBatch('t1', 'u1');
    const contents = batch.map((e) => e.content);
    assert.deepStrictEqual(contents, ['E', 'B'], 'batch should follow comparator order: E(pos=1) then B(no pos)');
  });
});
