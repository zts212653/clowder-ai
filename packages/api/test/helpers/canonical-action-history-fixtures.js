import assert from 'node:assert/strict';
import { buildActionSuccessorFence } from '../../dist/domains/ball-custody/ActionSuccessorAdmissionContract.js';
import { resolveDirectActionSuccessorCarrier } from '../../dist/domains/ball-custody/DirectActionSuccessorCarrierRecovery.js';
import {
  actionSuccessorInvocationKeyForTarget,
  InvocationQueue,
} from '../../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryQueueLedgerStore } from '../../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { InMemoryTurnExecutionStore } from '../../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { InvocationRecordStore } from '../../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { lease, oldInvocationKey, request } from './direct-action-carrier-fixtures.js';

function recordHolderExecution({ current, admitted, messages, records, turns }, holder, status, legacyKey) {
  const parentId = records.create({
    threadId: current.holderThreadId,
    userId: current.tenantScope,
    targetCats: [holder],
    intent: 'execute',
    idempotencyKey: legacyKey
      ? oldInvocationKey(current, holder)
      : actionSuccessorInvocationKeyForTarget(admitted.message.id, holder),
    actionLeaseCarrier: { kind: 'action_successor', leaseId: current.leaseId, generation: current.generation },
  }).invocationId;
  records.update(parentId, { status: 'running' });
  const childId = `canonical-child-${holder}`;
  turns.createRunning({
    invocationId: childId,
    parentInvocationId: parentId,
    threadId: current.holderThreadId,
    userId: current.tenantScope,
    catId: holder,
    executionKind: 'ordinary',
    startedAt: 101,
    causal: { triggerMessageId: admitted.message.id },
  });
  if (status !== 'processing') {
    turns.transitionTerminal(childId, {
      status: status === 'completed' ? 'succeeded' : status,
      endedAt: 102,
      ...(status === 'completed' ? {} : { terminalReason: `fixture-${status}` }),
    });
    records.update(parentId, {
      status: status === 'completed' ? 'succeeded' : status === 'interrupted' ? 'failed' : status,
      ...(status === 'completed' ? { successfulCatIds: [holder] } : {}),
    });
  }
  const response = messages.append({
    threadId: current.holderThreadId,
    userId: current.tenantScope,
    from: { kind: 'agent', catId: holder },
    content: 'actual result',
    timestamp: 101,
    lifecycle: {
      kind: 'response',
      orderKey: `response-${holder}`,
      invocationId: childId,
      targetId: holder,
      inputEntryIds: [admitted.entry.id],
      inputMessageIds: [admitted.message.id],
      status,
      startedAt: 101,
      ...(status !== 'processing' ? { completedAt: 102 } : {}),
    },
  });
  const orderKey = messages.getById(admitted.message.id).lifecycle.orderKey;
  assert.equal(
    messages.advanceLifecycleInputDispatch(admitted.message.id, {
      orderKey,
      targetId: holder,
      phase: 'dispatched',
      statusMessageId: response.id,
      dispatchedAt: 101,
    }).kind,
    'applied',
  );
  if (status !== 'processing')
    assert.equal(
      messages.advanceLifecycleInputDispatch(admitted.message.id, {
        orderKey,
        targetId: holder,
        phase: 'settled',
        statusMessageId: response.id,
      }).kind,
      'applied',
    );
  return { parentId, childId, responseId: response.id };
}

/** Real pending owner and durable source/response/child/parent; no receipt reconstruction. */
export async function canonicalActionFixture({
  status = 'completed',
  leaseChanges = {},
  legacyKey = false,
  stores = {},
} = {}) {
  const current = lease(leaseChanges);
  const fence = buildActionSuccessorFence(current, current.dispatchId);
  const ledger = stores.ledger ?? new InMemoryQueueLedgerStore();
  const queue = stores.queue ?? new InvocationQueue(ledger);
  const messages = stores.messages ?? new MessageStore();
  const records = stores.records ?? new InvocationRecordStore();
  const turns = stores.turns ?? new InMemoryTurnExecutionStore();
  const admitted = await queue.send(
    messages,
    {
      threadId: current.holderThreadId,
      userId: current.tenantScope,
      from: { kind: 'agent', catId: current.predecessorCatId },
      content: 'owned action source',
      timestamp: 100,
      mentions: current.holderCatIds,
      deliveryStatus: 'queued',
    },
    {
      threadId: current.holderThreadId,
      userId: current.tenantScope,
      from: { kind: 'agent', catId: current.predecessorCatId },
      content: 'owned action source',
      kind: 'message_wake',
      targetCats: current.holderCatIds,
      intent: 'execute',
      ownerAuthProvenance: 'strict',
      sourceCategory: 'a2a',
      actionSuccessorFence: fence,
    },
  );
  const executions = new Map();
  if (status !== 'pending') {
    for (const holder of current.holderCatIds) {
      executions.set(
        holder,
        recordHolderExecution({ current, admitted, messages, records, turns }, holder, status, legacyKey),
      );
    }
  }
  if (status !== 'pending') {
    const claimId = 'canonical-delivery';
    assert.equal((await ledger.claim(current.holderThreadId, admitted.entry.id, claimId, 103)).outcome, 'claimed');
    assert.equal(
      (
        await ledger.commit(
          current.holderThreadId,
          admitted.entry.id,
          claimId,
          'processing',
          104,
          undefined,
          current.holderCatIds,
        )
      ).outcome,
      'updated',
    );
    await queue.hydrateFromLedger(messages);
    assert.deepEqual(await queue.listAllDurable(current.holderThreadId), []);
  }
  const resolve = (changes = {}, admissionChanges = {}) =>
    resolveDirectActionSuccessorCarrier({
      lease: current,
      admissionInput: request(current, {
        action: {
          ...request(current).action,
          ...(current.parallelIntent ? { parallelIntent: current.parallelIntent } : {}),
        },
        ...admissionChanges,
      }),
      invocationQueue: queue,
      messageStore: messages,
      invocationRecordStore: records,
      turnExecutionStore: turns,
      ...changes,
    });
  return { current, fence, ledger, queue, messages, records, turns, admitted, executions, resolve };
}

export const unavailable = (reason) => ({ disposition: 'unavailable', reason });
export const refreshed = (f) => ({ disposition: 'refresh_handled', fence: f.fence });
