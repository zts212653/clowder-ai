import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildActionSuccessorFence } from '../dist/domains/ball-custody/ActionSuccessorAdmissionContract.js';
import { canonicalizeActionTerminalPredicate } from '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';
import {
  classifyDirectActionSuccessorCarrier,
  isExactDirectActionSuccessorReentry,
  resolveDirectActionSuccessorCarrier,
} from '../dist/domains/ball-custody/DirectActionSuccessorCarrierRecovery.js';
import { reconcileActionSuccessorEnqueue } from '../dist/domains/ball-custody/reconcile-action-successor-enqueue.js';

const terminalPredicate = canonicalizeActionTerminalPredicate({
  actionFamily: 'review',
  subjectRef: 'pr:owner/repo#4058',
  predicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
});

function lease(overrides = {}) {
  return {
    leaseId: 'lease-review-4058',
    key: 'user-1|pr:owner/repo#4058|review|reviewer',
    tenantScope: 'user-1',
    subjectRef: 'pr:owner/repo#4058',
    actionFamily: 'review',
    successorSlot: 'reviewer',
    mode: 'single',
    holderCatIds: ['opus5'],
    dispatchId: 'cross-post:review-4058-old',
    claimOrigin: 'structured_transfer',
    holderThreadId: 'thread-review',
    predecessorCatId: 'codex-sol',
    predecessorThreadId: 'thread-author',
    issuerStandingEvidenceRef: 'callback:old-invocation:review-4058-old',
    generation: 1,
    status: 'active',
    holderOutcomes: {},
    completionCandidates: {},
    terminalPredicateState: { kind: 'predicate_backed' },
    terminalPredicate,
    evidenceRefs: ['callback:old-invocation:review-4058-old'],
    returnTransitions: [],
    revision: 1,
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

function request(overrides = {}) {
  return {
    tenantScope: 'user-1',
    actorCatId: 'codex-sol',
    sourceThreadId: 'thread-author',
    targetThreadId: 'thread-review',
    holderCatIds: ['opus5'],
    dispatchId: 'cross-post:review-4058-reentry',
    evidenceRef: 'callback:new-invocation:review-4058-reentry',
    now: 200,
    action: {
      subjectRef: 'pr:owner/repo#4058',
      actionFamily: 'review',
      successorSlot: 'reviewer',
      mode: 'single',
      terminalPredicate: { kind: 'review_delivered', headSha: 'a'.repeat(40) },
    },
    ...overrides,
  };
}

function messageForTarget(targetCatId, state, overrides = {}) {
  const currentLease = overrides.lease ?? lease({ holderCatIds: [targetCatId] });
  const fence = overrides.fence ?? buildActionSuccessorFence(currentLease, currentLease.dispatchId);
  const interrupted = state === 'interrupted';
  const handled = state === 'handled';
  const withdrawn = state === 'withdrawn';
  const failed = state === 'failed';
  const live = ['queued', 'notified', 'awakened', 'seen', 'steering'].includes(state);
  return {
    id: overrides.id ?? `message-${targetCatId}-${state}`,
    threadId: currentLease.holderThreadId,
    userId: currentLease.tenantScope,
    catId: currentLease.predecessorCatId,
    content: 'Review exact HEAD',
    mentions: [targetCatId],
    timestamp: 100,
    deliveryStatus: live ? 'queued' : 'delivered',
    queueCustody: {
      version: 1,
      entryId: `entry-${targetCatId}`,
      revision: 2,
      intent: 'review',
      status: live ? 'queued' : 'terminal',
      allTargetCats: [targetCatId],
      pendingTargetCats: live ? [targetCatId] : [],
      notifiedByCatIds: ['notified', 'awakened', 'seen', 'steering'].includes(state) ? [targetCatId] : [],
      ...(state === 'awakened' || state === 'seen' || state === 'steering'
        ? { awakenedInvocationIdByCatId: { [targetCatId]: `invocation-${targetCatId}` } }
        : {}),
      ...(state === 'awakened' || state === 'seen' || state === 'steering'
        ? { awakenedAtByCatId: { [targetCatId]: 110 } }
        : {}),
      seenByCatIds: state === 'seen' || state === 'steering' ? [targetCatId] : [],
      seenInvocationIdByCatId:
        state === 'seen' || state === 'steering' ? { [targetCatId]: `invocation-${targetCatId}` } : {},
      ...(state === 'steering' ? { steeredInvocationIdByCatId: { [targetCatId]: `invocation-${targetCatId}` } } : {}),
      failedByCatIds: interrupted || failed ? [targetCatId] : [],
      ...(withdrawn ? { withdrawnByCatIds: [targetCatId], withdrawnAtByCatId: { [targetCatId]: 120 } } : {}),
      handledByCatIds: handled ? [targetCatId] : [],
      carrierByTargetCatId: {
        [targetCatId]: {
          entryId: `entry-${targetCatId}`,
          idempotencyKey: `action:${fence.leaseId}:${fence.generation}:${targetCatId}`,
          actionSuccessorFence: fence,
          source: 'agent',
          sourceCategory: 'a2a',
          callerCatId: currentLease.predecessorCatId,
          a2aTriggerMessageId: overrides.id ?? `message-${targetCatId}-${state}`,
          autoExecute: true,
          createdAt: 100,
        },
      },
      ...(live ? { carrierStateByTargetCatId: { [targetCatId]: { status: 'queued' } } } : {}),
      targetAttempts: [
        {
          id: `entry-${targetCatId}:${targetCatId}:1`,
          targetCatId,
          sequence: 1,
          state: interrupted ? 'interrupted' : failed ? 'failed' : handled ? 'handled' : live ? 'queued' : 'cancelled',
          ...(interrupted ? { terminalReason: 'runtime_restart', invocationId: `invocation-${targetCatId}` } : {}),
          ...(failed ? { terminalReason: 'invocation_failed' } : {}),
          ...(withdrawn ? { terminalReason: 'source_withdrawn' } : {}),
          ...(handled ? { invocationId: `invocation-${targetCatId}` } : {}),
          createdAt: 100,
          updatedAt: 120,
        },
      ],
      priority: 'normal',
      createdAt: 100,
      updatedAt: 120,
    },
  };
}

describe('direct action successor carrier recovery', () => {
  test('keeps safe_wait only when every exact-fence holder has live durable custody', () => {
    const current = lease();
    for (const state of ['queued', 'notified', 'awakened', 'seen', 'steering']) {
      assert.deepEqual(classifyDirectActionSuccessorCarrier(current, [messageForTarget('opus5', state)]), {
        disposition: 'live',
        fence: buildActionSuccessorFence(current, current.dispatchId),
      });
    }
  });

  test('recognizes a complete pre-CAS admission as live durable custody', () => {
    const current = lease();
    const fence = buildActionSuccessorFence(current, current.dispatchId);
    const admission = {
      id: 'message-admission',
      threadId: current.holderThreadId,
      userId: current.tenantScope,
      catId: current.predecessorCatId,
      content: 'Review exact HEAD',
      mentions: ['opus5'],
      timestamp: 100,
      deliveryStatus: 'queued',
      queueCustodyAdmission: {
        version: 1,
        admissionId: 'admission-review',
        ownerUserId: current.tenantScope,
        ownerAuthProvenance: 'strict',
        intent: 'review',
        targetCats: ['opus5'],
        requestedTargetCats: ['opus5'],
        actionSuccessorFence: fence,
        priority: 'normal',
        createdAt: 100,
      },
    };

    assert.deepEqual(classifyDirectActionSuccessorCarrier(current, [admission]), {
      disposition: 'live',
      fence,
    });
  });

  test('recovers only when every exact holder carrier was interrupted by runtime restart', () => {
    const current = lease();
    assert.deepEqual(classifyDirectActionSuccessorCarrier(current, [messageForTarget('opus5', 'interrupted')]), {
      disposition: 'restart_interrupted',
      fence: buildActionSuccessorFence(current, current.dispatchId),
    });
  });

  test('fails closed for missing, terminal, failed, mixed, or wrong-fence custody', () => {
    const single = lease();
    assert.equal(classifyDirectActionSuccessorCarrier(single, []).disposition, 'unavailable');
    for (const state of ['handled', 'withdrawn', 'failed']) {
      assert.equal(
        classifyDirectActionSuccessorCarrier(single, [messageForTarget('opus5', state)]).disposition,
        'unavailable',
      );
    }

    const parallel = lease({ mode: 'parallel', holderCatIds: ['opus5', 'kimi'], parallelIntent: 'independent review' });
    assert.equal(
      classifyDirectActionSuccessorCarrier(parallel, [
        messageForTarget('opus5', 'interrupted', { lease: parallel }),
        messageForTarget('kimi', 'queued', { lease: parallel }),
      ]).disposition,
      'unavailable',
    );
    assert.equal(
      classifyDirectActionSuccessorCarrier(single, [
        messageForTarget('opus5', 'interrupted', {
          fence: { ...buildActionSuccessorFence(single, single.dispatchId), generation: 2 },
        }),
      ]).disposition,
      'unavailable',
    );
  });

  test('requires exact request authority before reusing an interrupted fence', () => {
    const current = lease();
    assert.equal(isExactDirectActionSuccessorReentry(current, request()), true);
    assert.equal(isExactDirectActionSuccessorReentry(current, request({ actorCatId: 'opus' })), false);
    assert.equal(isExactDirectActionSuccessorReentry(current, request({ targetThreadId: 'thread-other' })), false);
    assert.equal(isExactDirectActionSuccessorReentry(current, request({ holderCatIds: ['kimi'] })), false);
    assert.equal(
      isExactDirectActionSuccessorReentry(
        current,
        request({
          action: {
            ...request().action,
            terminalPredicate: { kind: 'review_delivered', headSha: 'b'.repeat(40) },
          },
        }),
      ),
      false,
    );
  });

  test('turns custody lookup failure into an explicit fail-closed decision', async () => {
    const decision = await resolveDirectActionSuccessorCarrier({
      lease: lease(),
      admissionInput: request(),
      messageStore: {
        async getByThreadAfter() {
          throw new Error('store unavailable');
        },
      },
    });
    assert.deepEqual(decision, { disposition: 'unavailable', reason: 'lookup_failed' });
  });

  test('does not settle an existing generation unavailable when replacement enqueue must retry', async () => {
    const unavailable = [];
    const current = lease();
    await reconcileActionSuccessorEnqueue({
      service: {
        async markUnavailable(input) {
          unavailable.push(input);
        },
        async markReturnedDelivered() {},
      },
      fence: buildActionSuccessorFence(current, current.dispatchId),
      disposition: 'successor_dispatch',
      admissionOutcome: 'replayed',
      unavailableCatIds: ['opus5'],
      now: 300,
    });
    assert.deepEqual(unavailable, []);
  });
});
