import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { canonicalTestMessageInput, canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { queueEntryId } = await import('../dist/domains/cats/services/agents/invocation/queue-ledger/QueueLedger.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');

function setup() {
  const messageStore = new MessageStore();
  const events = [];
  const requestDrain = mock.fn(async () => {
    events.push('drain');
  });
  const invocationQueue = new InvocationQueue(undefined, {
    onAdmitted: ({ threadId }) => {
      void requestDrain(threadId);
    },
  });
  const tryAutoAppendExactEntry = mock.fn(async () => {
    events.push('append');
    return { outcome: 'rejected' };
  });
  const registerCallerDispatchInitialTargets = mock.fn(() => {
    events.push('observe');
  });
  const deps = {
    messageStore,
    invocationQueue,
    queueProcessor: { requestDrain, tryAutoAppendExactEntry, registerCallerDispatchInitialTargets },
    socketManager: {
      emitToUser: mock.fn(),
      broadcastAgentMessage: mock.fn(),
    },
    log: {
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
    },
  };
  const appendTrigger = (id) =>
    messageStore.append(
      canonicalTestMessageInput({
        id,
        from: { kind: 'agent', catId: 'opus' },
        userId: 'u1',
        catId: 'opus',
        threadId: 't1',
        content: `source-${id}`,
        mentions: ['codex'],
        timestamp: Date.now(),
      }),
    );
  return { deps, events, invocationQueue, messageStore, appendTrigger };
}

async function enqueue(deps, triggerMessage, targetCats = ['codex'], options = {}) {
  return enqueueA2ATargets(deps, {
    targetCats,
    content: triggerMessage.content,
    userId: 'u1',
    ownerAuthProvenance: 'strict',
    threadId: 't1',
    triggerMessage,
    callerCatId: 'opus',
    parentInvocationId: 'parent-1',
    ...options,
  });
}

describe('enqueueA2ATargets single durable ledger', () => {
  for (const mixed of [false, true])
    it(`does not promise a new execution preflight for exact continuation${mixed ? ' in mixed fan-out' : ''}`, async () => {
      const { deps, invocationQueue, messageStore, appendTrigger } = setup();
      const trigger = appendTrigger(`continuation-${mixed}`);
      const targets = mixed ? ['codex', 'fable5'] : ['codex'];
      const admitted = await invocationQueue.enqueueExistingMessageDurable(messageStore, trigger.id, {
        from: trigger.from,
        userId: 'u1',
        ownerAuthProvenance: 'strict',
        threadId: 't1',
        kind: 'message_wake',
        content: trigger.content,
        messageId: trigger.id,
        sourceId: trigger.id,
        sourceCategory: 'a2a',
        targetCats: targets,
        intent: 'execute',
        autoExecute: true,
        authorIntentByCatId: {
          codex: { requested: 'continue_current', boundParentInvocationId: 'exact-parent' },
          ...(mixed ? { fable5: { requested: 'next_work' } } : {}),
        },
      });
      assert.equal(admitted.outcome, 'enqueued');
      deps.routingDispatchPreflight = {
        preflight: mock.fn(async ({ targetCatIds }) => ({
          v: 1,
          ownerId: 'u1',
          observedAt: Date.now(),
          resolverState: 'fresh',
          snapshotRef: 'snapshot:B',
          targets: targetCatIds.map((targetCatId) => ({
            targetCatId,
            disposition: 'allowed',
            reasons: [],
            alternatives: [],
          })),
        })),
      };
      const result = await enqueue(deps, trigger, targets, { preAdmittedEntries: [admitted.entry] });
      assert.deepEqual(result.enqueued, targets);
      if (mixed) {
        assert.deepEqual(
          result.routingAdmission.targets.map((target) => target.targetCatId),
          ['fable5'],
        );
        assert.deepEqual(deps.routingDispatchPreflight.preflight.mock.calls[0].arguments[0].targetCatIds, ['fable5']);
      } else {
        assert.equal(result.routingAdmission, undefined);
        assert.equal(deps.routingDispatchPreflight.preflight.mock.calls.length, 0);
        assert.equal(invocationQueue.list('t1', 'u1')[0].delivery.routingAdmission, undefined);
      }
    });

  it('fans one public Agent message into one deterministic source row with pending targets', async () => {
    const { deps, invocationQueue, messageStore, appendTrigger } = setup();
    const trigger = appendTrigger('a2a-source-1');

    const result = await enqueue(deps, trigger, ['codex', 'fable5']);

    assert.deepEqual(result, { enqueued: ['codex', 'fable5'] });
    const rows = invocationQueue.list('t1', 'u1');
    assert.deepEqual(
      rows.map((row) => ({
        id: row.id,
        targets: row.targets,
        messageId: row.payload.messageId,
      })),
      [{ id: queueEntryId(trigger.id), targets: ['codex', 'fable5'], messageId: trigger.id }],
    );
    const persisted = messageStore.getById(trigger.id);
    assert.equal(persisted.queueCustody, undefined);
    assert.equal(persisted.queueCustodyAdmission, undefined);
    assert.equal(deps.queueProcessor.registerCallerDispatchInitialTargets.mock.calls.length, 1);
    assert.equal(deps.queueProcessor.registerCallerDispatchInitialTargets.mock.calls[0].arguments[0].id, trigger.id);
    assert.deepEqual(deps.queueProcessor.registerCallerDispatchInitialTargets.mock.calls[0].arguments[1], [
      'codex',
      'fable5',
    ]);
  });

  it('annotates unavailable targets without dropping their durable Queue admission', async () => {
    const { deps, invocationQueue, appendTrigger } = setup();
    const decision = {
      v: 1,
      ownerId: 'u1',
      observedAt: Date.now(),
      resolverState: 'fresh',
      targets: [
        {
          targetCatId: 'codex',
          disposition: 'rejected',
          reasons: [{ code: 'quota_exhausted', summary: 'Wait for recovery', sourceRefs: ['quota:1'] }],
          alternatives: [{ catId: 'fable5', displayName: 'Fable', reason: 'Available' }],
        },
      ],
    };
    deps.routingDispatchPreflight = { preflight: mock.fn(async () => decision) };
    const result = await enqueue(deps, appendTrigger('a2a-unavailable'));
    assert.deepEqual(result.enqueued, ['codex']);
    assert.deepEqual(invocationQueue.list('t1', 'u1')[0].targets, ['codex']);
    assert.equal(
      result.routingPreflight,
      undefined,
      'enqueue acknowledgement cannot impersonate an execution decision',
    );
    assert.equal(result.routingAdmission.stage, 'queue_admitted');
    assert.equal(result.routingAdmission.executionPreflight, 'pending');
    assert.equal(result.routingAdmission.targets[0].disposition, undefined);
    assert.equal(result.routingAdmission.snapshotRef, decision.snapshotRef);
    assert.deepEqual(result.routingAdmission.targets[0].reasons, decision.targets[0].reasons);
    const provenance = invocationQueue.list('t1', 'u1')[0].delivery.routingAdmission;
    assert.equal(provenance.stage, 'queue_admitted');
    assert.equal(provenance.targets[0].targetCatId, 'codex');
    assert.match(provenance.targets[0].factsRef, /^sha256:/);
    assert.equal(provenance.targets[0].capacityFacts, undefined, 'Queue only retains decision provenance');
    assert.equal(deps.routingDispatchPreflight.preflight.mock.calls[0].arguments[0].ownerRequestedAttempt, undefined);
  });

  it('replay converges by source id and target without duplicating a row', async () => {
    const { deps, invocationQueue, appendTrigger } = setup();
    const trigger = appendTrigger('a2a-source-replay');

    await enqueue(deps, trigger);
    await enqueue(deps, trigger);

    assert.equal(invocationQueue.list('t1', 'u1').length, 1);
    assert.equal(invocationQueue.list('t1', 'u1')[0].id, queueEntryId(trigger.id));
  });

  it('skips a consumed source instead of recreating Queue work after its row is gone', async () => {
    const { deps, invocationQueue, messageStore, appendTrigger, events } = setup();
    const trigger = appendTrigger('a2a-source-consumed');

    await enqueue(deps, trigger);
    const [row] = invocationQueue.list('t1', 'u1');
    assert.ok(row);
    const claim = await invocationQueue.markProcessingDurable('t1', 'u1', {
      entryId: row.id,
      targetCats: ['codex'],
    });
    assert.equal(claim.status, 'claimed');
    assert.equal(await invocationQueue.commitClaimedProcessing('t1', [row.id], Date.now()), true);
    const lifecycle = messageStore.getById(trigger.id)?.lifecycle;
    assert.ok(lifecycle);
    assert.equal(
      messageStore.advanceLifecycleInputDispatch(trigger.id, {
        orderKey: lifecycle.orderKey,
        ...(lifecycle.producerInvocationId ? { producerInvocationId: lifecycle.producerInvocationId } : {}),
        targetId: 'codex',
        phase: 'dispatched',
        statusMessageId: 'a2a-source-consumed-response',
        dispatchedAt: Date.now(),
      }).kind,
      'applied',
    );
    assert.ok(await invocationQueue.removeProcessedAcrossUsersDurable('t1', row.id, 'succeeded'));

    assert.deepEqual(await enqueue(deps, trigger), { enqueued: [] });
    assert.equal(invocationQueue.list('t1', 'u1').length, 0);
    assert.deepEqual(events, ['observe', 'drain']);
  });

  it('keeps distinct source bodies as distinct work orders instead of concatenating them', async () => {
    const { deps, invocationQueue, appendTrigger } = setup();
    const first = appendTrigger('a2a-source-first');
    const second = appendTrigger('a2a-source-second');

    await enqueue(deps, first);
    await enqueue(deps, second);

    const rows = invocationQueue.list('t1', 'u1');
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.payload.messageId),
      [first.id, second.id],
    );
    assert.deepEqual(
      rows.map((row) => row.payload.content),
      [first.content, second.content],
    );
  });

  it('applies the chain-depth limit once per source row without splitting its fan-out', async () => {
    const { deps, invocationQueue, appendTrigger } = setup();
    for (let index = 0; index < 9; index += 1) {
      invocationQueue.enqueueDurableNow(
        canonicalTestQueueInput({
          sourceId: `seed-${index}`,
          from: { kind: 'agent', catId: 'opus' },
          threadId: 't1',
          userId: 'u1',
          kind: 'message_wake',
          ownerAuthProvenance: 'strict',
          content: `seed-${index}`,
          messageId: `seed-message-${index}`,
          targetCats: ['codex'],
          sourceCategory: 'a2a',
          intent: 'execute',
          autoExecute: true,
        }),
      );
    }
    const trigger = appendTrigger('a2a-source-depth');

    const result = await enqueue(deps, trigger, ['codex', 'fable5']);

    assert.deepEqual(result, { enqueued: ['codex', 'fable5'] });
    assert.equal(invocationQueue.list('t1', 'u1').length, 10);
  });

  it('delegates the admitted row to Queue without ingress-owned Append or Ball custody', async () => {
    const { deps, events, appendTrigger } = setup();
    deps.ballCustody = {
      record: mock.fn(async () => {
        events.push('ball');
      }),
    };
    const trigger = appendTrigger('a2a-source-order');

    await enqueue(deps, trigger);

    assert.deepEqual(events, ['observe', 'drain']);
  });

  it('rejects sources that are not persisted public Agent messages', async () => {
    const { deps } = setup();
    const forged = canonicalTestMessageInput({
      id: 'missing-source',
      from: { kind: 'agent', catId: 'opus' },
      userId: 'u1',
      catId: 'opus',
      threadId: 't1',
      content: 'not persisted',
      mentions: ['codex'],
      timestamp: Date.now(),
    });

    await assert.rejects(enqueue(deps, forged), /persisted public agent source message/);
  });
});
