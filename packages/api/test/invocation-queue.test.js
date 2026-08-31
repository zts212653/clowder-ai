import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');

/** Helper: build a minimal enqueue input */
function entry(overrides = {}) {
  const {
    source = 'user',
    callerCatId,
    senderMeta,
    from = source === 'agent'
      ? { kind: 'agent', catId: callerCatId ?? 'opus' }
      : source === 'connector'
        ? {
            kind: 'external',
            connectorId: senderMeta?.connector ?? 'test-connector',
            ...(senderMeta?.sender
              ? { sender: senderMeta.sender }
              : senderMeta?.id
                ? { sender: { id: senderMeta.id, ...(senderMeta.name ? { name: senderMeta.name } : {}) } }
                : {}),
          }
        : source === 'system'
          ? { kind: 'system', service: 'test' }
          : { kind: 'user', userId: overrides.userId ?? 'u1' },
    ...rest
  } = overrides;
  return {
    threadId: 't1',
    userId: 'u1',
    kind: 'conversation_input',
    ownerAuthProvenance: 'unknown',
    content: 'hello',
    from,
    targetCats: ['opus'],
    intent: 'execute',
    ...rest,
  };
}

describe('InvocationQueue', () => {
  /** @type {InvocationQueue} */
  let queue;
  beforeEach(() => {
    queue = new InvocationQueue();
    const enqueue = queue.enqueue.bind(queue);
    queue.enqueue = (input) => enqueue(input.from ? input : entry(input));
  });

  // ── Basic FIFO ──

  it('rejects a producer that omits explicit owner authentication provenance', () => {
    assert.throws(
      () => queue.enqueue(entry({ ownerAuthProvenance: undefined })),
      /ownerAuthProvenance must be explicit/,
    );
  });

  it('rejects a producer that omits the canonical MessageFrom identity', () => {
    const strictQueue = new InvocationQueue();
    const { from: _from, ...withoutFrom } = entry();
    assert.throws(() => strictQueue.enqueue(withoutFrom), /from must be explicit/);
  });

  it('rejects an operational Queue producer that omits the canonical entry kind', () => {
    assert.throws(() => queue.enqueue(entry({ kind: undefined })), /kind must be explicit/);
  });

  it('rejects targetless or duplicate exact-target entries', () => {
    assert.throws(
      () => queue.enqueue(entry({ kind: 'private_input', messageId: null, targetCats: [] })),
      /private_input must have an exact target/,
    );
    assert.throws(
      () => queue.enqueue(entry({ kind: 'message_wake', messageId: 'message-1', targetCats: ['opus', 'opus'] })),
      /unique non-empty target ids/,
    );
  });

  it('rejects a private input that points at public History', () => {
    assert.throws(
      () => queue.enqueue(entry({ kind: 'private_input', messageId: 'message-1' })),
      /cannot reference a public History message/,
    );
  });

  it('rejects a message wake without a stable History reference', () => {
    assert.throws(
      () => queue.enqueue(entry({ kind: 'message_wake', messageId: null })),
      /must reference an existing History message/,
    );
  });

  it('rejects an invalid durable entry before restoring it into the live Queue', () => {
    const admitted = queue.enqueue(entry({ kind: 'message_wake', messageId: 'message-1' })).entry;
    const recovered = new InvocationQueue();

    assert.throws(
      () => recovered.restoreDurableEntry({ ...admitted, kind: 'private_input' }),
      /cannot reference a public History message/,
    );
    assert.equal(recovered.list('t1', 'u1').length, 0);
  });

  it('enqueue + dequeue FIFO order', () => {
    queue.enqueue(entry({ content: 'first' }));
    queue.enqueue(entry({ content: 'second', targetCats: ['codex'] })); // different target → no merge
    const d1 = queue.dequeue('t1', 'u1');
    assert.equal(d1.content, 'first');
    const d2 = queue.dequeue('t1', 'u1');
    assert.equal(d2.content, 'second');
  });

  it('claims explicit Append only at the exact Queue revision and complete target set', () => {
    const admitted = queue.enqueue(entry({ targetCats: ['opus', 'codex'] })).entry;
    const revision = queue.snapshotRevision('t1', 'u1');

    assert.equal(queue.claimExactAppend('t1', 'u1', admitted.id, `${revision}-stale`, ['opus', 'codex']), null);
    assert.equal(queue.claimExactAppend('t1', 'u1', admitted.id, revision, ['opus']), null);

    const claimed = queue.claimExactAppend('t1', 'u1', admitted.id, revision, ['opus', 'codex']);
    assert.equal(claimed?.status, 'processing');
    assert.deepEqual(claimed?.targetCats, ['opus', 'codex']);
    assert.notEqual(queue.snapshotRevision('t1', 'u1'), revision);
  });

  it('records exact Append exposure only for the complete claimed run set', () => {
    const admitted = queue.enqueue(entry({ targetCats: ['opus', 'codex'] })).entry;
    const revision = queue.snapshotRevision('t1', 'u1');
    queue.claimExactAppend('t1', 'u1', admitted.id, revision, ['opus', 'codex']);

    assert.equal(
      queue.recordLifecycleAppendExposure('t1', 'u1', admitted.id, [{ targetId: 'opus', invocationId: 'turn-o' }], 10),
      null,
    );
    const exposed = queue.recordLifecycleAppendExposure(
      't1',
      'u1',
      admitted.id,
      [
        { targetId: 'opus', invocationId: 'turn-o' },
        { targetId: 'codex', invocationId: 'turn-c' },
      ],
      10,
    );
    assert.deepEqual(exposed?.queuedSeenInvocationIdByCatId, { opus: 'turn-o', codex: 'turn-c' });
    assert.deepEqual(exposed?.queuedBodyExposures, [
      { targetCatId: 'opus', invocationId: 'turn-o', seenAt: 10 },
      { targetCatId: 'codex', invocationId: 'turn-c', seenAt: 10 },
    ]);
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

  // ── #1291 Gate 6: exact ordinary-user Batch Steer reservation ──

  describe('exact user Batch Steer reservation (#1291)', () => {
    it('atomically reserves only the explicit allowlist and marks every selected entry as steering', () => {
      const a = queue.enqueue(entry({ content: 'a', ownerAuthProvenance: 'strict' })).entry;
      const b = queue.enqueue(entry({ content: 'b', ownerAuthProvenance: 'strict' })).entry;
      const c = queue.enqueue(entry({ content: 'c', ownerAuthProvenance: 'strict' })).entry;

      const result = queue.reserveExactUserBatch('t1', 'u1', [a.id, b.id]);

      assert.equal(result.outcome, 'reserved');
      assert.deepEqual(result.entryIds, [a.id, b.id]);
      assert.equal(queue.list('t1', 'u1')[0].id, a.id, 'primary entry is promoted');
      const byId = new Map(queue.list('t1', 'u1').map((candidate) => [candidate.id, candidate]));
      assert.deepEqual(byId.get(a.id).steerRequestedByCatIds, ['opus']);
      assert.deepEqual(byId.get(b.id).steerRequestedByCatIds, ['opus']);
      assert.equal(byId.get(c.id).steerRequestedByCatIds, undefined, 'unselected C is untouched');
      assert.equal(byId.get(c.id).exactSteerBatch, undefined, 'unselected C is not reserved');
    });

    it('keeps an exact reservation out of ordinary dequeue until its owner claims it', () => {
      const a = queue.enqueue(entry({ content: 'a', ownerAuthProvenance: 'strict' })).entry;
      const b = queue.enqueue(entry({ content: 'b', ownerAuthProvenance: 'strict' })).entry;
      const ordinary = queue.enqueue(
        entry({ content: 'ordinary', ownerAuthProvenance: 'strict', targetCats: ['codex'] }),
      ).entry;
      queue.reserveExactUserBatch('t1', 'u1', [a.id, b.id]);

      assert.equal(
        queue.markProcessingById('t1', a.id),
        false,
        'an id lookup without reservation identity must not steal an exact reservation',
      );
      assert.equal(
        queue.markProcessing('t1', 'u1')?.id,
        ordinary.id,
        'ordinary dequeue skips the complete reserved allowlist',
      );
      const byId = new Map(queue.list('t1', 'u1').map((candidate) => [candidate.id, candidate]));
      assert.equal(byId.get(a.id).status, 'queued');
      assert.equal(byId.get(b.id).status, 'queued');
    });

    it('claims an activated reservation only with its exact process-local identity', () => {
      const target = queue.enqueue(entry({ content: 'target', ownerAuthProvenance: 'strict' })).entry;
      const reserved = queue.reserveExactUserEntry('t1', 'u1', target.id, 'opus');
      assert.equal(reserved.outcome, 'reserved');

      assert.equal(
        queue.claimExactSteerReservation('t1', 'u1', target.id, reserved.reservationId),
        null,
        'durable reservation is not claimable before preemption begins and succeeds',
      );
      assert.equal(queue.beginExactSteerPreemption('t1', 'u1', reserved.reservationId), true);
      assert.equal(queue.activateExactSteerReservation('t1', 'u1', reserved.reservationId), true);
      assert.equal(queue.claimExactSteerReservation('t1', 'u1', target.id, 'wrong-reservation'), null);

      const claimed = queue.claimExactSteerReservation('t1', 'u1', target.id, reserved.reservationId);
      assert.equal(claimed.id, target.id);
      assert.equal(claimed.status, 'processing');
    });

    it('marks the complete reservation processing in one dequeue transition', () => {
      const a = queue.enqueue(entry({ content: 'a', ownerAuthProvenance: 'strict' })).entry;
      const b = queue.enqueue(entry({ content: 'b', ownerAuthProvenance: 'strict' })).entry;
      const c = queue.enqueue(entry({ content: 'c', ownerAuthProvenance: 'strict' })).entry;
      const reserved = queue.reserveExactUserBatch('t1', 'u1', [a.id, b.id]);
      assert.equal(reserved.outcome, 'reserved');
      assert.equal(queue.beginExactSteerPreemption('t1', 'u1', reserved.reservationId), true);
      assert.equal(queue.activateExactSteerReservation('t1', 'u1', reserved.reservationId), true);

      const primary = queue.claimExactSteerReservation('t1', 'u1', a.id, reserved.reservationId);

      assert.equal(primary.id, a.id);
      const byId = new Map(queue.list('t1', 'u1').map((candidate) => [candidate.id, candidate]));
      assert.equal(byId.get(a.id).status, 'processing');
      assert.equal(byId.get(b.id).status, 'processing');
      assert.equal(byId.get(a.id).processingStartedAt, byId.get(b.id).processingStartedAt);
      assert.equal(byId.get(c.id).status, 'queued');
    });

    it('withdrawing one deferred member releases the reservation and leaves siblings ordinary', () => {
      const a = queue.enqueue(entry({ content: 'a', ownerAuthProvenance: 'strict' })).entry;
      const b = queue.enqueue(entry({ content: 'b', ownerAuthProvenance: 'strict' })).entry;
      queue.reserveExactUserBatch('t1', 'u1', [a.id, b.id]);

      const removed = queue.remove('t1', 'u1', b.id);

      assert.equal(removed.id, b.id);
      const remaining = queue.list('t1', 'u1');
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].id, a.id);
      assert.equal(remaining[0].exactSteerBatch, undefined);
      assert.equal(remaining[0].steerRequestedByCatIds, undefined);
    });

    it('rejects the complete reserved set without mutating any entry when one carrier is ineligible', () => {
      const a = queue.enqueue(entry({ content: 'a', ownerAuthProvenance: 'strict' })).entry;
      const fenced = queue.enqueue(
        entry({
          content: 'fenced',
          ownerAuthProvenance: 'strict',
          actionSuccessorFence: { leaseId: 'lease-1' },
        }),
      ).entry;

      const before = queue.list('t1', 'u1');
      const result = queue.reserveExactUserBatch('t1', 'u1', [a.id, fenced.id]);

      assert.deepEqual(result, { outcome: 'rejected', reason: 'entry_ineligible' });
      assert.deepEqual(queue.list('t1', 'u1'), before);
    });

    it('rejects incompatible target cats and intents without partial reservation', () => {
      const a = queue.enqueue(entry({ content: 'a', ownerAuthProvenance: 'strict' })).entry;
      const otherCat = queue.enqueue(
        entry({ content: 'b', ownerAuthProvenance: 'strict', targetCats: ['codex'] }),
      ).entry;
      const before = queue.list('t1', 'u1');

      assert.deepEqual(queue.reserveExactUserBatch('t1', 'u1', [a.id, otherCat.id]), {
        outcome: 'rejected',
        reason: 'entries_incompatible',
      });
      assert.deepEqual(queue.list('t1', 'u1'), before);
    });

    it('rejects connector/system, freshness, continuation/A2A, pinned, and legacy-unattributed carriers', () => {
      const cases = [
        { source: 'connector' },
        { source: 'agent', sourceCategory: 'scheduled' },
        { sourceCategory: 'freshness', freshnessClosureId: 'closure-1' },
        { sourceCategory: 'continuation' },
        { sourceCategory: 'a2a', a2aTriggerMessageId: 'trigger-1' },
        { source: 'agent', sourceCategory: 'continuation', continuationKey: 'pinned-1' },
        { ownerAuthProvenance: 'unknown' },
        {
          authorIntentByCatId: {
            opus: { requested: 'continue_current', boundParentInvocationId: 'parent-1' },
          },
        },
      ];

      for (const [index, carrier] of cases.entries()) {
        const isolated = new InvocationQueue();
        const a = isolated.enqueue(entry({ content: `a-${index}`, ownerAuthProvenance: 'strict' })).entry;
        const blocked = isolated.enqueue(
          entry({ content: `blocked-${index}`, ownerAuthProvenance: 'strict', ...carrier }),
        ).entry;
        assert.deepEqual(isolated.reserveExactUserBatch('t1', 'u1', [a.id, blocked.id]), {
          outcome: 'rejected',
          reason: 'entry_ineligible',
        });
      }
    });
  });

  it('preserves external sender identity on an enqueued connector entry', () => {
    const r = queue.enqueue(
      entry({
        source: 'connector',
        senderMeta: { id: 'ou_abc', name: 'You' },
      }),
    );
    assert.equal(r.outcome, 'enqueued');
    assert.deepEqual(r.entry.from, {
      kind: 'external',
      connectorId: 'test-connector',
      sender: { id: 'ou_abc', name: 'You' },
    });
    assert.equal(r.entry.senderMeta, undefined);
  });

  // ── F254 D1.2a: per-cat queued_seen ──

  it('binds exact child creation before body exposure and clears only the retry-matching witness', () => {
    const r = queue.enqueue(entry({ content: 'wake before read', targetCats: ['opus', 'codex'] }));

    assert.equal(queue.markQueuedAwakened('t1', 'u1', r.entry.id, 'opus', 'child-opus', 1_100), true);
    assert.equal(queue.markQueuedAwakened('t1', 'u1', r.entry.id, 'opus', 'child-opus', 1_100), false);
    assert.equal(queue.markQueuedAwakened('t1', 'u1', r.entry.id, 'codex', 'child-codex', 1_200), true);

    let snapshot = queue.getEntrySnapshot('t1', 'u1', r.entry.id);
    assert.deepEqual(snapshot.queuedAwakenedInvocationIdByCatId, {
      opus: 'child-opus',
      codex: 'child-codex',
    });
    assert.deepEqual(snapshot.queuedAwakenedAtByCatId, { opus: 1_100, codex: 1_200 });
    assert.equal(snapshot.queuedSeenByCatIds, undefined);
    assert.throws(
      () => queue.markQueuedAwakened('t1', 'u1', r.entry.id, 'opus', 'child-opus', 1_101),
      /timestamp is immutable/,
    );

    assert.equal(queue.clearQueuedSeenInvocationForCats('t1', ['opus'], 'child-opus'), 1);
    snapshot = queue.getEntrySnapshot('t1', 'u1', r.entry.id);
    assert.deepEqual(snapshot.queuedAwakenedInvocationIdByCatId, { codex: 'child-codex' });
    assert.deepEqual(snapshot.queuedAwakenedAtByCatId, { codex: 1_200 });
  });

  it('markQueuedSeen hides queued freshness only for that cat target', () => {
    const r = queue.enqueue(
      entry({
        content: 'queued for two cats',
        targetCats: ['opus', 'codex'],
        authorIntentByCatId: {
          opus: { requested: 'continue_current', boundParentInvocationId: 'parent-opus' },
          codex: { requested: 'continue_current', boundParentInvocationId: 'parent-codex' },
        },
      }),
    );

    assert.equal(queue.markQueuedSeen('t1', 'u1', r.entry.id, 'opus'), true);

    assert.deepEqual(
      queue.getQueuedFreshnessMessagesForCat('t1', 'u1', 'opus', { parentInvocationId: 'parent-opus' }),
      [],
      'seen target should not be nagged again',
    );
    assert.equal(
      queue.getQueuedFreshnessMessagesForCat('t1', 'u1', 'codex', { parentInvocationId: 'parent-codex' }).length,
      1,
      'other targets must not be consumed by opus reading',
    );
  });

  it('markQueuedSeen does not hide queued bodies from full read view', () => {
    const r = queue.enqueue(
      entry({
        content: 'body stays readable after seen',
        targetCats: ['opus'],
        authorIntentByCatId: {
          opus: { requested: 'continue_current', boundParentInvocationId: 'parent-opus' },
        },
      }),
    );

    assert.equal(queue.markQueuedSeen('t1', 'u1', r.entry.id, 'opus'), true);
    assert.equal(
      queue.getQueuedFreshnessMessagesForCat('t1', 'u1', 'opus', { parentInvocationId: 'parent-opus' }).length,
      0,
    );

    const readable = queue.getQueuedBodyMessagesForCat('t1', 'u1', 'opus', 'parent-opus');
    assert.equal(readable.length, 1);
    assert.equal(readable[0].entryId, r.entry.id);
    assert.equal(readable[0].content, 'body stays readable after seen');
  });

  it('queued body visibility is target-cat scoped, not thread-wide', () => {
    queue.enqueue(
      entry({
        content: 'sol-only queued body',
        targetCats: ['codex-sol'],
        authorIntentByCatId: {
          'codex-sol': { requested: 'continue_current', boundParentInvocationId: 'parent-sol' },
        },
      }),
    );

    assert.equal(queue.getQueuedBodyMessagesForCat('t1', 'u1', 'codex-sol', 'parent-sol').length, 1);
    assert.deepEqual(queue.getQueuedBodyMessagesForCat('t1', 'u1', 'gpt52', 'parent-sol'), []);
  });

  it('coalescing queued agent content clears queued_seen so new content can nag again', () => {
    const r = queue.enqueue(
      entry({
        content: 'first handoff',
        source: 'agent',
        sourceCategory: 'a2a',
        callerCatId: 'codex',
        targetCats: ['opus'],
      }),
    );

    assert.equal(queue.markQueuedSeen('t1', 'u1', r.entry.id, 'opus'), true);
    assert.equal(queue.getQueuedFreshnessMessagesForCat('t1', 'u1', 'opus').length, 0);

    assert.equal(
      queue.coalesceContentIntoQueuedAgent('t1', 'u1', r.entry.id, 'second handoff', 'msg-2', 'codex'),
      true,
    );

    const queued = queue.getQueuedFreshnessMessagesForCat('t1', 'u1', 'opus');
    assert.equal(queued.length, 1);
    assert.match(queued[0].content, /second handoff/);
  });

  it('does not coalesce A2A carriers across owner authentication provenance', () => {
    const r = queue.enqueue(
      entry({
        content: 'strict handoff',
        source: 'agent',
        sourceCategory: 'a2a',
        callerCatId: 'codex',
        a2aParentInvocationId: 'parent-1',
        targetCats: ['opus'],
        ownerAuthProvenance: 'strict',
      }),
    );

    assert.equal(queue.findInFlightAgentEntry('t1', 'opus', 'codex', 'parent-1', 'compatibility_fallback'), null);
    assert.equal(
      queue.coalesceContentIntoQueuedAgent(
        't1',
        'u1',
        r.entry.id,
        'fallback handoff',
        'msg-fallback',
        'codex',
        'parent-1',
        'compatibility_fallback',
      ),
      false,
    );
    assert.equal(queue.getEntrySnapshot('t1', 'u1', r.entry.id).content, 'strict handoff');
  });

  // ── F254 D1.2b: queued_handled consumes only the completed target ──

  it('markQueuedHandledForCatAcrossUsers removes only the seen target from a multi-target entry', () => {
    const r = queue.enqueue(
      entry({
        content: 'multi target queued body',
        targetCats: ['opus', 'codex'],
        messageId: 'msg-1',
      }),
    );
    assert.equal(queue.markQueuedSeen('t1', 'u1', r.entry.id, 'opus', 'inv-opus-1'), true);

    const handled = queue.markQueuedHandledForCatAcrossUsers('t1', 'opus', 'inv-opus-1');

    assert.equal(handled.length, 1);
    assert.deepEqual(handled[0].messageIds, ['msg-1']);
    assert.deepEqual(handled[0].remainingTargetCats, ['codex']);
    assert.equal(handled[0].fullyConsumed, false);
    const remaining = queue.list('t1', 'u1');
    assert.equal(remaining.length, 1);
    assert.deepEqual(remaining[0].targetCats, ['codex']);
  });

  it('markQueuedHandledForCatAcrossUsers removes the entry when the last seen target is handled', () => {
    const r = queue.enqueue(
      entry({
        content: 'single target queued body',
        targetCats: ['opus'],
        messageId: 'msg-1',
      }),
    );
    queue.backfillMessageId('t1', 'u1', r.entry.id, 'msg-1b');
    r.entry.mergedMessageIds.push('msg-2');
    assert.equal(queue.markQueuedSeen('t1', 'u1', r.entry.id, 'opus', 'inv-opus-1'), true);

    const handled = queue.markQueuedHandledForCatAcrossUsers('t1', 'opus', 'inv-opus-1');

    assert.equal(handled.length, 1);
    assert.deepEqual(handled[0].messageIds, ['msg-1', 'msg-1b', 'msg-2']);
    assert.deepEqual(handled[0].remainingTargetCats, []);
    assert.equal(handled[0].fullyConsumed, true);
    assert.equal(queue.size('t1', 'u1'), 0);
  });

  it('markQueuedHandledForCatAcrossUsers ignores entries not seen by the completing cat', () => {
    const r = queue.enqueue(entry({ targetCats: ['opus'], messageId: 'msg-1' }));

    const handled = queue.markQueuedHandledForCatAcrossUsers('t1', 'opus', 'inv-opus-1');

    assert.deepEqual(handled, []);
    assert.equal(queue.size('t1', 'u1'), 1);
    assert.deepEqual(queue.list('t1', 'u1')[0].targetCats, ['opus']);
    assert.equal(queue.list('t1', 'u1')[0].id, r.entry.id);
  });

  it('markQueuedHandledForCatAcrossUsers ignores processing entries', () => {
    const r = queue.enqueue(entry({ targetCats: ['opus'], messageId: 'msg-1' }));
    assert.equal(queue.markQueuedSeen('t1', 'u1', r.entry.id, 'opus', 'inv-opus-1'), true);
    queue.markProcessing('t1', 'u1');

    const handled = queue.markQueuedHandledForCatAcrossUsers('t1', 'opus', 'inv-opus-1');

    assert.deepEqual(handled, []);
    assert.equal(queue.list('t1', 'u1')[0].status, 'processing');
  });

  it('markQueuedHandledForCatAcrossUsers ignores stale seen markers from another invocation', () => {
    const r = queue.enqueue(entry({ targetCats: ['opus'], messageId: 'msg-1' }));
    assert.equal(queue.markQueuedSeen('t1', 'u1', r.entry.id, 'opus', 'inv-failed'), true);

    const handled = queue.markQueuedHandledForCatAcrossUsers('t1', 'opus', 'inv-unrelated-success');

    assert.deepEqual(handled, []);
    assert.equal(queue.size('t1', 'u1'), 1);
    assert.deepEqual(queue.list('t1', 'u1')[0].targetCats, ['opus']);
  });

  it('clearQueuedSeenInvocationForCats removes only matching retry evidence', () => {
    const r = queue.enqueue(entry({ targetCats: ['opus', 'codex'], messageId: 'msg-1' }));
    assert.equal(queue.markQueuedSeen('t1', 'u1', r.entry.id, 'opus', 'inv-retry'), true);
    assert.equal(queue.markQueuedSeen('t1', 'u1', r.entry.id, 'codex', 'inv-other'), true);

    const cleared = queue.clearQueuedSeenInvocationForCats('t1', ['opus'], 'inv-retry');

    assert.equal(cleared, 1);
    const remaining = queue.list('t1', 'u1')[0];
    assert.deepEqual(remaining.queuedSeenByCatIds.sort(), ['codex', 'opus']);
    assert.deepEqual(remaining.queuedSeenInvocationIdByCatId, { codex: 'inv-other' });
    const handled = queue.markQueuedHandledForCatAcrossUsers('t1', 'opus', 'inv-retry');
    assert.deepEqual(handled, [], 'cleared retry evidence must not consume stale queued_seen');

    assert.equal(
      queue.markQueuedSeen('t1', 'u1', r.entry.id, 'opus', 'inv-retry'),
      false,
      'retry read refreshes evidence without creating a second queued_seen transition',
    );
    const currentAttemptHandled = queue.markQueuedHandledForCatAcrossUsers('t1', 'opus', 'inv-retry');
    assert.equal(currentAttemptHandled.length, 1, 'fresh retry read evidence remains eligible for handled closure');
  });

  it('clearQueuedSeenInvocationForCats also clears the exact stale Steer invocation', () => {
    const r = queue.enqueue(entry({ targetCats: ['opus'], messageId: 'msg-steer' }));
    assert.equal(queue.markSteering('t1', 'u1', r.entry.id, 'opus'), true);
    queue.markProcessing('t1', 'u1');
    assert.deepEqual(queue.markProcessingSeen('t1', 'u1', r.entry.id, ['opus'], 'inv-steer-retry'), ['opus']);
    assert.equal(queue.rollbackProcessing('t1', r.entry.id), true);

    const cleared = queue.clearQueuedSeenInvocationForCats('t1', ['opus'], 'inv-steer-retry');

    assert.equal(cleared, 1);
    const remaining = queue.list('t1', 'u1')[0];
    assert.equal(remaining.queuedSeenInvocationIdByCatId, undefined);
    assert.equal(remaining.steeredInvocationIdByCatId, undefined);
  });

  // ── Backfill / Merge IDs ──

  it('backfillMessageId sets messageId on new entry (null → value)', () => {
    const r = queue.enqueue(entry());
    assert.equal(r.entry.messageId, null);
    queue.backfillMessageId('t1', 'u1', r.entry.id, 'msg-123');
    assert.equal(queue.list('t1', 'u1')[0].messageId, 'msg-123');
  });

  it('never mutates a private input into a public History carrier', () => {
    const r = queue.enqueue(entry({ kind: 'private_input', source: 'system' }));

    assert.throws(
      () => queue.backfillMessageId('t1', 'u1', r.entry.id, 'msg-private-leak'),
      /private_input cannot reference a public History message/,
    );
    assert.equal(queue.list('t1', 'u1')[0].messageId, null);
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

  it('does not derive a hidden comparator rank from continuation source category', () => {
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

    assert.equal(queue.list('t1', 'u1')[0].content, 'new user request');
    assert.equal(queue.peekOldestAcrossUsers('t1').content, 'new user request');
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

  it('binds a targetless strict head without letting later explicit work pass it', () => {
    const targetless = queue.enqueue(entry({ userId: 'alice', content: 'continue', targetCats: [] })).entry;
    const explicit = queue.enqueue(entry({ userId: 'bob', content: 'later explicit', targetCats: ['opus'] })).entry;

    assert.equal(queue.peekOldestAcrossUsers('t1')?.id, targetless.id);
    assert.equal(queue.markProcessingAcrossUsers('t1'), null, 'an unresolved targetless head cannot be skipped');

    const picked = queue.markProcessingAcrossUsers('t1', {
      entryId: targetless.id,
      targetCats: ['opus'],
    });

    assert.equal(picked?.id, targetless.id);
    assert.deepEqual(picked?.targetCats, ['opus']);
    assert.equal(queue.getEntrySnapshot('t1', 'bob', explicit.id)?.status, 'queued');
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

  it('hasQueuedForThread keeps old queued entries visible until custody leaves Queue', () => {
    queue.enqueue(entry({ userId: 'alice' }));
    const listed = queue.list('t1', 'alice');
    listed[0].createdAt = Date.now() - 600_001;

    assert.equal(
      queue.hasQueuedForThread('t1'),
      true,
      'queued work must not disappear from lifecycle truth merely because it waited',
    );
  });

  it('hasDispatchableQueuedForThread keeps stale user entries visible for dispatch', () => {
    queue.enqueue(entry({ userId: 'alice', source: 'user' }));
    const listed = queue.list('t1', 'alice');
    listed[0].createdAt = Date.now() - 600_001;

    assert.equal(queue.hasQueuedForThread('t1'), true, 'thread state must still expose old queued user work');
    assert.equal(
      queue.hasDispatchableQueuedForThread('t1'),
      true,
      'dispatch gate must still see stale user work as pending queue work',
    );
  });

  it('hasDispatchableQueuedForThread keeps stale connector entries visible for dispatch', () => {
    queue.enqueue(entry({ userId: 'alice', source: 'connector' }));
    const listed = queue.list('t1', 'alice');
    listed[0].createdAt = Date.now() - 600_001;

    assert.equal(queue.hasQueuedForThread('t1'), true, 'thread state must still expose old queued connector work');
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
      kind: 'private_input',
      content: 'stale handoff',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
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
      kind: 'private_input',
      content: 'fresh handoff',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
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
      kind: 'private_input',
      content: 'stale',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      kind: 'private_input',
      content: 'fresh',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
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
        kind: 'private_input',
        content: `stale-${i}`,
        source: 'agent',
        ownerAuthProvenance: 'unknown',
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
      kind: 'private_input',
      content: 'fresh handoff',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
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
      kind: 'private_input',
      content: 'stale handoff',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    const listed = queue.list('t1', 'system');
    listed[0].createdAt = Date.now() - 60_000 - 1;

    assert.equal(queue.hasQueuedForThread('t1'), true);
    assert.equal(queue.list('t1', 'system').length, 1, 'old agent row must remain queued for dispatch');
  });

  it('markProcessingAcrossUsers dispatches old queued agent entries instead of deleting them', () => {
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      kind: 'private_input',
      content: 'stale handoff',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    const stale = queue.list('t1', 'system');
    stale[0].createdAt = Date.now() - 60_000 - 1;

    queue.enqueue(entry({ userId: 'alice', content: 'fresh user work' }));
    const marked = queue.markProcessingAcrossUsers('t1');

    assert.equal(marked.userId, 'system');
    assert.equal(marked.content, 'stale handoff');
    assert.equal(queue.list('t1', 'system')[0].status, 'processing');
  });

  // ── F122B: agent source + autoExecute ──

  it('accepts an agent MessageFrom with autoExecute', () => {
    const result = queue.enqueue({
      threadId: 't1',
      userId: 'system',
      kind: 'private_input',
      content: 'A2A handoff',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
      targetCats: ['opus'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'codex',
    });
    assert.equal(result.outcome, 'enqueued');
    assert.deepEqual(result.entry.from, { kind: 'agent', catId: 'codex' });
    assert.equal(result.entry.autoExecute, true);
    assert.equal(result.entry.source, undefined);
    assert.equal(result.entry.callerCatId, undefined);
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
      kind: 'private_input',
      content: 'A2A handoff',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
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
      kind: 'private_input',
      content: 'callback handoff',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
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
      kind: 'private_input',
      content: 'callback handoff',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
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
      kind: 'private_input',
      content: 'callback handoff',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
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
      kind: 'private_input',
      content: 'handoff',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
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
      kind: 'private_input',
      content: 'fresh',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      kind: 'private_input',
      content: 'stale',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
      targetCats: ['opencode'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });

    // list() returns shallow-copied array with reference elements — mutating
    // createdAt here reaches the real entry inside the queue (coupling on purpose).
    const listed = queue.list('t1', 'system');
    listed[1].createdAt = Date.now() - 60_000 - 1;

    const autoEntries = queue.listAutoExecute('t1');
    assert.equal(autoEntries.length, 2, 'old queued autoExecute entries must remain dispatchable');
    assert.deepEqual(autoEntries.map((entry) => entry.targetCats[0]).sort(), ['codex', 'opencode']);
  });

  it('hasQueuedOrProcessingForCat treats old queued autoExecute entries as busy', () => {
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      kind: 'private_input',
      content: 'stale but still dispatchable',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });

    const listed = queue.list('t1', 'system');
    listed[0].createdAt = Date.now() - 60_000 - 1;

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
      kind: 'private_input',
      content: 'handoff',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
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
      kind: 'private_input',
      content: 'handoff',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
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
      kind: 'private_input',
      content: 'handoff',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
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

  it('hasActiveOrQueuedAgentForCat can exclude the current processing entry', () => {
    const current = queue.enqueue({
      threadId: 't1',
      userId: 'system',
      kind: 'private_input',
      content: 'current multi-target handoff',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
      targetCats: ['opus-47', 'codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    queue.markProcessing('t1', 'system');

    assert.equal(queue.hasActiveOrQueuedAgentForCat('t1', 'codex'), true);
    assert.equal(
      queue.hasActiveOrQueuedAgentForCat('t1', 'codex', { excludeEntryId: current.entry.id }),
      false,
      'current route entry must not block a later same-route A2A handoff back to an already-run target',
    );
  });

  it('hasActiveOrQueuedAgentForCat still blocks other pending entries when excluding current entry', () => {
    const current = queue.enqueue({
      threadId: 't1',
      userId: 'system',
      kind: 'private_input',
      content: 'current route',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
      targetCats: ['opus-47', 'codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    queue.markProcessing('t1', 'system');
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      kind: 'private_input',
      content: 'already queued callback handoff',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });

    assert.equal(
      queue.hasActiveOrQueuedAgentForCat('t1', 'codex', { excludeEntryId: current.entry.id }),
      true,
      'a separate queued agent entry must still block duplicate text-scan A2A',
    );
  });

  it('hasActiveOrQueuedAgentForCat returns false after entry completes', () => {
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      kind: 'private_input',
      content: 'handoff',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
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
      kind: 'conversation_input',
      content: 'queued in another thread',
      source: 'user',
      ownerAuthProvenance: 'unknown',
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
      kind: 'private_input',
      content: 'handoff',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
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
      kind: 'private_input',
      content: 'handoff',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
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
      kind: 'private_input',
      content: 'handoff',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
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

  // ── RFC #1356: fairness follows public conversation kind, not sender identity ──

  it('hasQueuedConversationInputsForThread blocks text-scan for connector conversation input', () => {
    queue.enqueue(entry({ source: 'connector', targetCats: ['opus'] }));
    assert.equal(
      queue.hasQueuedConversationInputsForThread('t1'),
      true,
      'public connector input must participate in the same fairness gate as user input',
    );
  });

  it('hasQueuedConversationInputsForThread blocks public agent/system input but not private or wake work', () => {
    queue.enqueue(entry({ source: 'agent', targetCats: ['opus'], callerCatId: 'codex' }));
    assert.equal(queue.hasQueuedConversationInputsForThread('t1'), true, 'public kind, not sender, owns fairness');

    queue.markProcessing('t1', 'u1');
    queue.enqueue(entry({ kind: 'private_input', source: 'agent', messageId: null, targetCats: ['opus'] }));
    queue.enqueue(entry({ kind: 'message_wake', source: 'agent', messageId: 'msg-1', targetCats: ['opus'] }));
    assert.equal(queue.hasQueuedConversationInputsForThread('t1'), false, 'private and wake work are not public input');
  });

  // ── F185 Phase B P1-1: deferred A2A messageId preservation ──

  it('enqueue preserves messageId when provided (F185-B deferred handoff)', () => {
    const result = queue.enqueue(
      entry({
        source: 'agent',
        sourceCategory: 'a2a',
        callerCatId: 'opus',
        messageId: 'msg-trigger-123',
      }),
    );
    assert.equal(
      result.entry.messageId,
      'msg-trigger-123',
      'deferred A2A entry must carry triggerMessageId as messageId',
    );
  });

  it('enqueue defaults messageId to null when not provided', () => {
    const result = queue.enqueue(entry({ source: 'user' }));
    assert.equal(result.entry.messageId, null, 'messageId must default to null for normal entries');
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

  it('applies explicit position before FIFO across the whole thread Queue', () => {
    queue.enqueue(entry({ userId: 'alice', content: 'alice-first' }));
    const bobEntry = queue.enqueue(entry({ userId: 'bob', content: 'bob-second' }));
    queue.setPosition('t1', 'bob', bobEntry.entry.id, 0);

    const next = queue.peekOldestAcrossUsers('t1');
    assert.equal(next.userId, 'bob');
  });

  // ── RFC #1356 §6.4: compatible conversation prefix ──

  it('collectCompatibleConversationPrefix collects adjacent public inputs regardless of sender', () => {
    queue.enqueue(entry({ content: 'a', source: 'user', targetCats: ['c1'], intent: 'execute' }));
    queue.enqueue(entry({ content: 'b', source: 'connector', targetCats: ['c1'], intent: 'execute' }));
    queue.enqueue(entry({ content: 'c', source: 'system', targetCats: ['c1'], intent: 'execute' }));
    const head = queue.markProcessing('t1', 'u1');
    const batch = queue.collectCompatibleConversationPrefix(head);
    assert.deepEqual(
      batch.map((e) => e.content),
      ['b', 'c'],
    );
  });

  it('collectCompatibleConversationPrefix shares targetless admission but stops before explicit routing', () => {
    const headEntry = queue.enqueue(entry({ content: 'a', targetCats: [] })).entry;
    queue.enqueue(entry({ content: 'b', source: 'connector', targetCats: [] }));
    queue.enqueue(entry({ content: 'c', targetCats: ['opus'] }));
    const head = queue.markProcessingAcrossUsers('t1', {
      entryId: headEntry.id,
      targetCats: ['opus'],
    });

    const batch = queue.collectCompatibleConversationPrefix(head, {
      routingClass: 'targetless',
      requestedTargets: [],
      resolvedTargets: ['opus'],
    });

    assert.deepEqual(
      batch.map((candidate) => candidate.content),
      ['b'],
    );
  });

  it('does not batch user entries across owner authentication provenance', () => {
    queue.enqueue(
      entry({
        content: 'strict-owner-message',
        source: 'user',
        targetCats: ['c1'],
        intent: 'execute',
        ownerAuthProvenance: 'strict',
      }),
    );
    queue.enqueue(
      entry({
        content: 'fallback-owner-message',
        source: 'user',
        targetCats: ['c1'],
        intent: 'execute',
        ownerAuthProvenance: 'compatibility_fallback',
      }),
    );

    const head = queue.markProcessing('t1', 'u1');
    const batch = queue.collectCompatibleConversationPrefix(head);

    assert.equal(batch.length, 0);
  });

  it('collectCompatibleConversationPrefix stops at different intent', () => {
    queue.enqueue(entry({ content: 'a', source: 'user', targetCats: ['c1'], intent: 'execute' }));
    queue.enqueue(entry({ content: 'b', source: 'user', targetCats: ['c1'], intent: 'search' }));
    const head = queue.markProcessing('t1', 'u1');
    const batch = queue.collectCompatibleConversationPrefix(head);
    assert.equal(batch.length, 0);
  });

  it('collectCompatibleConversationPrefix stops at message-wake and private-input boundaries', () => {
    queue.enqueue(entry({ content: 'a', source: 'user', targetCats: ['c1'], intent: 'execute' }));
    queue.enqueue(
      entry({ kind: 'message_wake', content: 'b', source: 'agent', messageId: 'msg-1', targetCats: ['c1'] }),
    );
    queue.enqueue(entry({ content: 'c', source: 'user', targetCats: ['c1'], intent: 'execute' }));
    const head = queue.markProcessing('t1', 'u1');
    assert.deepEqual(queue.collectCompatibleConversationPrefix(head), []);
  });

  it('collectCompatibleConversationPrefix does not batch across different targetCats', () => {
    queue.enqueue(entry({ content: 'a', source: 'user', targetCats: ['c1'], intent: 'execute' }));
    queue.enqueue(entry({ content: 'b', source: 'user', targetCats: ['c1', 'c2'], intent: 'execute' }));
    const head = queue.markProcessing('t1', 'u1');
    const batch = queue.collectCompatibleConversationPrefix(head);
    assert.equal(batch.length, 0);
  });

  it('collectCompatibleConversationPrefix returns empty for a non-conversation head', () => {
    const wake = queue.enqueue(entry({ kind: 'message_wake', source: 'agent', messageId: 'msg-1' })).entry;
    queue.enqueue(entry({ content: 'b' }));
    const head = queue.markProcessing('t1', 'u1');
    assert.equal(head.id, wake.id);
    const batch = queue.collectCompatibleConversationPrefix(head);
    assert.equal(batch.length, 0);
  });

  it('collectCompatibleConversationPrefix stops when another user scope owns the next comparator row', () => {
    queue.enqueue(entry({ userId: 'alice', content: 'head', targetCats: ['c1'] }));
    queue.enqueue(entry({ userId: 'bob', content: 'barrier', targetCats: ['c1'] }));
    queue.enqueue(entry({ userId: 'alice', content: 'later', targetCats: ['c1'] }));
    const head = queue.markProcessingAcrossUsers('t1');
    assert.deepEqual(queue.collectCompatibleConversationPrefix(head), []);
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

  // ── RFC #1356: public conversation fairness ──

  it('hasQueuedConversationInputsForThread returns false when only private entries are queued', () => {
    queue.enqueue({
      threadId: 't1',
      userId: 'system',
      kind: 'private_input',
      content: 'handoff',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });
    assert.equal(
      queue.hasQueuedConversationInputsForThread('t1'),
      false,
      'private work must not impersonate public input',
    );
  });

  it('hasQueuedConversationInputsForThread returns true when connector public input is queued', () => {
    queue.enqueue(entry({ source: 'connector', targetCats: ['opus'] }));
    assert.equal(queue.hasQueuedConversationInputsForThread('t1'), true);
  });

  it('hasQueuedConversationInputsForThread returns true when user public input is queued', () => {
    queue.enqueue(entry({ source: 'user' }));
    assert.equal(queue.hasQueuedConversationInputsForThread('t1'), true);
  });

  it('hasQueuedConversationInputsForThread ignores processing entries', () => {
    queue.enqueue(entry({ source: 'connector', targetCats: ['opus'] }));
    queue.markProcessing('t1', 'u1');
    assert.equal(queue.hasQueuedConversationInputsForThread('t1'), false, 'processing entries are already admitted');
  });

  it('hasQueuedConversationInputsForThread returns false for empty queue', () => {
    assert.equal(queue.hasQueuedConversationInputsForThread('t1'), false);
  });

  // ── RFC #1356: priority is explicit envelope data, never source-derived ──

  it('preserves explicit urgent priority for agent entries', () => {
    const result = queue.enqueue({
      threadId: 't1',
      userId: 'system',
      kind: 'private_input',
      content: 'A2A handoff',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
      priority: 'urgent',
    });
    assert.equal(result.entry.priority, 'urgent');
  });

  it('allows urgent priority for continuation entries (AC-12)', () => {
    const result = queue.enqueue({
      threadId: 't1',
      userId: 'system',
      kind: 'private_input',
      content: 'continuation',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
      sourceCategory: 'continuation',
      targetCats: ['opus'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
      priority: 'urgent',
    });
    assert.equal(result.entry.priority, 'urgent', 'continuation entry must keep urgent priority');
  });

  it('allows urgent priority for connector entries', () => {
    const result = queue.enqueue(entry({ source: 'connector', priority: 'urgent', sourceCategory: 'ci' }));
    assert.equal(result.entry.priority, 'urgent', 'connector urgent must not be affected');
  });

  // ── R2-P2: compatible prefix follows comparator order ──

  it('collectCompatibleConversationPrefix returns entries sorted by comparator (R2-P2)', () => {
    queue.enqueue(entry({ content: 'B', priority: 'normal' }));
    queue.enqueue(entry({ content: 'D', priority: 'urgent' }));
    queue.enqueue(entry({ content: 'E', priority: 'urgent' }));

    // Mark D as processing; E remains ahead of normal-priority B.
    queue.markProcessing('t1', 'u1');

    const batch = queue.collectCompatibleConversationPrefix(
      queue.list('t1', 'u1').find((e) => e.status === 'processing'),
    );
    const contents = batch.map((e) => e.content);
    assert.deepStrictEqual(contents, ['E', 'B'], 'batch should follow comparator order: E(pos=1) then B(no pos)');
  });

  // ── F153: callerTraceContext propagation ──

  it('F153: callerTraceContext flows through enqueue + dequeue', () => {
    const ctx = { traceId: 'aabb', spanId: 'ccdd', traceFlags: 1 };
    queue.enqueue(entry({ callerTraceContext: ctx }));
    const d = queue.dequeue('t1', 'u1');
    assert.deepEqual(d.callerTraceContext, ctx);
  });

  it('F153: entries without callerTraceContext have undefined', () => {
    queue.enqueue(entry());
    const d = queue.dequeue('t1', 'u1');
    assert.equal(d.callerTraceContext, undefined);
  });

  // findProcessingByCat (2026-06-02 Steer 抢占 tombstone support)
  describe('findProcessingByCat', () => {
    it('finds the processing entry targeting a cat (across users)', () => {
      queue.enqueue(entry({ userId: 'u1', targetCats: ['opus'] }));
      queue.markProcessing('t1', 'u1'); // → processing
      queue.enqueue(entry({ userId: 'u2', targetCats: ['codex'] }));
      queue.markProcessing('t1', 'u2');
      const found = queue.findProcessingByCat('t1', 'opus');
      assert.ok(found);
      assert.equal(found.targetCats[0], 'opus');
      assert.equal(found.status, 'processing');
    });

    it('returns null when the cat has no processing entry (only queued)', () => {
      queue.enqueue(entry({ targetCats: ['opus'] })); // queued, not processing
      assert.equal(queue.findProcessingByCat('t1', 'opus'), null);
    });

    it('returns null for a different cat', () => {
      queue.enqueue(entry({ targetCats: ['opus'] }));
      queue.markProcessing('t1', 'u1');
      assert.equal(queue.findProcessingByCat('t1', 'codex'), null);
    });
  });
});
