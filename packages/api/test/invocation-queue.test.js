import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { InvocationQueue, queueEntryOwnerId, queueEntryTargetCats } = await import(
  '../dist/domains/cats/services/agents/invocation/InvocationQueue.js'
);
const { InMemoryQueueLedgerStore } = await import(
  '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js'
);

let sourceSequence = 0;

function queueInput(overrides = {}) {
  sourceSequence += 1;
  return {
    threadId: 'thread-1',
    userId: 'user-1',
    sourceId: `source-${sourceSequence}`,
    kind: 'conversation_input',
    ownerAuthProvenance: 'strict',
    content: `body-${sourceSequence}`,
    messageId: `message-${sourceSequence}`,
    from: { kind: 'user', userId: 'user-1' },
    targetCats: ['opus'],
    intent: 'execute',
    ...overrides,
  };
}

describe('InvocationQueue ADR-043 adapter', () => {
  it('rejects admissions without a durable producer identity or canonical source contract', async () => {
    const queue = new InvocationQueue();
    await assert.rejects(
      queue.enqueueDurable(queueInput({ sourceId: undefined, messageId: undefined })),
      /persistent producer identity/,
    );
    await assert.rejects(queue.enqueueDurable(queueInput({ from: undefined })), /from must be explicit/);
    await assert.rejects(
      queue.enqueueDurable(queueInput({ targetCats: ['opus', 'opus'] })),
      /unique non-empty target ids/,
    );
  });

  it('stores one deterministic source row with a pending target set and replays by source identity', async () => {
    const ledger = new InMemoryQueueLedgerStore();
    const queue = new InvocationQueue(ledger);
    const input = queueInput({ sourceId: 'fanout-source', messageId: 'fanout-message', targetCats: ['opus', 'codex'] });

    const first = await queue.enqueueDurable(input);
    const replay = await queue.enqueueDurable(input);

    assert.equal(first.entries.length, 1);
    assert.equal(replay.deduped, true);
    assert.deepEqual(
      replay.entries.map((entry) => entry.id),
      first.entries.map((entry) => entry.id),
    );
    assert.deepEqual(first.entry.targets, ['opus', 'codex']);
    assert.ok(first.entries.every((entry) => entry.payload.messageId === 'fanout-message'));
    assert.ok(first.entries.every((entry) => !('targetCats' in entry)));
    assert.equal(queue.list('thread-1', 'user-1').length, 1);
  });

  it('represents a targetless conversation as one row with an empty pending target set', async () => {
    const queue = new InvocationQueue();
    const result = await queue.enqueueDurable(queueInput({ targetCats: [] }));

    assert.equal(result.entries.length, 1);
    assert.equal(result.entry.target, undefined);
    assert.deepEqual(queueEntryTargetCats(result.entry), []);
  });

  it('keeps author and queue owner independent and isolates owner scopes', async () => {
    const queue = new InvocationQueue();
    const external = await queue.enqueueDurable(
      queueInput({
        userId: 'operator-1',
        owner: { kind: 'system', service: 'github-ingress' },
        from: { kind: 'external', connectorId: 'github', sender: { id: 'octocat' } },
        sourceId: 'external-owner-source',
        messageId: 'external-owner-message',
      }),
    );

    assert.deepEqual(external.entry.owner, { kind: 'system', service: 'github-ingress' });
    assert.equal(queueEntryOwnerId(external.entry), 'system:github-ingress');
    assert.equal(queue.list('thread-1', 'operator-1').length, 0);
    assert.equal(queue.list('thread-1', 'system:github-ingress').length, 1);
  });

  it('orders by explicit position without mutating immutable admission identity', async () => {
    const queue = new InvocationQueue();
    const first = await queue.enqueueDurable(queueInput({ sourceId: 'position-first' }));
    const second = await queue.enqueueDurable(queueInput({ sourceId: 'position-second' }));

    assert.deepEqual(
      queue.list('thread-1', 'user-1').map((entry) => entry.id),
      [first.entry.id, second.entry.id],
    );
    assert.equal(await queue.setPositionDurable('thread-1', 'user-1', second.entry.id, 0), true);
    assert.deepEqual(
      queue.list('thread-1', 'user-1').map((entry) => entry.id),
      [second.entry.id, first.entry.id],
    );
    assert.equal((await queue.getDurableEntry('thread-1', second.entry.id)).position, 0);
  });

  it('claims targetless Steer selection durably and restores the same row in place', async () => {
    const queue = new InvocationQueue();
    const first = await queue.enqueueDurable(queueInput({ sourceId: 'before-steer' }));
    const selected = await queue.enqueueDurable(queueInput({ sourceId: 'targetless-steer', targetCats: [] }));
    const last = await queue.enqueueDurable(queueInput({ sourceId: 'after-steer' }));
    const before = queue.list('thread-1', 'user-1').map((entry) => entry.id);

    const claim = await queue.claimExactSteerEntryDurable('thread-1', 'user-1', selected.entry.id, 'codex', 1_000);
    assert.equal(claim.outcome, 'claimed');
    assert.deepEqual(claim.entries[0].targets, ['codex']);
    assert.equal(claim.entries[0].delivery.steerRequestedAt, 1_000);
    assert.equal(await queue.restoreClaimedEntries('thread-1', [selected.entry.id]), true);

    const restored = queue.getEntrySnapshot('thread-1', 'user-1', selected.entry.id);
    assert.equal(restored.status, 'queued');
    assert.deepEqual(restored.targets, []);
    assert.equal(restored.delivery.steerRequestedAt, undefined);
    assert.deepEqual(
      queue.list('thread-1', 'user-1').map((entry) => entry.id),
      before,
    );
    assert.deepEqual(before, [first.entry.id, selected.entry.id, last.entry.id]);
  });

  it('removes admitted work from the durable Queue and settles only its process-local attempt', async () => {
    const queue = new InvocationQueue();
    const admitted = await queue.enqueueDurable(queueInput({ sourceId: 'terminal-once' }));
    const claim = await queue.markProcessingDurable('thread-1', 'user-1', {
      entryId: admitted.entry.id,
      targetCats: ['opus'],
    });
    assert.equal(claim.status, 'claimed');
    assert.equal(await queue.commitClaimedProcessing('thread-1', [admitted.entry.id], 2_000), true);

    assert.ok(
      await queue.removeProcessedAcrossUsersDurable(
        'thread-1',
        admitted.entry.id,
        'failed',
        'invocation_failed',
        3_000,
      ),
    );
    assert.equal(queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id), null);
    assert.equal(await queue.removeProcessedAcrossUsersDurable('thread-1', admitted.entry.id), null);
    assert.equal(await queue.getDurableEntry('thread-1', admitted.entry.id), null);
  });

  it('retires parallel targets independently while preserving one source claim', async () => {
    const queue = new InvocationQueue();
    const admitted = await queue.enqueueDurable(
      queueInput({ sourceId: 'parallel-cutover', targetCats: ['opus', 'codex'] }),
    );
    const claim = await queue.markProcessingGroupDurable(
      'thread-1',
      'user-1',
      { entryId: admitted.entry.id, targetCats: ['opus', 'codex'] },
      [admitted.entry.id],
    );
    assert.equal(claim.entry.status, 'claimed');

    assert.deepEqual(await queue.retireClaimedLifecycleTarget('thread-1', admitted.entry.id, 'opus', 2_000), {
      outcome: 'retired',
      rowStatus: 'claimed',
    });
    const afterFirst = await queue.getDurableEntry('thread-1', admitted.entry.id);
    assert.equal(afterFirst.status, 'claimed');
    assert.deepEqual(afterFirst.targets, ['codex']);
    assert.deepEqual(afterFirst.claimedTargetIds, ['codex']);
    assert.equal(queue.findProcessingByCat('thread-1', 'opus').status, 'processing');

    assert.deepEqual(await queue.retireClaimedLifecycleTarget('thread-1', admitted.entry.id, 'codex', 2_001), {
      outcome: 'retired',
      rowStatus: 'absent',
    });
    assert.equal(await queue.getDurableEntry('thread-1', admitted.entry.id), null);
    assert.equal(queue.findProcessingByCat('thread-1', 'codex').status, 'processing');
    assert.ok(await queue.removeProcessedAcrossUsersDurable('thread-1', admitted.entry.id));
    assert.equal(queue.findProcessingByCat('thread-1', 'opus'), null);
    assert.equal(queue.findProcessingByCat('thread-1', 'codex'), null);
  });

  it('retires an already-dispatched target after a sibling restores the shared claim', async () => {
    const queue = new InvocationQueue();
    const admitted = await queue.enqueueDurable(
      queueInput({ sourceId: 'parallel-restore-race', targetCats: ['opus', 'codex'] }),
    );
    assert.ok(
      await queue.markProcessingGroupDurable(
        'thread-1',
        'user-1',
        { entryId: admitted.entry.id, targetCats: ['opus', 'codex'] },
        [admitted.entry.id],
      ),
    );
    assert.equal(await queue.restoreClaimedEntries('thread-1', [admitted.entry.id]), true);

    assert.deepEqual(await queue.retireClaimedLifecycleTarget('thread-1', admitted.entry.id, 'opus', 2_000), {
      outcome: 'retired',
      rowStatus: 'queued',
    });
    const remaining = await queue.getDurableEntry('thread-1', admitted.entry.id);
    assert.equal(remaining.status, 'queued');
    assert.deepEqual(remaining.targets, ['codex']);
    assert.equal(queue.findProcessingByCat('thread-1', 'opus').status, 'processing');
  });

  it('rebuilds the admitted attempt when canonical reconciliation won the restore race', async () => {
    const queue = new InvocationQueue();
    const admitted = await queue.enqueueDurable(
      queueInput({ sourceId: 'parallel-reconciled-race', targetCats: ['opus', 'codex'] }),
    );
    assert.ok(
      await queue.markProcessingGroupDurable(
        'thread-1',
        'user-1',
        { entryId: admitted.entry.id, targetCats: ['opus', 'codex'] },
        [admitted.entry.id],
      ),
    );
    assert.equal(await queue.restoreClaimedEntries('thread-1', [admitted.entry.id]), true);
    const reconciled = await queue.reconcileQueuedMessageTargetsDurable(
      'thread-1',
      'user-1',
      admitted.entry.id,
      [],
      ['opus'],
      {},
    );
    assert.equal(reconciled.outcome, 'updated');

    assert.deepEqual(await queue.retireClaimedLifecycleTarget('thread-1', admitted.entry.id, 'opus', 2_000), {
      outcome: 'retired',
      rowStatus: 'queued',
    });
    const remaining = await queue.getDurableEntry('thread-1', admitted.entry.id);
    assert.equal(remaining.status, 'queued');
    assert.deepEqual(remaining.targets, ['codex']);
    assert.equal(queue.findProcessingByCat('thread-1', 'opus').status, 'processing');
  });

  it('freezes and withdraws the one source row for every pending message target', async () => {
    const queue = new InvocationQueue();
    const admitted = await queue.enqueueDurable(
      queueInput({ sourceId: 'withdraw-source', messageId: 'withdraw-message', targetCats: ['opus', 'codex'] }),
    );
    const claim = await queue.claimMessageEntriesForWithdrawal('thread-1', 'user-1', 'withdraw-message', 1_000);

    assert.equal(claim.outcome, 'claimed');
    assert.equal(claim.entries.length, 1);
    assert.equal(
      await queue.commitClaimedMessageWithdrawal(
        'thread-1',
        admitted.entries.map((entry) => entry.id),
      ),
      true,
    );
    assert.equal(queue.list('thread-1', 'user-1').length, 0);
    assert.equal(await queue.getDurableEntry('thread-1', admitted.entry.id), null);
  });

  it('keeps awakened and seen evidence only on the process-local admitted attempt', async () => {
    const queue = new InvocationQueue();
    const admitted = await queue.enqueueDurable(queueInput({ sourceId: 'processing-receipt-source' }));
    const processing = await queue.markProcessingDurable('thread-1', 'user-1', {
      entryId: admitted.entry.id,
      targetCats: ['opus'],
    });
    assert.ok(processing);
    assert.equal(await queue.commitClaimedProcessing('thread-1', [admitted.entry.id], 200), true);

    assert.equal(
      await queue.markProcessingAwakened('thread-1', 'user-1', admitted.entry.id, 'opus', 'inv-processing', 210),
      true,
    );
    assert.deepEqual(
      await queue.markProcessingSeen('thread-1', 'user-1', admitted.entry.id, 'opus', 'inv-processing', 220),
      { changed: true, newlySeen: true },
    );

    assert.equal(await queue.getDurableEntry('thread-1', admitted.entry.id), null);
    const attempt = queue.findProcessingByCat('thread-1', 'opus');
    assert.equal(attempt.status, 'processing');
    assert.equal(attempt.processingStartedAt, 200);
    assert.equal('awakenedInvocationId' in attempt.delivery, false);
    assert.equal('seenInvocationId' in attempt.delivery, false);

    assert.equal(
      await queue.markProcessingAwakened('thread-1', 'user-1', admitted.entry.id, 'codex', 'inv-processing', 230),
      false,
      'receipt evidence must remain target-bound',
    );
  });

  it('restores reversible claims during hydration after a host restart', async () => {
    const ledger = new InMemoryQueueLedgerStore();
    const firstHost = new InvocationQueue(ledger);
    const admitted = await firstHost.enqueueDurable(queueInput({ sourceId: 'restart-claim' }));
    assert.ok(
      await firstHost.markProcessingDurable('thread-1', 'user-1', {
        entryId: admitted.entry.id,
        targetCats: ['opus'],
      }),
    );

    const restarted = new InvocationQueue(ledger);
    assert.equal(await restarted.hydrateFromLedger(), 1);
    assert.equal(restarted.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id).status, 'queued');
    assert.equal((await restarted.getDurableEntry('thread-1', admitted.entry.id)).status, 'queued');
  });

  it('retires only the History-proven claimed target during restart hydration', async () => {
    const ledger = new InMemoryQueueLedgerStore();
    const firstHost = new InvocationQueue(ledger);
    const admitted = await firstHost.enqueueDurable(
      queueInput({ sourceId: 'restart-partial-delivery', targetCats: ['opus', 'codex'] }),
    );
    assert.ok(
      await firstHost.markProcessingDurable('thread-1', 'user-1', {
        entryId: admitted.entry.id,
        targetCats: ['opus'],
      }),
    );

    const restarted = new InvocationQueue(ledger);
    assert.equal(
      await restarted.hydrateFromLedger({
        getById: async () => ({
          deliveryStatus: 'delivered',
          lifecycle: {
            kind: 'input',
            orderKey: '1:restart-partial-delivery',
            dispatchRefs: [
              {
                targetId: 'opus',
                phase: 'dispatched',
                statusMessageId: 'response-opus',
                dispatchedAt: 2,
              },
            ],
          },
        }),
      }),
      1,
    );
    assert.deepEqual(restarted.list('thread-1', 'user-1')[0].targets, ['codex']);
    assert.deepEqual((await ledger.get('thread-1', admitted.entry.id)).targets, ['codex']);
  });

  it('treats an already-retired target with queued siblings as converged after an uncertain commit receipt', async () => {
    const ledger = new InMemoryQueueLedgerStore();
    const queue = new InvocationQueue(ledger);
    const admitted = await queue.enqueueDurable(
      queueInput({ sourceId: 'uncertain-retirement-receipt', targetCats: ['opus', 'codex'] }),
    );
    assert.ok(
      await queue.markProcessingDurable('thread-1', 'user-1', {
        entryId: admitted.entry.id,
        targetCats: ['opus'],
      }),
    );
    assert.equal(await queue.commitClaimedProcessing('thread-1', [admitted.entry.id], 200), true);

    assert.equal(
      await queue.reconcileClaimedLifecycleTargets('thread-1', [admitted.entry.id], {
        getById: async () => ({
          lifecycle: {
            kind: 'input',
            orderKey: '1:uncertain-retirement-receipt',
            dispatchRefs: [
              { targetId: 'opus', phase: 'dispatched', statusMessageId: 'response-opus', dispatchedAt: 2 },
            ],
          },
        }),
      }),
      true,
    );
    assert.deepEqual(queue.list('thread-1', 'user-1')[0].targets, ['codex']);
  });

  it('does not reconstruct admitted attempts from Queue after restart', async () => {
    const ledger = new InMemoryQueueLedgerStore();
    const firstHost = new InvocationQueue(ledger);
    const admitted = await firstHost.enqueueDurable(queueInput({ sourceId: 'restart-processing' }));
    assert.ok(
      await firstHost.markProcessingDurable('thread-1', 'user-1', {
        entryId: admitted.entry.id,
        targetCats: ['opus'],
      }),
    );
    assert.equal(await firstHost.commitClaimedProcessing('thread-1', [admitted.entry.id], 1_000), true);

    const restarted = new InvocationQueue(ledger);
    assert.equal(await restarted.hydrateFromLedger(), 0);
    assert.equal(restarted.list('thread-1', 'user-1').length, 0);
    assert.equal(await restarted.getDurableEntry('thread-1', admitted.entry.id), null);
  });

  it('treats a live claim as busy but ignores an explicitly excluded Steer reservation', async () => {
    const queue = new InvocationQueue();
    const admitted = await queue.enqueueDurable(
      queueInput({
        sourceId: 'agent-claim',
        kind: 'message_wake',
        from: { kind: 'agent', catId: 'codex' },
        sourceCategory: 'a2a',
      }),
    );
    assert.ok(await queue.markProcessingByIdDurable('thread-1', admitted.entry.id, 'opus'));

    assert.equal(queue.hasActiveOrQueuedAgentForCat('thread-1', 'opus'), true);
    assert.equal(queue.findProcessingByCat('thread-1', 'opus').id, admitted.entry.id);
    assert.equal(queue.findProcessingByCat('thread-1', 'opus', admitted.entry.id), null);
  });

  it('returns detached snapshots so readers cannot mutate ledger-backed queue state', async () => {
    const queue = new InvocationQueue();
    const admitted = await queue.enqueueDurable(queueInput({ sourceId: 'clone-source', content: 'original' }));
    const listed = queue.list('thread-1', 'user-1');
    listed[0].payload.content = 'mutated';
    admitted.entry.delivery.authorIntentByTarget = {};

    const current = queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id);
    assert.equal(current.payload.content, 'original');
    assert.equal(current.delivery.authorIntentByTarget, undefined);
  });
});
