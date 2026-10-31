import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildActionSuccessorFence } from '../src/domains/ball-custody/ActionSuccessorAdmissionContract.ts';
import {
  readCarrierAdmissionEvidence,
  resolveDirectActionSuccessorCarrier,
} from '../src/domains/ball-custody/DirectActionSuccessorCarrierRecovery.ts';
import { confirmHandledExecutionsEnded } from '../src/domains/ball-custody/DirectActionSuccessorExecutionEvidence.ts';
import {
  actionSuccessorInvocationKeyForTarget,
  InvocationQueue,
} from '../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { InMemoryQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.ts';
import { InMemoryTurnExecutionStore } from '../src/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.ts';
import { InvocationRecordStore } from '../src/domains/cats/services/stores/ports/InvocationRecordStore.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import {
  actionCarrierRecoveryKey,
  carrierRecoveryPendingResponse,
  resolveSafeWaitCarrier,
} from '../src/routes/callback-action-carrier-resolution.ts';
import { lease, oldInvocationKey, request } from './helpers/direct-action-carrier-fixtures.js';

// Canonical in-memory production stores. No model, Redis, public shadow receipt or complete route claim.
function recordHolderExecution({ current, admitted, records, turns, messages }, holder, status, legacyKey) {
  const parent = records.create({
    threadId: current.holderThreadId,
    userId: current.tenantScope,
    targetCats: [holder],
    intent: 'execute',
    idempotencyKey: legacyKey
      ? oldInvocationKey(current, holder)
      : actionSuccessorInvocationKeyForTarget(admitted.message.id, holder),
    actionLeaseCarrier: { kind: 'action_successor', leaseId: current.leaseId, generation: current.generation },
  }).invocationId;
  records.update(parent, { status: 'running' });
  const childId = `isolated-child-${holder}`;
  turns.createRunning({
    invocationId: childId,
    parentInvocationId: parent,
    threadId: current.holderThreadId,
    userId: current.tenantScope,
    catId: holder,
    startedAt: 101,
    executionKind: 'ordinary',
    causal: { triggerMessageId: admitted.message.id },
  });
  if (status !== 'processing') {
    turns.transitionTerminal(childId, {
      status: status === 'completed' ? 'succeeded' : status,
      endedAt: 102,
      ...(status === 'completed' ? {} : { terminalReason: `isolated-${status}` }),
    });
    records.update(parent, {
      status: status === 'completed' ? 'succeeded' : status === 'interrupted' ? 'failed' : status,
      ...(status === 'completed' ? { successfulCatIds: [holder] } : {}),
    });
  }
  const response = messages.append({
    threadId: current.holderThreadId,
    userId: current.tenantScope,
    from: { kind: 'agent', catId: holder },
    content: 'actual response',
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
}
async function fixture(status = 'completed', options = {}) {
  const current = lease(options.lease);
  const fence = buildActionSuccessorFence(current, current.dispatchId);
  const ledger = new InMemoryQueueLedgerStore();
  const queue = new InvocationQueue(ledger);
  const messages = new MessageStore();
  const records = new InvocationRecordStore();
  const turns = new InMemoryTurnExecutionStore();
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
  for (const holder of current.holderCatIds)
    recordHolderExecution({ current, admitted, records, turns, messages }, holder, status, options.legacyKey);
  const resolve = (changes = {}) =>
    resolveDirectActionSuccessorCarrier({
      lease: current,
      admissionInput: request(current, {
        action: {
          ...request(current).action,
          ...(current.parallelIntent ? { parallelIntent: current.parallelIntent } : {}),
        },
      }),
      invocationQueue: queue,
      messageStore: messages,
      invocationRecordStore: records,
      turnExecutionStore: turns,
      ...changes,
    });
  return { current, fence, queue, ledger, messages, records, turns, admitted, resolve };
}

test('an idempotency-index hit cannot lend another tenant or action generation a successful run', async () => {
  const current = lease();
  const fence = buildActionSuccessorFence(current, current.dispatchId);
  for (const drift of [
    { userId: 'different-tenant' },
    { threadId: 'different-thread' },
    { idempotencyKey: 'ordinary-client-key' },
    { actionLeaseCarrier: { kind: 'none' } },
    { actionLeaseCarrier: { kind: 'action_successor', leaseId: current.leaseId, generation: 2 } },
  ]) {
    const parent = {
      id: 'parent',
      userId: current.tenantScope,
      threadId: current.holderThreadId,
      targetCats: current.holderCatIds,
      idempotencyKey: oldInvocationKey(current, 'codex-sol'),
      actionLeaseCarrier: { kind: 'action_successor', leaseId: current.leaseId, generation: current.generation },
      status: 'succeeded',
      successfulCatIds: ['codex-sol'],
      ...drift,
    };
    assert.deepEqual(
      await confirmHandledExecutionsEnded(
        current,
        fence,
        {
          recordStore: { getByIdempotencyKey: async () => parent, get: async () => parent },
          lineage: undefined,
        },
        new Map(),
      ),
      { disposition: 'unavailable', reason: 'execution_unconfirmed' },
      JSON.stringify(drift),
    );
  }
});

test('completed canonical History proves this generation after pending retirement and index expiry', async () => {
  const f = await fixture();
  f.records.getByIdempotencyKey = () => {
    throw new Error('expired index must not be needed');
  };
  assert.equal(
    (await f.ledger.claim(f.current.holderThreadId, f.admitted.entry.id, 'isolated-crash-claim', 103, 'codex-sol'))
      .outcome,
    'claimed',
  );
  await f.queue.hydrateFromLedger(f.messages);
  assert.deepEqual(await f.queue.listAllDurable(f.current.holderThreadId), []);
  assert.deepEqual(await f.resolve(), { disposition: 'refresh_handled', fence: f.fence });
  const source = f.messages.getById(f.admitted.message.id);
  assert.equal(source.queueCustody, undefined);
  assert.equal(source.queueCustodyAdmission, undefined);
});

test('legacy public execution key is read-only compatible only through exact canonical History', async () => {
  const f = await fixture('completed', { legacyKey: true });
  await f.queue.hydrateFromLedger(f.messages);
  assert.deepEqual(await f.resolve(), { disposition: 'refresh_handled', fence: f.fence });
});

for (const [status, expected] of [
  ['processing', 'live'],
  ['interrupted', 'restart_interrupted'],
  ['canceled', 'carrier_terminal'],
  ['failed', 'carrier_failed'],
])
  test(`canonical ${status} evidence is not borrowed as a fresh handled generation`, async () => {
    const f = await fixture(status);
    const decision = await f.resolve();
    assert.deepEqual(
      decision,
      ['live', 'restart_interrupted'].includes(expected)
        ? { disposition: expected, fence: f.fence }
        : { disposition: 'unavailable', reason: expected },
    );
  });

test('terminal History defeats a stale exact-fence pending cache and cannot be resurrected', async () => {
  const f = await fixture('canceled');
  assert.equal((await f.queue.listAllDurable(f.current.holderThreadId)).length, 1);
  assert.deepEqual(await f.resolve(), { disposition: 'unavailable', reason: 'carrier_terminal' });
});

test('parallel refresh requires actual success for every holder, without consuming any sibling', async () => {
  const f = await fixture('completed', {
    lease: { holderCatIds: ['codex-sol', 'opus'], mode: 'parallel', parallelIntent: 'independent work' },
  });
  const before = await f.queue.listAllDurable(f.current.holderThreadId);
  assert.deepEqual(await f.resolve(), { disposition: 'refresh_handled', fence: f.fence });
  assert.deepEqual(await f.queue.listAllDurable(f.current.holderThreadId), before);
  const missing = await f.resolve({
    turnExecutionStore: { get: (id) => (id.endsWith('opus') ? null : f.turns.get(id)) },
  });
  assert.notEqual(missing.disposition, 'refresh_handled');
});

test('a previous generation or ordinary invocation key cannot lend terminal History', async () => {
  const f = await fixture();
  await f.queue.hydrateFromLedger(f.messages);
  for (const drift of [
    { idempotencyKey: 'ordinary-client-key' },
    { actionLeaseCarrier: { kind: 'none' } },
    { actionLeaseCarrier: { kind: 'action_successor', leaseId: f.current.leaseId, generation: 2 } },
    { userId: 'other-owner' },
    { threadId: 'other-thread' },
    { targetCats: ['opus'] },
  ])
    assert.notEqual(
      (
        await f.resolve({
          invocationRecordStore: {
            get: (id) => ({ ...f.records.get(id), ...drift }),
            getByIdempotencyKey: () => null,
          },
        })
      ).disposition,
      'refresh_handled',
      JSON.stringify(drift),
    );
});

test('an unsettled successful target and a lookup failure retain distinct closed answers', async () => {
  const f = await fixture();
  await f.queue.hydrateFromLedger(f.messages);
  assert.deepEqual(
    await f.resolve({
      invocationRecordStore: {
        get: (id) => ({ ...f.records.get(id), successfulCatIds: [] }),
        getByIdempotencyKey: () => null,
      },
    }),
    { disposition: 'unavailable', reason: 'execution_unconfirmed' },
  );
  assert.deepEqual(
    await f.resolve({
      turnExecutionStore: {
        get: () => {
          throw new Error('unavailable');
        },
      },
    }),
    { disposition: 'unavailable', reason: 'lookup_failed' },
  );
});

test('canonical admission read-back scopes owner, generation and complete holder set', async () => {
  const f = await fixture();
  const scope = { threadId: f.current.holderThreadId, userId: f.current.tenantScope };
  assert.equal(
    await readCarrierAdmissionEvidence(f.queue, f.admitted.message.id, f.current.holderCatIds, f.fence, scope),
    'durable',
  );
  assert.equal(
    await readCarrierAdmissionEvidence(f.queue, f.admitted.message.id, ['opus'], f.fence, scope),
    'not_persisted',
  );
  assert.equal(
    await readCarrierAdmissionEvidence(f.queue, f.admitted.message.id, f.current.holderCatIds, f.fence, {
      ...scope,
      userId: 'other-owner',
    }),
    'not_persisted',
  );
  assert.equal(
    await readCarrierAdmissionEvidence(
      f.queue,
      f.admitted.message.id,
      f.current.holderCatIds,
      { ...f.fence, generation: 2 },
      scope,
    ),
    'not_persisted',
  );
  assert.equal(
    await readCarrierAdmissionEvidence(
      {
        getDurableEntriesForMessages: () => {
          throw new Error('unavailable');
        },
      },
      f.admitted.message.id,
      f.current.holderCatIds,
      f.fence,
      scope,
    ),
    'unverified',
  );
});

for (const status of ['canceled', 'failed'])
  test(`safe_wait ${status} never calls the refresh transaction`, async () => {
    const f = await fixture(status);
    const result = await resolveSafeWaitCarrier({
      invocationQueue: f.queue,
      messageStore: f.messages,
      invocationRecordStore: f.records,
      turnExecutionStore: f.turns,
      lease: f.current,
      admissionInput: request(f.current),
      clientMessageId: 'client',
      leaseStore: {
        refreshHandledCarrier: () => {
          throw new Error('must not refresh');
        },
        getSubjectTerminal: () => null,
      },
    });
    assert.equal(result.kind, 'respond');
    assert.equal(result.statusCode, 409);
    assert.equal(result.body.reason, status === 'canceled' ? 'carrier_terminal' : 'carrier_failed');
  });

test('safe_wait handles interruption on the old fence and refreshes success only through the exact CAS', async () => {
  const interrupted = await fixture('interrupted');
  const input = (f) => ({
    invocationQueue: f.queue,
    messageStore: f.messages,
    invocationRecordStore: f.records,
    turnExecutionStore: f.turns,
    lease: f.current,
    admissionInput: request(f.current),
    clientMessageId: 'client',
    leaseStore: undefined,
  });
  assert.deepEqual(await resolveSafeWaitCarrier(input(interrupted)), {
    kind: 'continue',
    admissionOutcome: 'replayed',
    fence: interrupted.fence,
    recoveryKey: actionCarrierRecoveryKey(interrupted.fence),
  });
  const completed = await fixture();
  assert.equal((await resolveSafeWaitCarrier(input(completed))).body.reason, 'carrier_terminal');
  let commits = 0;
  const result = await resolveSafeWaitCarrier({
    ...input(completed),
    leaseStore: {
      refreshHandledCarrier: (id, value) => {
        commits++;
        assert.equal(id, completed.current.leaseId);
        assert.equal(value.expectedGeneration, completed.current.generation);
        assert.equal(value.expectedRevision, completed.current.revision);
        assert.equal(value.predecessorCatId, completed.current.predecessorCatId);
        assert.equal(value.terminalPredicateDigest, completed.current.terminalPredicate.digest);
        return {
          outcome: 'refreshed',
          lease: { ...completed.current, generation: 2, revision: 8, dispatchId: value.dispatchId },
        };
      },
      getSubjectTerminal: () => null,
    },
  });
  assert.equal(commits, 1);
  assert.equal(result.kind, 'continue');
  assert.equal(result.admissionOutcome, 'refreshed');
  assert.equal(result.fence.generation, 2);
  assert.equal(result.recoveryKey, 'action-carrier-recovery:lease-4058:2');
});

test('missing evidence refuses rather than silently creating a same-generation carrier', async () => {
  const f = await fixture();
  const result = await resolveSafeWaitCarrier({
    invocationQueue: { listAllDurable: async () => [] },
    messageStore: { getByThreadAfter: async () => [], getById: async () => null },
    invocationRecordStore: f.records,
    turnExecutionStore: f.turns,
    leaseStore: undefined,
    lease: f.current,
    admissionInput: request(f.current),
    clientMessageId: 'client',
  });
  assert.equal(result.kind, 'respond');
  assert.equal(result.body.reason, 'carrier_missing');
});

test('recovery response distinguishes persisted Queue admission from unavailable storage', async () => {
  const f = await fixture();
  const input = {
    invocationQueue: f.queue,
    threadId: f.current.holderThreadId,
    userId: f.current.tenantScope,
    messageId: f.admitted.message.id,
    holderCatIds: f.current.holderCatIds,
    fence: f.fence,
    clientMessageId: 'client',
  };
  assert.equal((await carrierRecoveryPendingResponse(input)).body.kind, 'action_carrier_recovery_pending');
  const result = await carrierRecoveryPendingResponse({
    ...input,
    invocationQueue: {
      getDurableEntriesForMessages: () => {
        throw new Error('unavailable');
      },
    },
  });
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.admission, 'unverified');
  assert.equal(result.body.kind, 'action_carrier_retry_required');
});

test('a proven interrupted source cannot schedule again while its exact replacement remains pending', async () => {
  const f = await fixture('interrupted');
  await f.queue.send(
    f.messages,
    {
      threadId: f.current.holderThreadId,
      userId: f.current.tenantScope,
      from: { kind: 'agent', catId: f.current.predecessorCatId },
      content: 'replacement action source',
      timestamp: 105,
      mentions: f.current.holderCatIds,
      deliveryStatus: 'queued',
      idempotencyKey: actionCarrierRecoveryKey(f.fence),
    },
    {
      threadId: f.current.holderThreadId,
      userId: f.current.tenantScope,
      from: { kind: 'agent', catId: f.current.predecessorCatId },
      content: 'replacement action source',
      kind: 'message_wake',
      targetCats: f.current.holderCatIds,
      intent: 'execute',
      ownerAuthProvenance: 'strict',
      sourceCategory: 'a2a',
      actionSuccessorFence: f.fence,
    },
  );
  assert.deepEqual(await f.resolve(), { disposition: 'live', fence: f.fence });
});

test('a recovery reply reports exact History delivery after pending retirement without promising redelivery', async () => {
  for (const status of ['completed', 'processing', 'canceled', 'failed', 'interrupted']) {
    const f = await fixture(status);
    await f.ledger.claim(f.current.holderThreadId, f.admitted.entry.id, 'delivery-claim', 103, 'codex-sol');
    await f.queue.hydrateFromLedger(f.messages);
    const before = await f.queue.listAllDurable(f.current.holderThreadId);
    const result = await carrierRecoveryPendingResponse({
      invocationQueue: f.queue,
      messageStore: f.messages,
      invocationRecordStore: f.records,
      turnExecutionStore: f.turns,
      threadId: f.current.holderThreadId,
      userId: f.current.tenantScope,
      messageId: f.admitted.message.id,
      holderCatIds: f.current.holderCatIds,
      fence: f.fence,
      clientMessageId: 'client',
    });
    assert.equal(result.statusCode, 200, status);
    assert.equal(result.body.kind, 'action_carrier_delivery_committed', status);
    assert.equal(
      result.body.executions['codex-sol'],
      status === 'completed' ? 'handled' : status === 'processing' ? 'live' : status,
    );
    assert.deepEqual(await f.queue.listAllDurable(f.current.holderThreadId), before);
  }
});

test('a recovery reply cannot borrow a different generation, tenant, source or child as committed delivery', async () => {
  const f = await fixture();
  const input = {
    invocationQueue: f.queue,
    messageStore: f.messages,
    invocationRecordStore: f.records,
    turnExecutionStore: f.turns,
    threadId: f.current.holderThreadId,
    userId: f.current.tenantScope,
    messageId: f.admitted.message.id,
    holderCatIds: f.current.holderCatIds,
    fence: f.fence,
    clientMessageId: 'client',
  };
  for (const drift of [
    { fence: { ...f.fence, generation: 2 } },
    { userId: 'different-tenant' },
    { holderCatIds: ['opus'] },
    {
      invocationRecordStore: {
        get: (id) => ({ ...f.records.get(id), idempotencyKey: 'ordinary' }),
        getByIdempotencyKey: () => null,
      },
    },
    { turnExecutionStore: { get: (id) => ({ ...f.turns.get(id), causal: { triggerMessageId: 'unrelated' } }) } },
    {
      messageStore: {
        getById: () => {
          throw new Error('History unavailable');
        },
      },
    },
  ]) {
    const result = await carrierRecoveryPendingResponse({ ...input, ...drift });
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.admission, 'unverified');
    assert.notEqual(result.body.kind, 'action_carrier_delivery_committed');
  }
});
