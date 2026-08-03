import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { InMemoryFreshnessClosureStore } = await import(
  '../dist/domains/cats/services/freshness/FreshnessClosureStore.js'
);
const { reconcileFreshnessSupplementsAtStartup } = await import(
  '../dist/domains/cats/services/freshness/glass-box/FreshnessSupplementStartupReconciler.js'
);

async function createPending(store, overrides = {}) {
  return (
    await store.offerSupplement({
      lineageId: 'msg-original',
      originalMessageId: 'msg-original',
      userId: 'user-1',
      threadId: 'thread-1',
      catId: 'opus',
      requiredMessageIds: ['msg-update'],
      requiredFrontierMessageId: 'msg-update',
      replayUnsafeToolNames: ['mcp__cat-cafe__cat_cafe_hold_ball'],
      now: 100,
      ...overrides,
    })
  ).supplement;
}

function logger() {
  return { info: mock.fn(), warn: mock.fn(), error: mock.fn() };
}

describe('F254 ADR-042 supplement startup reconciliation', () => {
  it('re-enqueues a durable pending supplement with its hard read-only carrier', async () => {
    const closureStore = new InMemoryFreshnessClosureStore();
    const pending = await createPending(closureStore);
    const enqueued = [];
    const executed = [];

    const result = await reconcileFreshnessSupplementsAtStartup({
      closureStore,
      messageStore: new MessageStore(),
      enqueue: (entry) => {
        enqueued.push(entry);
        return { outcome: 'enqueued', entry, queuePosition: 1 };
      },
      executeThread: async (threadId) => executed.push(threadId),
      log: logger(),
      now: () => 500,
    });

    assert.deepEqual(result, {
      scanned: 1,
      recoveredCommitted: 0,
      failed: 0,
      enqueued: 1,
      executedThreads: 1,
    });
    assert.equal(enqueued[0].freshnessSupplementId, pending.id);
    assert.deepEqual(enqueued[0].readOnlyToolPolicy, {
      mode: 'read_only',
      replayDeniedToolNames: ['mcp__cat-cafe__cat_cafe_hold_ball'],
    });
    assert.deepEqual(executed, ['thread-1']);
  });

  it('commits a running supplement from its idempotent message after an append-before-state crash', async () => {
    const closureStore = new InMemoryFreshnessClosureStore();
    const pending = await createPending(closureStore);
    const running = await closureStore.claimSupplement(pending.id, { invocationId: 'inv-crashed', now: 200 });
    const messageStore = new MessageStore();
    const published = await messageStore.appendAndObservePriorFrontier({
      userId: running.userId,
      threadId: running.threadId,
      catId: running.catId,
      content: 'durable supplement body',
      mentions: [],
      timestamp: 250,
      replyTo: running.originalMessageId,
      idempotencyKey: running.id,
      extra: {
        supplement: {
          lineageId: running.lineageId,
          supplementId: running.id,
          seq: running.seq,
          originalMessageId: running.originalMessageId,
        },
      },
    });
    const projections = [];

    const result = await reconcileFreshnessSupplementsAtStartup({
      closureStore,
      messageStore,
      enqueue: () => {
        throw new Error('recovered commit must not launch another model');
      },
      executeThread: () => {
        throw new Error('recovered commit must not execute a queue');
      },
      onProjection: (projection) => projections.push(projection),
      log: logger(),
      now: () => 500,
    });

    assert.equal(result.recoveredCommitted, 1);
    const committed = await closureStore.getSupplement(running.id);
    assert.equal(committed.status, 'committed');
    assert.equal(committed.committedMessageId, published.message.id);
    assert.equal(projections.at(-1).status, 'committed');
  });

  it('fails a running supplement visibly when no idempotent published body exists', async () => {
    const closureStore = new InMemoryFreshnessClosureStore();
    const pending = await createPending(closureStore);
    await closureStore.claimSupplement(pending.id, { invocationId: 'inv-lost', now: 200 });
    const projections = [];

    const result = await reconcileFreshnessSupplementsAtStartup({
      closureStore,
      messageStore: new MessageStore(),
      enqueue: () => ({ outcome: 'enqueued' }),
      executeThread: () => {},
      onProjection: (projection) => projections.push(projection),
      log: logger(),
      now: () => 500,
    });

    assert.equal(result.failed, 1);
    const failed = await closureStore.getSupplement(pending.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureReason, 'infrastructure');
    assert.equal(projections.at(-1).status, 'failed');
  });

  it('terminalizes a pending supplement when the restored queue is full', async () => {
    const closureStore = new InMemoryFreshnessClosureStore();
    const pending = await createPending(closureStore);

    const result = await reconcileFreshnessSupplementsAtStartup({
      closureStore,
      messageStore: new MessageStore(),
      enqueue: () => ({ outcome: 'full' }),
      executeThread: () => {},
      log: logger(),
      now: () => 500,
    });

    assert.equal(result.failed, 1);
    const failed = await closureStore.getSupplement(pending.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureReason, 'queue_full');
  });
});
