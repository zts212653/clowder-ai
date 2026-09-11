import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { InMemoryQueueLedgerStore } = await import(
  '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js'
);
const { assertQueueLedgerEntry, queueEntryId } = await import(
  '../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedger.js'
);
const { createQueueLedgerAdmission } = await import(
  '../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedgerAdmission.js'
);

function row(sourceId, targetCatId, overrides = {}) {
  const targets = Array.isArray(targetCatId) ? targetCatId : targetCatId ? [targetCatId] : [];
  return {
    version: 2,
    id: queueEntryId(sourceId),
    threadId: 'thread-1',
    owner: { kind: 'user', userId: 'owner-1' },
    kind: 'conversation_input',
    from: { kind: 'user', userId: 'owner-1' },
    targets,
    payload: { sourceRecordId: sourceId, content: `body:${sourceId}`, messageId: sourceId },
    execution: { intent: 'execute', ownerAuthProvenance: 'strict', autoExecute: false },
    delivery: {},
    status: 'queued',
    enqueuedAt: 100,
    priority: 'normal',
    ...overrides,
  };
}

describe('ADR-043 queue ledger', () => {
  it('stores one durable Queue Entry for one source and keeps pending targets on that entry', () => {
    const entries = createQueueLedgerAdmission({
      sourceId: 'source-multi-target',
      threadId: 'thread-1',
      owner: { kind: 'user', userId: 'owner-1' },
      kind: 'conversation_input',
      from: { kind: 'user', userId: 'owner-1' },
      targetCatIds: ['opus', 'codex'],
      content: 'hello',
      intent: 'execute',
      ownerAuthProvenance: 'strict',
      enqueuedAt: 100,
    });

    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, queueEntryId('source-multi-target'));
    assert.deepEqual(entries[0].targets, ['opus', 'codex']);
    assert.equal('target' in entries[0], false, 'the durable row must not mirror a scalar target');
  });

  it('derives Queue identity from the source rather than a source-target pair', () => {
    assert.equal(queueEntryId('message-1', 'opus'), queueEntryId('message-1', 'codex'));
    assert.notEqual(queueEntryId('message-1'), queueEntryId('message-2'));
  });

  it('derives one deterministic primary key from source identity', () => {
    assert.equal(queueEntryId('message-1', 'opus'), queueEntryId('message-1', 'opus'));
    assert.equal(queueEntryId('message-1', 'opus'), queueEntryId('message-1', 'codex'));
    assert.notEqual(queueEntryId('message-1', 'opus'), queueEntryId('message-2', 'opus'));
  });

  it('rejects malformed or obsolete persisted rows before they enter scheduling', () => {
    assert.doesNotThrow(() => assertQueueLedgerEntry(row('message-valid', 'opus')));
    assert.throws(
      () => assertQueueLedgerEntry({ ...row('message-target', 'opus'), targets: ['opus', 'opus'] }),
      /targets are invalid/,
    );
    assert.throws(
      () => assertQueueLedgerEntry({ ...row('message-status', 'opus'), status: 'processing-ish' }),
      /status is invalid/,
    );
    assert.throws(
      () => assertQueueLedgerEntry({ ...row('message-owner', 'opus'), owner: { kind: 'connector', id: 'github' } }),
      /owner is incomplete/,
    );
    assert.throws(
      () => assertQueueLedgerEntry({ ...row('message-payload', 'opus'), payload: null }),
      /payload identity is incomplete/,
    );
  });

  it('keeps every resolved target on one row and keeps targetless user work assignable', () => {
    const base = {
      sourceId: 'source-1',
      threadId: 'thread-1',
      owner: { kind: 'user', userId: 'owner-1' },
      kind: 'conversation_input',
      from: { kind: 'user', userId: 'owner-1' },
      content: 'hello',
      intent: 'execute',
      ownerAuthProvenance: 'strict',
      enqueuedAt: 100,
    };
    const fanout = createQueueLedgerAdmission({ ...base, targetCatIds: ['opus', 'codex'] });
    assert.equal(fanout.length, 1);
    assert.deepEqual(fanout[0].targets, ['opus', 'codex']);
    assert.deepEqual(createQueueLedgerAdmission({ ...base, targetCatIds: [] })[0].targets, []);
  });

  it('atomically stores a source and all pending targets as one entry', async () => {
    const store = new InMemoryQueueLedgerStore();
    const result = await store.enqueue([row('message-1', ['opus', 'codex'])], 5);
    assert.equal(result.outcome, 'enqueued');
    assert.equal((await store.list('thread-1')).length, 1);
    assert.deepEqual((await store.list('thread-1'))[0].targets, ['opus', 'codex']);
    assert.deepEqual(
      (await store.getByMessageIds('thread-1', ['message-1', 'missing'])).get('message-1'),
      result.entries,
    );
  });

  it('rejects a replay whose pending target set does not match', async () => {
    const store = new InMemoryQueueLedgerStore();
    await store.enqueue([row('message-1', 'opus')]);
    const result = await store.enqueue([row('message-1', ['opus', 'codex'])]);
    assert.equal(result.outcome, 'conflict');
    assert.deepEqual((await store.list('thread-1'))[0].targets, ['opus']);
  });

  it('claims without removing and restores the exact original queue position', async () => {
    const store = new InMemoryQueueLedgerStore();
    const first = row('message-1', 'opus');
    const second = row('message-2', 'opus', { enqueuedAt: 101 });
    await store.enqueue([first]);
    await store.enqueue([second]);

    const claimed = await store.claim('thread-1', first.id, 'claim-1', 200);
    assert.equal(claimed.outcome, 'claimed');
    assert.deepEqual(
      (await store.list('thread-1')).map((entry) => [entry.id, entry.status]),
      [
        [first.id, 'claimed'],
        [second.id, 'queued'],
      ],
    );

    assert.equal((await store.restore('thread-1', first.id, 'stale-claim')).outcome, 'state_changed');
    assert.equal((await store.restore('thread-1', first.id, 'claim-1')).outcome, 'updated');
    assert.deepEqual(
      (await store.list('thread-1')).map((entry) => entry.id),
      [first.id, second.id],
    );
  });

  it('atomically binds one targetless row while claiming it for Steer', async () => {
    const store = new InMemoryQueueLedgerStore();
    const targetless = row('message-1', []);
    await store.enqueue([targetless]);
    const claimed = await store.claim('thread-1', targetless.id, 'claim-targetless', 200, 'codex', 199);
    assert.equal(claimed.outcome, 'claimed');
    assert.deepEqual(claimed.entries[0].targets, ['codex']);
    assert.equal(claimed.entries[0].delivery.steerRequestedAt, 199);
    const restored = await store.restore('thread-1', targetless.id, 'claim-targetless', true);
    assert.equal(restored.outcome, 'updated');
    assert.equal(restored.entry.delivery.steerRequestedAt, undefined);
    assert.deepEqual(restored.entry.targets, []);
  });

  it('expands pending targets on the same durable row', async () => {
    const store = new InMemoryQueueLedgerStore();
    const targetless = row('message-1', []);
    const sibling = row('message-1', 'codex');
    await store.enqueue([targetless]);
    assert.equal((await store.expandTargets('thread-1', targetless.id, 'opus', [], [sibling])).outcome, 'expanded');
    const [expanded] = await store.list('thread-1');
    assert.equal((await store.list('thread-1')).length, 1);
    assert.deepEqual(expanded.targets, ['opus', 'codex']);
  });

  it('reconciles an explicit Steer delta without deleting concurrent targets', async () => {
    const store = new InMemoryQueueLedgerStore();
    const entry = row('message-reconcile', ['opus', 'codex', 'sonnet'], {
      delivery: {
        authorIntentByTarget: {
          opus: { requested: 'next_work', requestedAt: 1 },
          codex: { requested: 'next_work', requestedAt: 1 },
          sonnet: { requested: 'next_work', requestedAt: 1 },
        },
      },
    });
    await store.enqueue([entry]);

    const result = await store.reconcileTargets('thread-1', entry.id, ['kimi'], ['codex'], {
      opus: { requested: 'continue_current', requestedAt: 2 },
      kimi: { requested: 'next_work', requestedAt: 2 },
    });

    assert.equal(result.outcome, 'updated');
    assert.deepEqual(result.entry.targets, ['opus', 'sonnet', 'kimi']);
    assert.deepEqual(Object.keys(result.entry.delivery.authorIntentByTarget), ['opus', 'sonnet', 'kimi']);
    assert.equal(result.entry.delivery.authorIntentByTarget.opus.requested, 'continue_current');
    assert.equal(result.entry.delivery.authorIntentByTarget.sonnet.requested, 'next_work');
  });

  it('deletes the pending Queue row when Steer removes its final target', async () => {
    const store = new InMemoryQueueLedgerStore();
    const entry = row('message-reconcile-empty', ['opus']);
    await store.enqueue([entry]);
    const result = await store.reconcileTargets('thread-1', entry.id, [], ['opus'], {});
    assert.deepEqual(result, { outcome: 'updated', entry: null });
    assert.equal(await store.get('thread-1', entry.id), null);
    assert.equal((await store.getByMessageIds('thread-1', ['message-reconcile-empty'])).size, 0);
  });

  it('counts a fan-out group as one user queue message', async () => {
    const store = new InMemoryQueueLedgerStore();
    assert.equal((await store.enqueue([row('message-1', ['opus', 'codex'])], 1)).outcome, 'enqueued');
    assert.equal((await store.enqueue([row('message-2', 'opus')], 1)).outcome, 'full');
  });

  it('commits one claimed target without moving the Queue Entry into processing', async () => {
    const store = new InMemoryQueueLedgerStore();
    const entry = row('message-1', ['opus', 'codex']);
    await store.enqueue([entry]);
    await store.claim('thread-1', entry.id, 'claim-1', 200, 'opus');
    assert.equal((await store.commit('thread-1', entry.id, 'wrong', 'processing', 201)).outcome, 'state_changed');
    const processing = await store.commit('thread-1', entry.id, 'claim-1', 'processing', 201);
    assert.equal(processing.outcome, 'updated');
    assert.equal(processing.entry.status, 'processing');
    assert.deepEqual(processing.entry.targets, ['opus']);
    assert.deepEqual((await store.get('thread-1', entry.id)).targets, ['codex']);
    assert.equal((await store.get('thread-1', entry.id)).status, 'queued');
    assert.deepEqual(await store.listAll('thread-1'), await store.list('thread-1'));
  });

  it('deletes the Queue Entry when its final target is committed and retains no terminal tombstone', async () => {
    const store = new InMemoryQueueLedgerStore();
    const entry = row('message-terminal', 'opus');
    await store.enqueue([entry]);
    await store.claim('thread-1', entry.id, 'claim-terminal', 200, 'opus');
    const processing = await store.commit('thread-1', entry.id, 'claim-terminal', 'processing', 201);
    assert.equal(processing.outcome, 'updated');
    assert.deepEqual(await store.list('thread-1'), []);
    assert.deepEqual(await store.listAll('thread-1'), []);
    assert.equal(await store.get('thread-1', entry.id), null);
    assert.equal((await store.getByMessageIds('thread-1', ['message-terminal'])).has('message-terminal'), false);
  });

  it('claims a prefix all-or-nothing', async () => {
    const store = new InMemoryQueueLedgerStore();
    const first = row('message-1', 'opus');
    const second = row('message-2', 'opus', { enqueuedAt: 101 });
    await store.enqueue([first]);
    await store.enqueue([second]);
    await store.claim('thread-1', second.id, 'other', 150);

    const result = await store.claimPrefix('thread-1', [first.id, second.id], 'batch', 200, undefined, 199);
    assert.equal(result.outcome, 'state_changed');
    assert.equal((await store.get('thread-1', first.id)).status, 'queued');
  });
});
