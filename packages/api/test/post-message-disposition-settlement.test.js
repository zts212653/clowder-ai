import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import {
  createInitialCrossThreadQueuedMessageCustody,
  QueuedMessageCustodyCoordinator,
} from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import {
  createA2ADispositionAuth as auth,
  createA2ADispositionHarness as harness,
} from './helpers/a2a-dispatch-disposition-harness.js';

describe('post/read → A2A disposition → Queue settlement integration', () => {
  test('same-cat cross-thread completion settles one exact exposed carrier without requeue', async () => {
    const h = await harness({
      sourceCatId: 'codex-sol',
      crossPostSourceThreadId: 'thread-source',
      deliveryStatus: 'queued',
    });
    const queue = new InvocationQueue();
    const enqueued = queue.enqueue({
      threadId: 'thread-1',
      userId: 'user-1',
      ownerAuthProvenance: 'unknown',
      content: h.source.content,
      source: 'agent',
      sourceCategory: 'a2a',
      targetCats: ['codex-sol'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'codex-sol',
      a2aParentInvocationId: 'source-invocation',
      a2aTriggerMessageId: h.source.id,
    });
    assert.equal(enqueued.outcome, 'enqueued');
    queue.backfillMessageId('thread-1', 'user-1', enqueued.entry.id, h.source.id);
    const queued = queue.getEntrySnapshot('thread-1', 'user-1', enqueued.entry.id);
    assert.equal(
      h.messageStore.initializeQueueCustody(
        h.source.id,
        createInitialCrossThreadQueuedMessageCustody(h.source.id, [queued]),
      ).kind,
      'initialized',
    );

    const seenAt = queued.createdAt + 10;
    assert.equal(queue.markProcessingById('thread-1', queued.id), true);
    assert.equal(queue.markQueuedAwakened('thread-1', 'user-1', queued.id, 'codex-sol', 'inv-1', seenAt - 1), true);
    queue.markProcessingSeen('thread-1', 'user-1', queued.id, ['codex-sol'], 'inv-1', seenAt);
    const processing = queue.getEntrySnapshot('thread-1', 'user-1', queued.id);
    const custody = new QueuedMessageCustodyCoordinator({ messageStore: h.messageStore, now: () => seenAt + 1 });
    await custody.persistEntry(processing);
    assert.deepEqual(h.messageStore.getById(h.source.id).queueCustody.bodyExposures, [
      { targetCatId: 'codex-sol', invocationId: 'inv-1', seenAt },
    ]);

    assert.equal((await h.service.complete(auth(h), 'completed')).outcome, 'applied');
    const dispositionEvent = (await h.eventLog.read('ball:thread:thread-1')).find(
      (event) => event.kind === 'ball.dispatch_dispositioned',
    );
    assert.ok(dispositionEvent, 'the exact persisted handoff must produce one disposition event');

    const settled = await custody.commitSuccessfulTargets(processing, ['codex-sol'], 'inv-1', seenAt + 20, {
      'codex-sol': {
        invocationId: 'inv-1',
        disposition: 'completed_with_turn',
        evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv-1' },
        handledAt: seenAt + 20,
      },
    });
    assert.equal(settled.perMessage[0].fullyConsumed, true);
    assert.equal(h.messageStore.getById(h.source.id).deliveryStatus, 'delivered');
    assert.equal(h.messageStore.getById(h.source.id).queueCustody.status, 'terminal');

    assert.equal(queue.removeProcessedAcrossUsers('thread-1', queued.id)?.id, queued.id);
    assert.deepEqual(queue.list('thread-1', 'user-1'), []);
    assert.equal(queue.rollbackProcessing('thread-1', queued.id), false, 'a settled carrier cannot be requeued');
    assert.equal((await h.service.complete(auth(h), 'completed')).outcome, 'replayed');
    assert.deepEqual(queue.list('thread-1', 'user-1'), []);
  });
});
