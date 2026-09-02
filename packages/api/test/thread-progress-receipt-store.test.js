import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('ThreadProgressReceiptStore', () => {
  test('appendIfAbsent is first-writer-wins for one canonical terminal fact', async () => {
    const { ThreadProgressReceiptStore } = await import(
      '../dist/domains/thread-progress/ThreadProgressReceiptStore.js'
    );
    const store = new ThreadProgressReceiptStore();
    const first = {
      v: 1,
      id: 'receipt-1',
      ownerUserId: 'user-1',
      threadId: 'thread-1',
      kind: 'completed',
      impactAxes: ['verified_outcome'],
      actor: { kind: 'cat', catId: 'opus' },
      headline: '完成 Phase A',
      nextStep: '开始隔离验收',
      provenance: [{ kind: 'task', taskId: 'task-1' }],
      sourceKey: 'source-key-1',
      occurredAt: 100,
      createdAt: 100,
    };
    const duplicate = { ...first, id: 'receipt-2', headline: '重复回执不应覆盖第一条' };

    const created = await store.appendIfAbsent(first);
    const replay = await store.appendIfAbsent(duplicate);

    assert.equal(created.inserted, true);
    assert.equal(replay.inserted, false);
    assert.equal(replay.receipt.id, first.id);
    assert.equal(replay.receipt.headline, first.headline);
    assert.deepEqual(await store.listByThread('user-1', 'thread-1'), [first]);
    assert.deepEqual(await store.listByThread('another-user', 'thread-1'), []);
  });

  test('same-time receipts paginate in stable Redis-compatible id order', async () => {
    const { ThreadProgressReceiptStore } = await import(
      '../dist/domains/thread-progress/ThreadProgressReceiptStore.js'
    );
    const store = new ThreadProgressReceiptStore();
    for (const id of ['receipt-a', 'receipt-c', 'receipt-b']) {
      await store.appendIfAbsent({
        v: 1,
        id,
        ownerUserId: 'user-1',
        threadId: 'thread-1',
        kind: 'milestone',
        impactAxes: ['verified_outcome'],
        actor: { kind: 'cat', catId: 'opus' },
        headline: id,
        provenance: [{ kind: 'invocation', invocationId: id }],
        sourceKey: `source-${id}`,
        occurredAt: 100,
        createdAt: 100,
      });
    }
    const first = await store.listPageByThread('user-1', 'thread-1', { limit: 2 });
    const second = await store.listPageByThread('user-1', 'thread-1', {
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });

    assert.deepEqual(
      first.items.map((receipt) => receipt.id),
      ['receipt-c', 'receipt-b'],
    );
    assert.deepEqual(
      second.items.map((receipt) => receipt.id),
      ['receipt-a'],
    );
    assert.equal(second.nextCursor, null);
  });

  test('a replayed source binds the current terminal turn before another source can write', async () => {
    const { ThreadProgressReceiptStore } = await import(
      '../dist/domains/thread-progress/ThreadProgressReceiptStore.js'
    );
    const store = new ThreadProgressReceiptStore();
    const original = {
      v: 1,
      id: 'receipt-original',
      ownerUserId: 'user-1',
      threadId: 'thread-1',
      kind: 'completed',
      impactAxes: ['verified_outcome'],
      actor: { kind: 'cat', catId: 'opus' },
      headline: '完成任务',
      provenance: [{ kind: 'task', taskId: 'task-1' }],
      sourceKey: 'task-terminal-source',
      occurredAt: 100,
      createdAt: 100,
    };
    await store.appendIfAbsent(original, { terminalTurnKey: 'turn-1' });
    const replay = await store.appendIfAbsent({ ...original, id: 'receipt-replay' }, { terminalTurnKey: 'turn-2' });
    const secondSource = await store.appendIfAbsent(
      { ...original, id: 'receipt-decision', kind: 'decision', sourceKey: 'decision-source' },
      { terminalTurnKey: 'turn-2' },
    );

    assert.equal(replay.receipt.id, original.id);
    assert.equal(secondSource.inserted, false);
    assert.equal(secondSource.receipt.id, original.id);
    assert.equal((await store.listByThread('user-1', 'thread-1')).length, 1);
  });

  test('recent threads paginate by progress time and thread id while excluding current threads', async () => {
    const { ThreadProgressReceiptStore } = await import(
      '../dist/domains/thread-progress/ThreadProgressReceiptStore.js'
    );
    const store = new ThreadProgressReceiptStore();
    for (const [threadId, occurredAt] of [
      ['thread-b', 300],
      ['thread-a', 300],
      ['thread-c', 200],
    ]) {
      await store.appendIfAbsent(recentReceipt(threadId, occurredAt));
    }

    const first = await store.listRecentThreads('user-1', {
      limit: 1,
      excludeThreadIds: new Set(['thread-b']),
    });
    const second = await store.listRecentThreads('user-1', {
      limit: 1,
      cursor: first.nextCursor ?? undefined,
      excludeThreadIds: new Set(['thread-b']),
    });

    assert.deepEqual(first.items, [{ threadId: 'thread-a', lastProgressAt: 300 }]);
    assert.ok(first.nextCursor);
    assert.deepEqual(second.items, [{ threadId: 'thread-c', lastProgressAt: 200 }]);
    assert.equal(second.nextCursor, null);
    assert.deepEqual((await store.listRecentThreads('other-user')).items, []);
  });
});

function recentReceipt(threadId, occurredAt) {
  return {
    v: 1,
    id: `receipt-${threadId}-${occurredAt}`,
    ownerUserId: 'user-1',
    threadId,
    kind: 'milestone',
    impactAxes: ['verified_outcome'],
    actor: { kind: 'cat', catId: 'opus' },
    headline: threadId,
    provenance: [{ kind: 'invocation', invocationId: `inv-${threadId}-${occurredAt}` }],
    sourceKey: `source-${threadId}-${occurredAt}`,
    occurredAt,
    createdAt: occurredAt,
  };
}
