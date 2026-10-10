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

function ledgerEntryForTargets(targets, overrides = {}) {
  const currentLease = overrides.lease ?? lease({ holderCatIds: targets });
  const fence = overrides.fence ?? buildActionSuccessorFence(currentLease, currentLease.dispatchId);
  const sourceRecordId = overrides.id ?? `message-${targets.join('-')}`;
  return {
    version: 2,
    id: overrides.id ?? `entry-${targets.join('-')}`,
    threadId: currentLease.holderThreadId,
    owner: { kind: 'user', userId: currentLease.tenantScope },
    kind: 'conversation_input',
    from: { kind: 'agent', catId: currentLease.predecessorCatId },
    targets,
    payload: {
      sourceRecordId,
      content: 'Review exact HEAD',
      messageId: sourceRecordId,
    },
    execution: { intent: 'review', ownerAuthProvenance: 'strict', autoExecute: true, actionSuccessorFence: fence },
    delivery: {},
    status: 'queued',
    enqueuedAt: 100,
    priority: 'normal',
    sourceCategory: 'a2a',
  };
}

describe('direct action successor carrier recovery', () => {
  test('keeps safe_wait only when every exact-fence holder remains pending in Queue', () => {
    const current = lease();
    assert.deepEqual(classifyDirectActionSuccessorCarrier(current, [ledgerEntryForTargets(['opus5'])]), {
      disposition: 'live',
      fence: buildActionSuccessorFence(current, current.dispatchId),
    });
  });

  test('recognizes a complete pre-CAS admission as live durable custody', () => {
    const current = lease();
    const fence = buildActionSuccessorFence(current, current.dispatchId);
    const admission = ledgerEntryForTargets(['opus5'], { id: 'message-admission', fence });

    assert.deepEqual(classifyDirectActionSuccessorCarrier(current, [admission]), {
      disposition: 'live',
      fence,
    });
  });

  test('fails closed for missing, partially delivered, or wrong-fence custody', () => {
    const single = lease();
    assert.equal(classifyDirectActionSuccessorCarrier(single, []).disposition, 'unavailable');

    const parallel = lease({ mode: 'parallel', holderCatIds: ['opus5', 'kimi'], parallelIntent: 'independent review' });
    assert.equal(
      classifyDirectActionSuccessorCarrier(parallel, [ledgerEntryForTargets(['kimi'], { lease: parallel })])
        .disposition,
      'unavailable',
    );
    assert.equal(
      classifyDirectActionSuccessorCarrier(single, [
        ledgerEntryForTargets(['opus5'], {
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
      invocationQueue: {
        async listAllDurable() {
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
