import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const {
  advanceDispatchRef,
  applyLifecycleTerminal,
  applyVisibleQueueOrder,
  compareLifecycleQueueEntries,
  validateLifecycleQueueEntry,
} = await import('../dist/domains/cats/services/agents/invocation/message-lifecycle-kernel.js');

const inline = (text) => ({ type: 'inline', body: [{ type: 'text', text }] });

function conversationEntry(overrides = {}) {
  return {
    id: 'entry-a',
    threadId: 'thread-1',
    kind: 'conversation_input',
    sourceRecordId: 'message-a',
    payload: inline('hello'),
    from: { kind: 'user', userId: 'user-1' },
    targets: [],
    ownerAuthProvenance: 'strict',
    priority: 'normal',
    enqueuedAt: 100,
    ...overrides,
  };
}

describe('message lifecycle QueueEntry contract', () => {
  it('accepts only the three legal kind/payload/target combinations', () => {
    assert.deepEqual(validateLifecycleQueueEntry(conversationEntry()), { valid: true });
    assert.deepEqual(
      validateLifecycleQueueEntry(
        conversationEntry({
          id: 'wake',
          kind: 'message_wake',
          sourceRecordId: undefined,
          payload: { type: 'message_ref', messageId: 'history-1' },
          from: { kind: 'agent', catId: 'opus' },
          targets: ['codex'],
        }),
      ),
      { valid: true },
    );
    assert.deepEqual(
      validateLifecycleQueueEntry(
        conversationEntry({
          id: 'private',
          kind: 'private_input',
          sourceRecordId: undefined,
          targets: ['codex'],
        }),
      ),
      { valid: true },
    );

    assert.equal(
      validateLifecycleQueueEntry(conversationEntry({ kind: 'message_wake', sourceRecordId: undefined })).valid,
      false,
      'message_wake cannot carry inline content',
    );
    assert.equal(
      validateLifecycleQueueEntry(conversationEntry({ kind: 'private_input', sourceRecordId: undefined, targets: [] }))
        .valid,
      false,
      'private_input must have an exact target',
    );
    assert.equal(
      validateLifecycleQueueEntry(
        conversationEntry({
          kind: 'private_input',
          sourceRecordId: undefined,
          targets: ['codex'],
          position: 0,
        }),
      ).valid,
      false,
      'hidden private_input cannot carry a client-visible position',
    );
    assert.equal(
      validateLifecycleQueueEntry(
        conversationEntry({
          kind: 'conversation_input',
          payload: { type: 'message_ref', messageId: 'history-1' },
        }),
      ).valid,
      false,
      'conversation_input cannot refer to an existing History message',
    );
    assert.equal(
      validateLifecycleQueueEntry(
        conversationEntry({ from: { kind: 'external', connectorId: 'github', sender: { name: 'missing-id' } } }),
      ).valid,
      false,
      'external actors remain in a validated connector/sender namespace',
    );
  });
});

describe('visible Queue reorder reducer', () => {
  const privateEntry = conversationEntry({
    id: 'private',
    kind: 'private_input',
    sourceRecordId: undefined,
    targets: ['codex'],
    enqueuedAt: 25,
  });
  const entries = [
    conversationEntry({ id: 'v1', enqueuedAt: 10 }),
    privateEntry,
    conversationEntry({ id: 'v2', enqueuedAt: 20 }),
    conversationEntry({ id: 'v3', enqueuedAt: 30 }),
  ];

  it('atomically replaces the complete visible order without addressing hidden entries', () => {
    const result = applyVisibleQueueOrder(
      { revision: 'r1', entries, reorderableVisibleEntryIds: ['v1', 'v2', 'v3'] },
      { threadId: 'thread-1', expectedQueueRevision: 'r1', orderedVisibleEntryIds: ['v1', 'v3', 'v2'] },
      'r2',
    );

    assert.equal(result.outcome, 'applied');
    assert.equal(result.snapshot.revision, 'r2');
    assert.deepEqual(
      result.snapshot.entries.sort(compareLifecycleQueueEntries).map((entry) => entry.id),
      ['v1', 'v3', 'v2', 'private'],
    );
    assert.equal(result.snapshot.entries.find((entry) => entry.id === 'private').position, undefined);
  });

  it('fails closed on stale revision, duplicate ids, hidden ids, or an incomplete visible set', () => {
    const snapshot = { revision: 'r1', entries, reorderableVisibleEntryIds: ['v1', 'v2', 'v3'] };
    for (const [expectedQueueRevision, orderedVisibleEntryIds, reason] of [
      ['stale', ['v1', 'v2', 'v3'], 'stale_revision'],
      ['r1', ['v1', 'v1', 'v3'], 'invalid_order'],
      ['r1', ['v1', 'private', 'v2', 'v3'], 'visible_set_changed'],
      ['r1', ['v1', 'v2'], 'visible_set_changed'],
    ]) {
      const result = applyVisibleQueueOrder(
        snapshot,
        { threadId: 'thread-1', expectedQueueRevision, orderedVisibleEntryIds },
        'r2',
      );
      assert.deepEqual(result, { outcome: 'conflict', reason });
    }
    assert.ok(
      entries.every((entry) => entry.position === undefined),
      'conflicts must not partially mutate input',
    );
    assert.deepEqual(
      applyVisibleQueueOrder(
        snapshot,
        {
          threadId: 'thread-1',
          expectedQueueRevision: 'r1',
          orderedVisibleEntryIds: ['v1', 'v2', 'v3'],
        },
        'r1',
      ),
      { outcome: 'conflict', reason: 'invalid_revision' },
    );
  });

  it('rejects invalid or duplicate canonical snapshot identities before assigning positions', () => {
    const duplicated = [
      conversationEntry({ id: 'duplicate', enqueuedAt: 10 }),
      conversationEntry({ id: 'duplicate', enqueuedAt: 20 }),
    ];
    assert.deepEqual(
      applyVisibleQueueOrder(
        { revision: 'r1', entries: duplicated, reorderableVisibleEntryIds: ['duplicate'] },
        { threadId: 'thread-1', expectedQueueRevision: 'r1', orderedVisibleEntryIds: ['duplicate'] },
        'r2',
      ),
      { outcome: 'conflict', reason: 'invalid_snapshot' },
    );

    assert.deepEqual(
      applyVisibleQueueOrder(
        {
          revision: 'r1',
          entries: [
            conversationEntry({ id: 'visible', enqueuedAt: 20 }),
            conversationEntry({
              id: 'hidden',
              kind: 'private_input',
              sourceRecordId: undefined,
              targets: ['codex'],
              position: 0,
              enqueuedAt: 10,
            }),
          ],
          reorderableVisibleEntryIds: ['visible'],
        },
        { threadId: 'thread-1', expectedQueueRevision: 'r1', orderedVisibleEntryIds: ['visible'] },
        'r2',
      ),
      { outcome: 'conflict', reason: 'invalid_snapshot' },
    );
  });
});

describe('derived ref and terminal reducers', () => {
  it('allows only monotonic dispatch-ref transitions and idempotent replay', () => {
    const assigned = { targetId: 'codex', phase: 'assigned' };
    const dispatched = { targetId: 'codex', phase: 'dispatched', statusMessageId: 'response-1' };
    const settled = { targetId: 'codex', phase: 'settled', statusMessageId: 'response-1' };

    assert.deepEqual(advanceDispatchRef(assigned, dispatched), { outcome: 'applied', ref: dispatched });
    assert.deepEqual(advanceDispatchRef(assigned, settled), { outcome: 'applied', ref: settled });
    assert.deepEqual(advanceDispatchRef(dispatched, settled), { outcome: 'applied', ref: settled });
    assert.deepEqual(advanceDispatchRef(settled, settled), { outcome: 'replayed', ref: settled });
    assert.equal(advanceDispatchRef(settled, dispatched).outcome, 'conflict');
    assert.equal(
      advanceDispatchRef(assigned, { targetId: 'opus', phase: 'settled', statusMessageId: 'failure-1' }).outcome,
      'conflict',
    );
    assert.equal(
      advanceDispatchRef(dispatched, {
        targetId: 'codex',
        phase: 'dispatched',
        statusMessageId: 'response-2',
      }).outcome,
      'conflict',
      'one target cannot be relinked to a different response bubble',
    );
  });

  it('commits one terminal per invocation and replays only the same fact', () => {
    const bubble = {
      id: 'response-1',
      threadId: 'thread-1',
      orderKey: '2',
      invocationId: 'invocation-1',
      targetId: 'codex',
      inputEntryIds: ['entry-a'],
      inputMessageIds: ['message-a'],
      body: [],
      status: 'processing',
      startedAt: 100,
    };
    const terminal = { status: 'failed', body: [{ type: 'text', text: 'partial' }], completedAt: 200, reason: 'boom' };
    const first = applyLifecycleTerminal(bubble, terminal);
    assert.equal(first.outcome, 'applied');
    assert.deepEqual(applyLifecycleTerminal(first.bubble, terminal), { outcome: 'replayed', bubble: first.bubble });
    assert.equal(applyLifecycleTerminal(first.bubble, { ...terminal, status: 'completed' }).outcome, 'conflict');
    assert.equal(
      applyLifecycleTerminal(bubble, { ...terminal, status: 'processing' }).outcome,
      'conflict',
      'runtime validation must reject a non-terminal status even for untyped callers',
    );
  });
});
