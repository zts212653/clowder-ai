/**
 * Fixtures for direct action-successor carrier tests: a lease, the request that exercises its exact
 * authority, immutable lease scope and its historical invocation key.
 * Canonical delivery/execution records are built by canonical-action-history-fixtures.
 */
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

export function oldInvocationKey(current, catId) {
  return `action-successor:action:${current.leaseId}:${current.generation}:${catId}`;
}
