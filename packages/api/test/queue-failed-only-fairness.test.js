import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');

function queueInput(sourceId, overrides = {}) {
  return {
    threadId: 'thread-fairness',
    userId: 'user-owner',
    sourceId,
    kind: 'conversation_input',
    ownerAuthProvenance: 'strict',
    content: `body-${sourceId}`,
    messageId: `message-${sourceId}`,
    from: { kind: 'user', userId: 'user-owner' },
    targetCats: ['opus'],
    intent: 'execute',
    ...overrides,
  };
}

async function terminalizeFailed(queue, entry, targetCatId = entry.targets[0], reason = 'invocation_failed') {
  assert.ok(targetCatId);
  const claimed = await queue.markProcessingDurable(entry.threadId, 'user-owner', {
    entryId: entry.id,
    targetCats: [targetCatId],
  });
  assert.ok(claimed);
  assert.equal(await queue.commitClaimedProcessing(entry.threadId, [entry.id], 2_000), true);
  assert.ok(await queue.removeProcessedAcrossUsersDurable(entry.threadId, entry.id, 'failed', reason, 3_000));
}

describe('#1371 terminal-failure fairness over ADR-043 ledger', () => {
  it('a failed terminal row cannot block a later independent admission', async () => {
    const queue = new InvocationQueue();
    const failed = await queue.enqueueDurable(queueInput('failed-first'));
    await terminalizeFailed(queue, failed.entry);

    const later = await queue.enqueueDurable(
      queueInput('later-a2a', {
        from: { kind: 'agent', catId: 'codex' },
        sourceCategory: 'a2a',
        targetCats: ['codex'],
        autoExecute: true,
      }),
    );
    const claimed = await queue.markProcessingDurable('thread-fairness', 'user-owner', {
      entryId: later.entry.id,
      targetCats: ['codex'],
    });

    assert.equal(claimed?.id, later.entry.id);
    assert.deepEqual(
      queue.list('thread-fairness', 'user-owner').map((entry) => entry.id),
      [later.entry.id],
    );
    assert.equal(await queue.getDurableEntry('thread-fairness', failed.entry.id), null);
  });

  it('terminalizing one fan-out target preserves the queued sibling', async () => {
    const queue = new InvocationQueue();
    const fanout = await queue.enqueueDurable(queueInput('fanout', { targetCats: ['opus', 'gemini'] }));
    const [sourceEntry] = fanout.entries;
    assert.ok(sourceEntry);
    assert.deepEqual(sourceEntry.targets, ['opus', 'gemini']);

    await terminalizeFailed(queue, sourceEntry, 'opus', 'provider_failed');

    const remaining = queue.getEntrySnapshot('thread-fairness', 'user-owner', sourceEntry.id);
    assert.equal(remaining.status, 'queued');
    assert.deepEqual(remaining.targets, ['gemini']);
    const claimed = await queue.markProcessingDurable('thread-fairness', 'user-owner', {
      entryId: sourceEntry.id,
      targetCats: ['gemini'],
    });
    assert.equal(claimed?.id, sourceEntry.id);
  });
});
