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

  it('atomically claims a FIFO prefix while preserving every body and row identity', async () => {
    const queue = new InvocationQueue();
    const first = await queue.enqueueDurable(queueInput({ sourceId: 'prefix-a', content: 'alpha' }));
    const second = await queue.enqueueDurable(queueInput({ sourceId: 'prefix-b', content: 'beta' }));
    const prefix = queue.collectCompatibleConversationPrefix(first.entry);

    assert.deepEqual(
      prefix.map((entry) => entry.id),
      [second.entry.id],
    );
    const claim = await queue.markProcessingGroupDurable(
      'thread-1',
      'user-1',
      { entryId: first.entry.id, targetCats: ['opus'] },
      [first.entry.id, second.entry.id],
    );
    assert.ok(claim);
    assert.deepEqual(
      [claim.entry, ...claim.members].map((entry) => entry.payload.content),
      ['alpha', 'beta'],
    );
    assert.equal(new Set([claim.entry, ...claim.members].map((entry) => entry.retiringGroupId)).size, 1);
    assert.equal(await queue.commitClaimedProcessing('thread-1', [first.entry.id, second.entry.id], 2_000), true);
    assert.equal(await queue.getDurableEntry('thread-1', first.entry.id), null);
    assert.equal(await queue.getDurableEntry('thread-1', second.entry.id), null);
    assert.equal(queue.findProcessingByCat('thread-1', 'opus').status, 'processing');
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

  it('stores only pending reminder intent on the durable Queue row', async () => {
    const queue = new InvocationQueue();
    const admitted = await queue.enqueueDurable(queueInput({ sourceId: 'receipt-source' }));
    const requested = await queue.requestReminderDurable(
      'thread-1',
      'user-1',
      admitted.entry.id,
      'opus',
      'inv-1',
      'reminder-1',
      100,
    );
    assert.equal(requested.idempotent, false);
    const replayed = await queue.requestReminderDurable(
      'thread-1',
      'user-1',
      admitted.entry.id,
      'opus',
      'inv-1',
      'ignored-replay-id',
      200,
    );
    assert.equal(replayed.idempotent, true);
    assert.equal(replayed.attempt.id, 'reminder-1');
    const row = queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id);
    assert.equal(row.delivery.reminderAttempts[0].state, 'requested');
    assert.equal('bodyExposures' in row.delivery, false);
    assert.ok(!('seenByCatIds' in row.delivery));
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
