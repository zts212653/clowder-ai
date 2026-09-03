import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';

import { buildActionSuccessorFence } from '../dist/domains/ball-custody/ActionSuccessorAdmissionContract.js';
import { canonicalizeActionTerminalPredicate } from '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';

const action = {
  subjectRef: 'pr:owner/repo#4058',
  actionFamily: 'review',
  successorSlot: 'reviewer',
  mode: 'single',
  terminalPredicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
};

function carrierLease(sourceThreadId, targetThreadId) {
  return {
    leaseId: 'lease-review-4058',
    key: 'user-1|pr:owner/repo#4058|review|reviewer',
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

function appendCarrier(messageStore, lease, state) {
  const fence = buildActionSuccessorFence(lease, lease.dispatchId);
  return messageStore.append({
    threadId: lease.holderThreadId,
    userId: lease.tenantScope,
    catId: lease.predecessorCatId,
    content: 'Original exact-HEAD review carrier',
    mentions: ['codex'],
    origin: 'callback',
    timestamp: 100,
    deliveryStatus: 'queued',
    queueCustody: {
      version: 1,
      entryId: 'entry-original-review',
      revision: 2,
      intent: 'execute',
      status: state === 'live' ? 'queued' : 'terminal',
      allTargetCats: ['codex'],
      pendingTargetCats: state === 'live' ? ['codex'] : [],
      notifiedByCatIds: state === 'live' ? ['codex'] : [],
      seenByCatIds: [],
      seenInvocationIdByCatId: {},
      failedByCatIds: state === 'interrupted' ? ['codex'] : [],
      handledByCatIds: [],
      carrierByTargetCatId: {
        codex: {
          entryId: 'entry-original-review',
          idempotencyKey: `action:${fence.leaseId}:${fence.generation}:codex`,
          actionSuccessorFence: fence,
          source: 'agent',
          sourceCategory: 'a2a',
          callerCatId: lease.predecessorCatId,
          a2aTriggerMessageId: 'message-original-review',
          autoExecute: true,
          createdAt: 100,
        },
      },
      ...(state === 'live' ? { carrierStateByTargetCatId: { codex: { status: 'queued' } } } : {}),
      targetAttempts: [
        {
          id: 'entry-original-review:codex:1',
          targetCatId: 'codex',
          sequence: 1,
          state: state === 'live' ? 'queued' : 'interrupted',
          ...(state === 'interrupted'
            ? { invocationId: 'invocation-interrupted', terminalReason: 'runtime_restart' }
            : {}),
          createdAt: 100,
          updatedAt: 120,
        },
      ],
      priority: 'normal',
      createdAt: 100,
      updatedAt: 120,
    },
  });
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

  beforeEach(async () => {
    app = Fastify();
    messageStore = new MessageStore();
    invocationQueue = new InvocationQueue();
    const threadStore = new ThreadStore();
    registry = new InvocationRegistry();
    source = await threadStore.create('user-1', 'Author');
    target = await threadStore.create('user-1', 'Reviewer');
    auth = await registry.create('user-1', 'opus', source.id);
    lease = carrierLease(source.id, target.id);
    unavailable = [];

    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      threadStore,
      invocationQueue,
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
      router: { async *routeExecution() {}, getExecutions: () => [] },
      invocationRecordStore: {
        create: () => ({ outcome: 'created', invocationId: 'child-invocation' }),
        update() {},
        get: () => null,
      },
      queueProcessor: { async tryAutoExecute() {} },
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
    appendCarrier(messageStore, lease, 'live');
    const response = await post('review-4058-live-reentry');

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'safe_wait');
    assert.equal(invocationQueue.list(target.id, 'user-1').length, 0);
  });

  test('reuses the original generation once after runtime interruption', async () => {
    appendCarrier(messageStore, lease, 'interrupted');
    const response = await post('review-4058-recover-interrupted');

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'ok');
    assert.deepEqual(response.json().actionLease, {
      leaseId: lease.leaseId,
      generation: lease.generation,
      outcome: 'replayed',
    });
    const [replacement] = invocationQueue.list(target.id, 'user-1');
    assert.deepEqual(replacement.actionSuccessorFence, buildActionSuccessorFence(lease, lease.dispatchId));
    assert.deepEqual(unavailable, []);

    const messageCount = messageStore.getByThreadIncludingQueued(target.id, 20, 'user-1').length;
    const laterReentry = await post('review-4058-after-recovery');
    assert.equal(laterReentry.json().status, 'safe_wait');
    assert.equal(messageStore.getByThreadIncludingQueued(target.id, 20, 'user-1').length, messageCount);
  });

  test('same-client retry finishes a crash after the replacement append', async () => {
    appendCarrier(messageStore, lease, 'interrupted');
    const clientMessageId = 'review-4058-crash-after-append';
    const replacement = messageStore.append({
      threadId: target.id,
      userId: 'user-1',
      catId: 'opus',
      content: 'Review exact HEAD',
      mentions: ['codex'],
      origin: 'callback',
      timestamp: 130,
      deliveryStatus: 'queued',
      idempotencyKey: `action-carrier-recovery:${lease.leaseId}:${lease.generation}`,
    });
    assert.equal(await registry.claimClientMessageId(auth.invocationId, clientMessageId), true);

    const response = await post(clientMessageId);

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().messageId, replacement.id);
    const [queued] = invocationQueue.list(target.id, 'user-1');
    assert.equal(queued.messageId, replacement.id);
    assert.deepEqual(queued.actionSuccessorFence, buildActionSuccessorFence(lease, lease.dispatchId));
  });

  test('503 names startup reconciliation instead of promising same-client retry delivery', async () => {
    appendCarrier(messageStore, lease, 'interrupted');
    messageStore.initializeQueueCustody = async () => {
      throw new Error('simulated crash after durable admission');
    };

    const response = await post('review-4058-admitted-uncommitted');

    assert.equal(response.statusCode, 503);
    assert.deepEqual(response.json(), {
      kind: 'action_carrier_recovery_pending',
      message:
        'The replacement carrier has durable Queue admission, but delivery is not committed. Runtime startup reconciliation is required to restore Queue delivery; retrying this clientMessageId only confirms the admission.',
      messageId: response.json().messageId,
      clientMessageId: 'review-4058-admitted-uncommitted',
    });
  });
});
