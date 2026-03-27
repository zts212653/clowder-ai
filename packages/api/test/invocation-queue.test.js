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

  // ── Merge ──

  it('merges same-source same-target consecutive entries', () => {
    const r1 = queue.enqueue(entry({ content: '猫猫' }));
    assert.equal(r1.outcome, 'enqueued');

    const r2 = queue.enqueue(entry({ content: '你好' }));
    assert.equal(r2.outcome, 'merged');
    assert.equal(r2.entry.content, '猫猫\n你好');
    assert.equal(queue.size('t1', 'u1'), 1);
  });

  it('does NOT merge different-source entries', () => {
    queue.enqueue(entry({ source: 'user' }));
    const r2 = queue.enqueue(entry({ source: 'connector' }));
    assert.equal(r2.outcome, 'enqueued');
    assert.equal(queue.size('t1', 'u1'), 2);
  });

  it('does NOT merge different-targetCats entries', () => {
    queue.enqueue(entry({ content: '@opus 你好', targetCats: ['opus'] }));
    const r2 = queue.enqueue(entry({ content: '@codex 帮忙看看', targetCats: ['codex'] }));
    assert.equal(r2.outcome, 'enqueued');
    assert.equal(queue.size('t1', 'u1'), 2);
  });

  it('does NOT merge if tail is processing', () => {
    queue.enqueue(entry({ content: 'first' }));
    queue.markProcessing('t1', 'u1');
    const r2 = queue.enqueue(entry({ content: 'second' }));
    assert.equal(r2.outcome, 'enqueued');
    assert.equal(queue.list('t1', 'u1').length, 2);
  });

  it('does NOT merge different-intent entries', () => {
    queue.enqueue(entry({ intent: 'execute' }));
    const r2 = queue.enqueue(entry({ intent: 'whisper' }));
    assert.equal(r2.outcome, 'enqueued');
    assert.equal(queue.size('t1', 'u1'), 2);
  });

  // ── F134: connector messages never merge ──

  it('does NOT merge consecutive connector entries (F134 group chat safety)', () => {
    const r1 = queue.enqueue(entry({ source: 'connector', content: 'msg from user A' }));
    assert.equal(r1.outcome, 'enqueued');
    const r2 = queue.enqueue(entry({ source: 'connector', content: 'msg from user B' }));
    assert.equal(r2.outcome, 'enqueued');
    assert.equal(queue.size('t1', 'u1'), 2);
  });

  it('still merges consecutive user entries (F134 does not affect non-connector)', () => {
    queue.enqueue(entry({ source: 'user', content: 'first' }));
    const r2 = queue.enqueue(entry({ source: 'user', content: 'second' }));
    assert.equal(r2.outcome, 'merged');
    assert.equal(queue.size('t1', 'u1'), 1);
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

  it('appendMergedMessageId adds to mergedMessageIds (does NOT overwrite messageId)', () => {
    const r1 = queue.enqueue(entry({ content: 'hi' }));
    queue.backfillMessageId('t1', 'u1', r1.entry.id, 'msg-1');

    const r2 = queue.enqueue(entry({ content: 'hello' }));
    assert.equal(r2.outcome, 'merged');
    queue.appendMergedMessageId('t1', 'u1', r2.entry.id, 'msg-2');

    const e = queue.list('t1', 'u1')[0];
    assert.equal(e.messageId, 'msg-1'); // NOT overwritten
    assert.deepEqual(e.mergedMessageIds, ['msg-2']);
  });

  // ── Merge rollback ──

  it('rollbackMerge restores pre-merge content', () => {
    queue.enqueue(entry({ content: '猫猫' }));
    const r2 = queue.enqueue(entry({ content: '你好' }));
    assert.equal(r2.outcome, 'merged');
    assert.equal(r2.entry.content, '猫猫\n你好');

    queue.rollbackMerge('t1', 'u1', r2.entry.id);
    assert.equal(queue.list('t1', 'u1')[0].content, '猫猫');
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

  // ── Cloud R2 P1: rollbackEnqueue must clear preMergeSnapshots ──

  it('rollbackEnqueue clears preMergeSnapshots so subsequent rollbackMerge does not restore ghost content', () => {
    // A enqueues
    const rA = queue.enqueue(entry({ content: 'A msg' }));
    const entryId = rA.entry.id;

    // B merges into A (same user/source/target/intent)
    queue.enqueue(entry({ content: 'B msg' }));

    // A's write fails → rollbackEnqueue strips A's content, keeps B's
    queue.rollbackEnqueue('t1', 'u1', entryId);
    const afterRollback = queue.list('t1', 'u1');
    assert.equal(afterRollback.length, 1);
    assert.equal(afterRollback[0].content, 'B msg');

    // Now B's write also fails → rollbackMerge should NOT restore A's ghost content
    queue.rollbackMerge('t1', 'u1', entryId);
    const afterBRollback = queue.list('t1', 'u1');
    // Entry should still have B's content (or be removed), NOT A's
    assert.ok(
      !afterBRollback[0]?.content.includes('A msg'),
      'rollbackMerge after rollbackEnqueue should not reintroduce A ghost content',
    );
  });

  // ── Cloud R3 P2: rollbackEnqueue must promote merged messageId ──

  it('rollbackEnqueue promotes mergedMessageIds[0] to messageId', () => {
    // A enqueues
    const rA = queue.enqueue(entry({ content: 'A msg' }));
    const entryId = rA.entry.id;

    // B merges into A
    const _rB = queue.enqueue(entry({ content: 'B msg' }));

    // Simulate B's messageStore.append succeeded → appendMergedMessageId
    queue.appendMergedMessageId('t1', 'u1', entryId, 'msg-B');

    // A's write fails → rollbackEnqueue
    queue.rollbackEnqueue('t1', 'u1', entryId);

    const remaining = queue.list('t1', 'u1');
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].content, 'B msg');
    // messageId should be promoted from mergedMessageIds, not null
    assert.equal(
      remaining[0].messageId,
      'msg-B',
      'rollbackEnqueue should promote surviving mergedMessageIds[0] to messageId',
    );
    // mergedMessageIds should have the promoted ID removed
    assert.ok(!remaining[0].mergedMessageIds.includes('msg-B'), 'promoted ID should be removed from mergedMessageIds');
  });

  // ── Cloud R2 P2: clear() must purge rollback metadata ──

  it('clear() purges originalContents and preMergeSnapshots', () => {
    // Enqueue + merge to populate both metadata maps
    const _rA = queue.enqueue(entry({ content: 'original' }));
    queue.enqueue(entry({ content: 'merged' })); // merges into A

    // Clear the queue
    const cleared = queue.clear('t1', 'u1');
    assert.equal(cleared.length, 1);
    assert.equal(queue.list('t1', 'u1').length, 0);

    // Re-enqueue with same-shape entry — rollbackEnqueue should NOT see stale metadata
    const rB = queue.enqueue(entry({ content: 'fresh' }));
    // Simulate: someone else merges
    queue.enqueue(entry({ content: 'fresh-merge' }));
    // rollbackEnqueue on the NEW entry should work cleanly
    queue.rollbackEnqueue('t1', 'u1', rB.entry.id);
    const remaining = queue.list('t1', 'u1');
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].content, 'fresh-merge');
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

  it('listAutoExecute ignores stale queued entries older than threshold', () => {
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
    assert.equal(autoEntries.length, 1, 'stale queued autoExecute entries must be filtered out');
    assert.equal(autoEntries[0].targetCats[0], 'codex');
  });

  // ── hasActiveOrQueuedAgentForCat: processing + fresh queued block, stale queued does not ──

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

  it('hasActiveOrQueuedAgentForCat returns false for stale queued entry (> threshold)', () => {
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
      false,
      'stale queued entry (>60s) must NOT block text-scan A2A — may never execute',
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
});
