/**
 * Fixtures for direct action-successor carrier tests: a lease, the request that exercises its exact
 * authority, a carrier message in a given receipt state bound to the lease's exact fence, and the
 * InvocationRecord a carrier key produces. Shared so every test builds the same evidence.
 */
import { buildActionSuccessorFence } from '../../dist/domains/ball-custody/ActionSuccessorAdmissionContract.js';
import { canonicalizeActionTerminalPredicate } from '../../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js';

export const terminalPredicate = canonicalizeActionTerminalPredicate({
  actionFamily: 'implement',
  subjectRef: 'subject:task:task-4058',
  predicate: { kind: 'task_done' },
});

export function lease(overrides = {}) {
  return {
    leaseId: 'lease-4058',
    key: 'user-1|subject:task:task-4058|implement|implementer',
    tenantScope: 'user-1',
    subjectRef: 'subject:task:task-4058',
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: ['codex-sol'],
    dispatchId: 'post:original-dispatch',
    claimOrigin: 'structured_transfer',
    holderThreadId: 'thread-holder',
    predecessorCatId: 'codex-astra',
    predecessorThreadId: 'thread-holder',
    issuerStandingEvidenceRef: 'callback:old-invocation:original-dispatch',
    generation: 1,
    status: 'active',
    holderOutcomes: {},
    completionCandidates: {},
    terminalPredicateState: { kind: 'predicate_backed' },
    terminalPredicate,
    evidenceRefs: ['callback:old-invocation:original-dispatch'],
    returnTransitions: [],
    revision: 7,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

export function request(current, overrides = {}) {
  return {
    tenantScope: current.tenantScope,
    actorCatId: current.predecessorCatId,
    sourceThreadId: current.predecessorThreadId,
    targetThreadId: current.holderThreadId,
    holderCatIds: [...current.holderCatIds],
    dispatchId: 'post:refresh-dispatch',
    evidenceRef: 'callback:new-invocation:refresh-dispatch',
    now: 300,
    action: {
      subjectRef: current.subjectRef,
      actionFamily: 'implement',
      successorSlot: 'implementer',
      mode: current.mode,
      terminalPredicate: { kind: 'task_done' },
    },
    ...overrides,
  };
}

/**
 * The child (turn-execution) invocation that consumed a carrier. Custody names THIS id on the handled
 * attempt and in the target outcome; it is not the InvocationRecord id, whose parent it belongs to.
 */
export function childInvocationId(catId) {
  return `child-${catId}`;
}

export function attemptFor(catId, state) {
  const attemptState = { failed: 'failed', handled: 'handled', queued: 'queued' }[state] ?? 'cancelled';
  const terminalReason = { failed: 'invocation_failed', withdrawn: 'source_withdrawn' }[state];
  return {
    id: `entry-${catId}:${catId}:1`,
    targetCatId: catId,
    sequence: 1,
    state: attemptState,
    ...(terminalReason ? { terminalReason } : {}),
    ...(state === 'handled' ? { invocationId: childInvocationId(catId) } : {}),
    createdAt: 100,
    updatedAt: 120,
  };
}

/** A carrier message for one target in the given receipt state, bound to the lease's exact fence. */
export function carrier(current, catId, state) {
  const fence = buildActionSuccessorFence(current, current.dispatchId);
  const live = state === 'queued';
  const handled = state === 'handled';
  const withdrawn = state === 'withdrawn';
  const failed = state === 'failed';
  return {
    id: `message-${catId}-${state}`,
    threadId: current.holderThreadId,
    userId: current.tenantScope,
    catId: current.predecessorCatId,
    content: 'Implement task',
    mentions: [catId],
    timestamp: 100,
    deliveryStatus: live ? 'queued' : 'delivered',
    queueCustody: {
      version: 1,
      entryId: `entry-${catId}`,
      revision: 2,
      intent: 'execute',
      status: live ? 'queued' : 'terminal',
      allTargetCats: [catId],
      pendingTargetCats: live ? [catId] : [],
      notifiedByCatIds: live ? [catId] : [],
      seenByCatIds: [],
      seenInvocationIdByCatId: {},
      failedByCatIds: failed ? [catId] : [],
      ...(withdrawn ? { withdrawnByCatIds: [catId], withdrawnAtByCatId: { [catId]: 120 } } : {}),
      handledByCatIds: handled ? [catId] : [],
      carrierByTargetCatId: {
        [catId]: {
          entryId: `entry-${catId}`,
          idempotencyKey: `action:${fence.leaseId}:${fence.generation}:${catId}`,
          actionSuccessorFence: fence,
          source: 'agent',
          sourceCategory: 'a2a',
          callerCatId: current.predecessorCatId,
          a2aTriggerMessageId: `message-${catId}-${state}`,
          autoExecute: true,
          createdAt: 100,
        },
      },
      ...(live ? { carrierStateByTargetCatId: { [catId]: { status: 'queued' } } } : {}),
      targetAttempts: [attemptFor(catId, state)],
      priority: 'normal',
      createdAt: 100,
      updatedAt: 120,
    },
  };
}

export function oldInvocationKey(current, catId) {
  return `action-successor:action:${current.leaseId}:${current.generation}:${catId}`;
}

export function record(current, catId, overrides = {}) {
  return {
    id: `invocation-${catId}`,
    threadId: current.holderThreadId,
    userId: current.tenantScope,
    userMessageId: null,
    targetCats: [catId],
    intent: 'execute',
    status: 'succeeded',
    successfulCatIds: [catId],
    idempotencyKey: oldInvocationKey(current, catId),
    createdAt: 100,
    updatedAt: 150,
    ...overrides,
  };
}

/**
 * `records` is the key index (what `getByIdempotencyKey` finds); `byId` is the persistent record by id.
 * `calls` keeps the key lookups, `idCalls` the id reads, `log` the order of both.
 */
export function recordStore(
  records,
  { throws = false, rejects = false, byId = new Map(), idThrows = false, idRejects = false } = {},
) {
  const calls = [];
  const idCalls = [];
  const log = [];
  return {
    calls,
    idCalls,
    log,
    getByIdempotencyKey(threadId, userId, key) {
      calls.push({ threadId, userId, key });
      log.push('key');
      if (throws) throw new Error('record store unavailable');
      if (rejects) return Promise.reject(new Error('record store unavailable'));
      return records.get(key) ?? null;
    },
    get(id) {
      idCalls.push(id);
      log.push('id');
      if (idThrows) throw new Error('record store unavailable');
      if (idRejects) return Promise.reject(new Error('record store unavailable'));
      return byId.get(id) ?? null;
    },
  };
}

/** The durable child ledger entry for the run that consumed a carrier: child id -> its parent record. */
export function child(current, catId, overrides = {}) {
  return {
    invocationId: childInvocationId(catId),
    parentInvocationId: `invocation-${catId}`,
    threadId: current.holderThreadId,
    userId: current.tenantScope,
    catId,
    executionKind: 'ordinary',
    startedAt: 110,
    status: 'succeeded',
    endedAt: 140,
    ...overrides,
  };
}

/** A fake child ledger. `calls` records every id read. */
export function turnStore(children, { throws = false, rejects = false } = {}) {
  const byId = new Map(children.map((value) => [value.invocationId, value]));
  const calls = [];
  return {
    calls,
    get(id) {
      calls.push(id);
      if (throws) throw new Error('turn ledger unavailable');
      if (rejects) return Promise.reject(new Error('turn ledger unavailable'));
      return byId.get(id) ?? null;
    },
  };
}
