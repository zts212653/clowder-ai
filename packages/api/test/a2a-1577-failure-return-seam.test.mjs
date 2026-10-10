import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { InMemoryQueueLedgerStore } from '../src/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { commitFailedResponseAndEnqueueA2ACaller } from '../src/routes/callback-a2a-trigger.ts';

// Real production failed-response ingress, MessageStore transaction and Queue.
// A legacy availability resolver is a spy only; ordinary failure return must not consult it.
function fixture({ rejected = false } = {}) {
  const ledger = new InMemoryQueueLedgerStore();
  const drains = [];
  const queue = new InvocationQueue(ledger, {
    onAdmitted: ({ threadId }) => {
      drains.push(threadId);
    },
  });
  const messages = new MessageStore();
  const business = [];
  const receipts = [];
  const checks = [];
  const source = messages.append({
    userId: 'failure-owner',
    threadId: 'failure-thread',
    from: { kind: 'agent', catId: 'opus' },
    content: '',
    mentions: [],
    timestamp: 100,
    lifecycle: {
      kind: 'response',
      orderKey: 'failed-response-order',
      invocationId: 'failed-child',
      targetId: 'opus',
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'processing',
      startedAt: 100,
    },
  });
  const deps = {
    messageStore: messages,
    invocationQueue: queue,
    routingDispatchPreflight: {
      preflight: async (input) => {
        checks.push(input);
        return {
          v: 1,
          ownerId: input.ownerId,
          observedAt: 110,
          resolverState: 'ready',
          targets: input.targetCatIds.map((targetCatId) => ({
            targetCatId,
            disposition: rejected ? 'rejected' : 'accepted',
            reasons: [],
            alternatives: [],
          })),
        };
      },
    },
    queueProcessor: {
      requestDrain: async (threadId) => drains.push(threadId),
      registerCallerDispatchInitialTargets: (...args) => business.push(args),
    },
    socketManager: { emitToUser() {}, broadcastAgentMessage: (...args) => receipts.push(args) },
    log: { info() {}, warn() {}, error() {} },
  };
  const opts = {
    responseMessageId: source.id,
    invocationId: 'failed-child',
    terminal: { status: 'failed', completedAt: 200, reason: 'provider_failed' },
    message: {
      userId: source.userId,
      threadId: source.threadId,
      from: source.from,
      content: 'isolated failed provider result',
      mentions: [],
      timestamp: 100,
    },
    userId: source.userId,
    threadId: source.threadId,
    ownerAuthProvenance: 'strict',
    reporterCatId: 'opus',
    predecessorCatId: 'codex',
    parentInvocationId: 'failed-parent',
  };
  return { ledger, queue, messages, source, opts, deps, drains, business, receipts, checks };
}

test('failed response and exact predecessor queue reference commit together, without a new reporter business edge', async () => {
  const f = fixture();
  const result = await commitFailedResponseAndEnqueueA2ACaller(f.deps, f.opts);
  assert.equal(result.id, f.source.id);
  assert.equal(result.lifecycle.status, 'failed');
  assert.equal(f.messages.getByThread(f.source.threadId).length, 1);
  const [row] = await f.queue.listAllDurable(f.source.threadId);
  assert.equal(row.sourceCategory, 'a2a_failure');
  assert.deepEqual(row.targets, ['codex']);
  assert.equal(row.payload.messageId, f.source.id);
  assert.equal(row.payload.sourceRecordId, f.source.id);
  assert.equal(row.execution.a2aParentInvocationId, 'failed-parent');
  assert.equal(row.execution.a2aTriggerMessageId, f.source.id);
  assert.deepEqual(f.business, []);
  assert.equal(f.drains.length, 1);
  assert.deepEqual(f.checks, [], 'failure return does not consult global availability');
});

test('replaying the same failed result is idempotent; altered result cannot mutate the won identity', async () => {
  const f = fixture();
  await commitFailedResponseAndEnqueueA2ACaller(f.deps, f.opts);
  const before = await f.queue.listAllDurable(f.source.threadId);
  await commitFailedResponseAndEnqueueA2ACaller(f.deps, f.opts);
  assert.deepEqual(await f.queue.listAllDurable(f.source.threadId), before);
  await assert.rejects(
    commitFailedResponseAndEnqueueA2ACaller(f.deps, {
      ...f.opts,
      message: { ...f.opts.message, content: 'different terminal' },
    }),
    /conflict/,
  );
  assert.equal(f.messages.getById(f.source.id).content, f.opts.message.content);
  assert.deepEqual(f.business, []);
});

test('failed ledger commit cannot publish a terminal response, drain or reporter business dispatch', async () => {
  const f = fixture();
  f.ledger.enqueueNow = () => {
    throw new Error('owned ledger rejection');
  };
  await assert.rejects(commitFailedResponseAndEnqueueA2ACaller(f.deps, f.opts), /owned ledger rejection/);
  assert.equal(f.messages.getById(f.source.id).lifecycle.status, 'processing');
  assert.equal(f.messages.getById(f.source.id).content, '');
  assert.deepEqual(await f.queue.listAllDurable(f.source.threadId), []);
  assert.deepEqual(f.drains, []);
  assert.deepEqual(f.business, []);
});

test('legacy routing rejection cannot suppress the exact failed History and predecessor wake', async () => {
  const f = fixture({ rejected: true });
  const result = await commitFailedResponseAndEnqueueA2ACaller(f.deps, f.opts);
  assert.equal(result.lifecycle.status, 'failed');
  const [row] = await f.queue.listAllDurable(f.source.threadId);
  assert.equal(row.sourceCategory, 'a2a_failure');
  assert.deepEqual(row.targets, ['codex']);
  assert.equal(row.payload.messageId, f.source.id);
  assert.equal(f.receipts.length, 0);
  assert.deepEqual(f.checks, []);
  assert.deepEqual(f.drains, [f.source.threadId]);
  assert.deepEqual(f.business, []);
});

test('restart restores pending failure classification; consumed exact History prevents replay resurrection', async () => {
  const f = fixture();
  await commitFailedResponseAndEnqueueA2ACaller(f.deps, f.opts);
  const restored = new InvocationQueue(f.ledger);
  await restored.hydrateFromLedger(f.messages);
  const [row] = restored.list(f.source.threadId, f.source.userId);
  assert.equal(row.sourceCategory, 'a2a_failure');
  assert.ok(await restored.claimExactExposureDurable(f.source.threadId, f.source.userId, row.id, 'codex', f.source.id));
  const child = f.messages.append({
    userId: f.source.userId,
    threadId: f.source.threadId,
    from: { kind: 'agent', catId: 'codex' },
    content: 'consumed failure',
    mentions: [],
    timestamp: 210,
    lifecycle: {
      kind: 'response',
      orderKey: 'return-child-order',
      invocationId: 'return-child',
      targetId: 'codex',
      inputEntryIds: [row.id],
      inputMessageIds: [f.source.id],
      status: 'processing',
      startedAt: 210,
    },
  });
  assert.equal(
    f.messages.advanceLifecycleInputDispatch(f.source.id, {
      orderKey: f.source.lifecycle.orderKey,
      targetId: 'codex',
      phase: 'dispatched',
      statusMessageId: child.id,
      dispatchedAt: 210,
    }).kind,
    'applied',
  );
  assert.ok(
    await restored.commitClaimedAdoptionDurable(
      f.source.threadId,
      f.source.userId,
      row.id,
      'codex',
      'return-child',
      210,
    ),
  );
  const again = new InvocationQueue(f.ledger);
  await again.hydrateFromLedger(f.messages);
  await commitFailedResponseAndEnqueueA2ACaller({ ...f.deps, invocationQueue: again }, f.opts);
  assert.deepEqual(await again.listAllDurable(f.source.threadId), []);
  assert.equal(f.messages.getByThread(f.source.threadId).length, 2);
});
