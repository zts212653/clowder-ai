import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';

import { buildActionSuccessorFence } from '../dist/domains/ball-custody/ActionSuccessorAdmissionContract.js';
import { canonicalizeActionTerminalPredicate } from '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { InMemoryTurnExecutionStore } from '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';
import { canonicalActionFixture } from './helpers/canonical-action-history-fixtures.js';

const action = {
  subjectRef: 'subject:task:task-4058',
  actionFamily: 'implement',
  successorSlot: 'implementer',
  mode: 'single',
  terminalPredicate: { kind: 'task_done' },
};

function carrierLease(sourceThreadId, targetThreadId) {
  return {
    leaseId: 'lease-review-4058',
    key: 'user-1|subject:task:task-4058|implement|implementer',
    tenantScope: 'user-1',
    subjectRef: action.subjectRef,
    actionFamily: action.actionFamily,
    successorSlot: action.successorSlot,
    mode: action.mode,
    holderCatIds: ['codex'],
    dispatchId: 'cross-post:review-4058-original',
    claimOrigin: 'structured_transfer',
    holderThreadId: targetThreadId,
    predecessorCatId: 'opus',
    predecessorThreadId: sourceThreadId,
    issuerStandingEvidenceRef: 'callback:old-invocation:review-4058-original',
    generation: 1,
    status: 'active',
    holderOutcomes: {},
    completionCandidates: {},
    terminalPredicateState: { kind: 'predicate_backed' },
    terminalPredicate: canonicalizeActionTerminalPredicate({
      actionFamily: action.actionFamily,
      subjectRef: action.subjectRef,
      predicate: action.terminalPredicate,
    }),
    evidenceRefs: ['callback:old-invocation:review-4058-original'],
    returnTransitions: [],
    revision: 1,
    createdAt: 100,
    updatedAt: 100,
  };
}

async function appendCarrier(messageStore, invocationQueue, lease, state, stores) {
  if (state === 'interrupted') {
    const f = await canonicalActionFixture({ status: 'interrupted', leaseChanges: lease, stores });
    return f.admitted.message;
  }
  const fence = buildActionSuccessorFence(lease, lease.dispatchId);
  const from = { kind: 'agent', catId: lease.predecessorCatId };
  const message = await messageStore.append({
    threadId: lease.holderThreadId,
    userId: lease.tenantScope,
    from,
    content: 'Original exact-HEAD review carrier',
    mentions: ['codex'],
    origin: 'callback',
    timestamp: 100,
    deliveryStatus: 'queued',
  });
  const admitted = await invocationQueue.enqueueExistingMessageDurable(messageStore, message.id, {
    threadId: lease.holderThreadId,
    userId: lease.tenantScope,
    from,
    kind: 'conversation_input',
    ownerAuthProvenance: 'strict',
    content: message.content,
    messageId: message.id,
    targetCats: ['codex'],
    intent: 'execute',
    autoExecute: true,
    sourceCategory: 'a2a',
    actionSuccessorFence: fence,
  });
  if (state === 'interrupted') {
    const terminalized = await invocationQueue.terminalizeEntryDurable(
      lease.holderThreadId,
      lease.tenantScope,
      admitted.entry.id,
      'interrupted',
      'runtime_restart',
    );
    assert.ok(terminalized);
    assert.equal(invocationQueue.list(lease.holderThreadId, lease.tenantScope).length, 0);
  }
  return message;
}

describe('direct action carrier restart recovery', () => {
  let app;
  let messageStore;
  let invocationQueue;
  let source;
  let target;
  let auth;
  let lease;
  let unavailable;
  let registry;
  let stores;

  beforeEach(async () => {
    app = Fastify();
    messageStore = new MessageStore();
    const ledger = new InMemoryQueueLedgerStore();
    invocationQueue = new InvocationQueue(ledger);
    stores = {
      ledger,
      queue: invocationQueue,
      messages: messageStore,
      records: new InvocationRecordStore(),
      turns: new InMemoryTurnExecutionStore(),
    };
    const threadStore = new ThreadStore();
    registry = new InvocationRegistry();
    source = await threadStore.create('user-1', 'Author');
    target = await threadStore.create('user-1', 'Reviewer');
    auth = await registry.create('user-1', 'opus', source.id);
    stores.turns.createRunning({
      invocationId: auth.invocationId,
      parentInvocationId: auth.invocationId,
      threadId: source.id,
      userId: 'user-1',
      catId: 'opus',
      executionKind: 'ordinary',
      startedAt: Date.now(),
    });
    lease = carrierLease(source.id, target.id);
    unavailable = [];

    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      threadStore,
      invocationQueue,
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
      router: { async *routeExecution() {}, getExecutions: () => [] },
      invocationRecordStore: stores.records,
      turnExecutionStore: stores.turns,
      queueProcessor: {
        async requestDrain() {},
        async tryAutoExecute() {},
      },
      actionSuccessorAdmissionService: {
        async admit() {
          return { admit: false, outcome: 'safe_wait', lease };
        },
        async markUnavailable(input) {
          unavailable.push(input);
        },
      },
    });
  });

  afterEach(async () => {
    await app.close();
  });

  function post(clientMessageId) {
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: {
        threadId: target.id,
        content: 'Review exact HEAD',
        targetCats: ['codex'],
        clientMessageId,
        action,
      },
    });
  }

  test('keeps safe_wait when exact durable custody is live', async () => {
    await appendCarrier(messageStore, invocationQueue, lease, 'live');
    const response = await post('review-4058-live-reentry');

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'safe_wait');
    assert.equal(invocationQueue.list(target.id, 'user-1').length, 1);
  });

  test('re-establishes exact active-generation custody after runtime interruption', async () => {
    await appendCarrier(messageStore, invocationQueue, lease, 'interrupted', stores);
    const response = await post('review-4058-recover-interrupted');

    assert.equal(response.statusCode, 200, response.body);
    const [recovered] = invocationQueue.list(target.id, 'user-1');
    assert.ok(recovered, 'the exact active generation must regain a durable pending carrier');
    assert.deepEqual(recovered.execution.actionSuccessorFence, buildActionSuccessorFence(lease, lease.dispatchId));
    assert.deepEqual(unavailable, []);
  });

  test('same-client retry observes an atomically admitted replacement carrier', async () => {
    await appendCarrier(messageStore, invocationQueue, lease, 'interrupted', stores);
    const clientMessageId = 'review-4058-crash-after-append';
    const fence = buildActionSuccessorFence(lease, lease.dispatchId);
    const replacement = await invocationQueue.send(
      messageStore,
      {
        threadId: target.id,
        userId: 'user-1',
        from: { kind: 'agent', catId: 'opus' },
        content: 'Review exact HEAD',
        mentions: ['codex'],
        origin: 'callback',
        timestamp: 130,
        deliveryStatus: 'queued',
        idempotencyKey: `action-carrier-recovery:${lease.leaseId}:${lease.generation}`,
      },
      {
        threadId: target.id,
        userId: 'user-1',
        from: { kind: 'agent', catId: 'opus' },
        kind: 'message_wake',
        ownerAuthProvenance: 'strict',
        content: 'Review exact HEAD',
        targetCats: ['codex'],
        intent: 'execute',
        autoExecute: true,
        sourceCategory: 'a2a',
        actionSuccessorFence: fence,
      },
    );
    assert.equal(await registry.claimClientMessageId(auth.invocationId, clientMessageId), true);

    const response = await post(clientMessageId);

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'safe_wait');
    const [queued] = invocationQueue.list(target.id, 'user-1');
    assert.equal(queued.payload.messageId, replacement.message.id);
    assert.deepEqual(queued.execution.actionSuccessorFence, fence);
  });

  describe('a replacement carrier whose delivery fails is restored by retrying the same clientMessageId', () => {
    const recoveryKey = () => `action-carrier-recovery:${lease.leaseId}:${lease.generation}`;
    const replacement = () => messageStore.getByIdempotencyKey('user-1', target.id, recoveryKey());

    test('consecutive atomic failures publish no replacement, and the first healthy retry admits exactly one entry', async () => {
      await appendCarrier(messageStore, invocationQueue, lease, 'interrupted', stores);
      const healthyAdmission = invocationQueue.send.bind(invocationQueue);
      let failedAdmissions = 0;
      invocationQueue.send = () => {
        failedAdmissions++;
        throw new Error('admission store unavailable');
      };

      const first = await post('review-4058-retry');
      const second = await post('review-4058-retry');

      assert.equal(first.statusCode, 500, first.body);
      assert.equal(second.statusCode, 500, 'a rejected atomic request is never an accepted duplicate');
      assert.equal(failedAdmissions, 2, 'both retries must actually reach the failed atomic dependency');
      assert.equal(replacement(), null, 'failed atomic admission must publish neither source nor pending work');
      assert.equal(invocationQueue.list(target.id, 'user-1').length, 0);

      invocationQueue.send = healthyAdmission;
      const third = await post('review-4058-retry');
      assert.equal(third.statusCode, 200, third.body);
      const queued = invocationQueue.list(target.id, 'user-1');
      assert.equal(queued.length, 1);
      assert.equal(queued[0].payload.messageId, replacement().id);

      const again = await post('review-4058-retry');
      assert.equal(again.statusCode, 200, again.body);
      assert.equal(invocationQueue.list(target.id, 'user-1').length, 1, 'and exactly one');
    });

    test('a failure BEFORE durable admission is not promised to startup reconciliation', async () => {
      await appendCarrier(messageStore, invocationQueue, lease, 'interrupted', stores);
      let attempts = 0;
      invocationQueue.send = () => {
        attempts++;
        throw new Error('admission write unavailable');
      };

      const response = await post('review-4058-no-admission');

      assert.equal(response.statusCode, 500, response.body);
      assert.equal(attempts, 1);
      assert.equal(replacement(), null);
      assert.equal(invocationQueue.list(target.id, 'user-1').length, 0);
      assert.doesNotMatch(response.body, /startup|recovery_pending/);
    });
    test('lost atomic commit receipt replays the existing carrier without a second admission', async () => {
      await appendCarrier(messageStore, invocationQueue, lease, 'interrupted', stores);
      const healthyAdmission = invocationQueue.send.bind(invocationQueue);
      let commits = 0;
      invocationQueue.send = async (...args) => {
        commits++;
        await healthyAdmission(...args);
        throw new Error('commit receipt lost');
      };
      const first = await post('review-4058-lost-receipt');
      assert.equal(first.statusCode, 500);
      const committedId = replacement().id;
      const again = await post('review-4058-lost-receipt');
      assert.equal(again.statusCode, 200, again.body);
      assert.equal(commits, 1);
      assert.equal(replacement().id, committedId);
      assert.equal(invocationQueue.list(target.id, 'user-1').length, 1);
    });
  });
});
