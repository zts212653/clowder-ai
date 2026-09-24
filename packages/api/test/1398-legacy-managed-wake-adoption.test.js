import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { createLegacyManagedWakeAdoption } = await import(
  '../dist/domains/ball-custody/legacy-managed-wake-adoption.js'
);
const { ManagedCommandWakeActionLeaseAdmissionError } = await import(
  '../dist/domains/ball-custody/managed-command-wake-action-lease-admission.js'
);

/**
 * #1398 — the migration path for wakes persisted by the two-phase producer.
 *
 * `message_written` / `dispatch_pending` tasks carry a durable Message with no Queue row. The old
 * `ConnectorInvokeTrigger` verified the action lease at exactly this step, so an adoption that
 * skips it admits a generation that has since moved on — and it does so on the one path where
 * stale carriers actually live, since these messages come FROM the old path.
 *
 * Both historical shapes are covered: an active generation must put its exact fence on the row, and
 * a stale one must write nothing and raise the error the recovery engine turns into cancel/retire.
 */
const THREAD = 'thread-legacy';
const USER = 'user-legacy';
const CAT = 'opus';

function legacyWakeMessage(actionLeaseRef) {
  return {
    from: { kind: 'system', service: 'managed-command-wake' },
    userId: USER,
    content: '[定时任务] gate finished',
    mentions: [],
    timestamp: 1_000,
    threadId: THREAD,
    deliveryStatus: 'queued',
    idempotencyKey: 'hold-ball-completion:legacy-task',
    source: {
      connector: 'hold-ball',
      label: '持球通知',
      icon: '🏓',
      meta: {
        managedHold: true,
        phase: 'wake',
        taskId: 'legacy-task',
        threadId: THREAD,
        catId: CAT,
        wakeWhen: true,
        ...(actionLeaseRef ? { actionLeaseRef } : {}),
      },
    },
  };
}

async function setup({ actionLeaseRef, lease }) {
  const messageStore = new MessageStore();
  const invocationQueue = new InvocationQueue();
  // The pre-atomic state this migration exists for: Message durable, Queue empty.
  const stored = await messageStore.append(legacyWakeMessage(actionLeaseRef));
  assert.deepEqual(await invocationQueue.getDurableEntriesForMessages(THREAD, [stored.id]), new Map());

  const notified = [];
  const adopt = createLegacyManagedWakeAdoption({
    messageStore,
    invocationQueue,
    messageStoreForQueue: messageStore,
    ...(lease ? { actionSuccessorLeaseStore: { get: async () => lease } } : {}),
    notifyAdmitted: async (threadId, userId) => notified.push(`${threadId}:${userId}`),
  });
  return { messageStore, invocationQueue, stored, adopt, notified };
}

const adoptionInput = (messageId) => ({
  messageId,
  threadId: THREAD,
  userId: USER,
  catId: CAT,
  content: '[定时任务] gate finished',
});

describe('#1398 legacy managed wake adoption', () => {
  test('an active generation is adopted with its exact fence on the Queue row', async () => {
    const { invocationQueue, stored, adopt, notified } = await setup({
      actionLeaseRef: { leaseId: 'lease-legacy-1', generation: 4 },
      lease: {
        leaseId: 'lease-legacy-1',
        generation: 4,
        status: 'active',
        tenantScope: USER,
        holderThreadId: THREAD,
        holderCatIds: [CAT],
        dispatchId: 'dispatch-legacy-1',
        terminalPredicate: { kind: 'task_done' },
      },
    });

    assert.deepEqual(await adopt(adoptionInput(stored.id)), { adopted: true });

    const rows = (await invocationQueue.getDurableEntriesForMessages(THREAD, [stored.id])).get(stored.id);
    assert.equal(rows?.length, 1, 'exactly one Queue row adopts the legacy message');
    assert.equal(rows[0].execution.actionSuccessorFence?.leaseId, 'lease-legacy-1');
    assert.equal(rows[0].execution.actionSuccessorFence?.generation, 4, 'the exact generation, not a fresh one');
    assert.equal(rows[0].priority, 'urgent');
    assert.equal(rows[0].sourceCategory, 'scheduled');
    assert.deepEqual(rows[0].targets, [CAT]);
    assert.deepEqual(notified, [`${THREAD}:${USER}`], 'and the drain is asked to look, once');
  });

  test('a stale generation writes nothing and raises for the retire path', async () => {
    const { invocationQueue, stored, adopt, notified } = await setup({
      actionLeaseRef: { leaseId: 'lease-legacy-1', generation: 4 },
      // Canonical truth has moved on to generation 5.
      lease: {
        leaseId: 'lease-legacy-1',
        generation: 5,
        status: 'active',
        tenantScope: USER,
        holderThreadId: THREAD,
        holderCatIds: [CAT],
        dispatchId: 'dispatch-legacy-1',
        terminalPredicate: { kind: 'task_done' },
      },
    });

    await assert.rejects(
      () => adopt(adoptionInput(stored.id)),
      ManagedCommandWakeActionLeaseAdmissionError,
      'a superseded generation must not be adopted just because its message is durable',
    );

    assert.deepEqual(
      await invocationQueue.getDurableEntriesForMessages(THREAD, [stored.id]),
      new Map(),
      'zero Queue writes for a refused generation',
    );
    assert.deepEqual(notified, [], 'and nothing is announced');
  });

  test('a legacy wake with no lease ref is adopted unfenced, as it was written', async () => {
    const { invocationQueue, stored, adopt } = await setup({});

    assert.deepEqual(await adopt(adoptionInput(stored.id)), { adopted: true });

    const rows = (await invocationQueue.getDurableEntriesForMessages(THREAD, [stored.id])).get(stored.id);
    assert.equal(rows?.length, 1);
    assert.equal(rows[0].execution.actionSuccessorFence, undefined, 'no fence invented where none existed');
  });

  test('a lease-bound wake is refused when no canonical lease store is available', async () => {
    const { invocationQueue, stored, adopt } = await setup({
      actionLeaseRef: { leaseId: 'lease-legacy-1', generation: 4 },
    });

    // Fail closed: an unverifiable generation is not an admissible one.
    await assert.rejects(() => adopt(adoptionInput(stored.id)), ManagedCommandWakeActionLeaseAdmissionError);
    assert.deepEqual(await invocationQueue.getDurableEntriesForMessages(THREAD, [stored.id]), new Map());
  });
});
