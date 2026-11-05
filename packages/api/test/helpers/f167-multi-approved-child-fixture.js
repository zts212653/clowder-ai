/**
 * Architecture cell: ball-custody
 * Map delta: none — this fixture exercises the existing ActionSuccessor lease and proposal authority owners.
 */
import assert from 'node:assert/strict';
import {
  DEV_SCOPE,
  makeProposal,
  makeProposalLister,
  makeProposalListItem,
  makeProposalStore,
  makeTask,
  mockTruthLeaseStore,
  OWNER_CAT,
  OWNER_THREAD,
  SUBJECT_REF,
  TENANT,
} from '../f167-delegate-test-helpers.js';

const { ActionSuccessorAdmissionService } = await import(
  '../../dist/domains/ball-custody/ActionSuccessorAdmissionService.js'
);
const { ActionSubjectTruthResolver } = await import('../../dist/domains/ball-custody/ActionSubjectTruthResolver.js');
const { ProposalStoreDelegateProvider, ThreadDelegateBindingProvider } = await import(
  '../../dist/domains/ball-custody/ProposalStoreDelegateProvider.js'
);
const { canonicalizeActionTerminalPredicate } = await import(
  '../../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js'
);
const {
  claimActionSuccessor,
  recordActionSuccessorOutcome,
  replaceActionSuccessor,
  returnActionSuccessorToPredecessor,
} = await import('../../dist/domains/ball-custody/action-successor-state-machine.js');
const { carrierRefreshEvidenceRef, refreshHandledActionSuccessor } = await import(
  '../../dist/domains/ball-custody/action-successor-refresh-state-machine.js'
);

export { carrierRefreshEvidenceRef, OWNER_CAT };
export const OLD_CAT = 'sonnet';
export const OLD_CHILD = 'thread-old-approved-child';
export const OLD_PROPOSAL = 'proposal-old-approved-child';
export const NEW_CAT = 'codex61-sol';
export const NEW_CHILD = 'thread-new-approved-child';
export const NEW_PROPOSAL = 'proposal-new-approved-child';

export function delegateEvidence(proposalId, childThreadId, catId) {
  return `proposal:${proposalId}:approved:thread:${childThreadId}:cat:${catId}`;
}

function returnedLease({
  returningCatId = OLD_CAT,
  refreshBeforeReturn = false,
  replaceAfterRefresh = false,
  refreshCount,
} = {}) {
  const terminalPredicate = canonicalizeActionTerminalPredicate({
    actionFamily: 'implement',
    subjectRef: SUBJECT_REF,
    predicate: { kind: 'task_done' },
  });
  let current = claimActionSuccessor(null, {
    leaseId: 'lease-multi-approved-child',
    tenantScope: TENANT,
    subjectRef: SUBJECT_REF,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: [returningCatId],
    holderThreadId: OLD_CHILD,
    predecessorCatId: OWNER_CAT,
    predecessorThreadId: OWNER_THREAD,
    dispatchId: 'cross-post:old-approved-child',
    claimOrigin: 'structured_transfer',
    issuerStandingEvidenceRef: 'message:old-approved-child',
    evidenceRefs: [delegateEvidence(OLD_PROPOSAL, OLD_CHILD, OLD_CAT)],
    terminalPredicate,
    now: 100,
  }).lease;
  const totalRefreshes =
    refreshCount === undefined ? Math.max(Number(refreshBeforeReturn), Number(replaceAfterRefresh)) : refreshCount;
  for (let index = 0; index < totalRefreshes; index += 1) {
    const refreshed = refreshHandledActionSuccessor(current, {
      expectedGeneration: current.generation,
      expectedRevision: current.revision,
      predecessorCatId: OWNER_CAT,
      predecessorThreadId: OWNER_THREAD,
      holderCatIds: current.holderCatIds,
      holderThreadId: current.holderThreadId,
      mode: 'single',
      terminalPredicateDigest: terminalPredicate.digest,
      dispatchId: `cross-post:old-approved-child-refresh-${index + 1}`,
      evidenceRef: `message:old-approved-child-refresh-${index + 1}`,
      now: 150 + index,
    });
    assert.equal(refreshed.outcome, 'refreshed');
    current = refreshed.lease;
  }
  if (replaceAfterRefresh) {
    current = recordActionSuccessorOutcome(current, {
      generation: current.generation,
      catId: returningCatId,
      outcome: 'failed',
      evidenceRef: 'queue:old-approved-child-terminal',
      now: 160,
    });
    const replaced = replaceActionSuccessor(current, {
      expectedGeneration: current.generation,
      holderCatIds: [returningCatId],
      holderThreadId: OLD_CHILD,
      dispatchId: 'cross-post:old-approved-child-replacement',
      terminalPredicate,
      evidenceRef: 'message:old-approved-child-replacement',
      freshnessEvidenceRef: 'task:old-approved-child-current',
      delegateEvidenceRef: delegateEvidence(OLD_PROPOSAL, OLD_CHILD, OLD_CAT),
      claimOrigin: 'structured_transfer',
      predecessorCatId: OWNER_CAT,
      predecessorThreadId: OWNER_THREAD,
      issuerStandingEvidenceRef: 'message:old-approved-child-replacement',
      now: 170,
    });
    assert.equal(replaced.outcome, 'replaced');
    current = replaced.lease;
  }
  return returnActionSuccessorToPredecessor(current, {
    expectedGeneration: current.generation,
    rejectingCatId: returningCatId,
    rejectingThreadId: OLD_CHILD,
    dispatchId: 'cross-post:old-approved-child-return',
    groundingEvidenceRef: 'message:old-approved-child-return',
    now: 200,
  }).lease;
}

export function fixture({
  targetCatId = NEW_CAT,
  targetThreadId = NEW_CHILD,
  oldProposalStatus = 'approved',
  returningCatId = OLD_CAT,
  refreshBeforeReturn = false,
  replaceAfterRefresh = false,
  refreshCount,
} = {}) {
  const task = makeTask({ threadId: OWNER_THREAD, developmentScope: DEV_SCOPE });
  const proposals = [
    makeProposal({
      proposalId: OLD_PROPOSAL,
      status: oldProposalStatus,
      createdThreadId: OLD_CHILD,
      preferredCats: [OLD_CAT],
    }),
    makeProposal({
      proposalId: NEW_PROPOSAL,
      createdThreadId: NEW_CHILD,
      preferredCats: [NEW_CAT],
    }),
  ];
  const proposalItems = [
    makeProposalListItem({
      proposalId: OLD_PROPOSAL,
      createdThreadId: OLD_CHILD,
      sourceCatId: OWNER_CAT,
      subjectTaskId: task.id,
    }),
    makeProposalListItem({
      proposalId: NEW_PROPOSAL,
      createdThreadId: NEW_CHILD,
      sourceCatId: OWNER_CAT,
      subjectTaskId: task.id,
    }),
  ];
  let lease = returnedLease({ returningCatId, refreshBeforeReturn, replaceAfterRefresh, refreshCount });
  const leaseStore = {
    async get(id) {
      return id === lease.leaseId ? lease : null;
    },
    async replace(id, input) {
      assert.equal(id, lease.leaseId);
      const result = replaceActionSuccessor(lease, input);
      if (['reattached', 'replaced'].includes(result.outcome)) lease = result.lease;
      return result;
    },
    async claim() {
      throw new Error('unexpected claim');
    },
    async commitOutcome() {
      throw new Error('unexpected outcome');
    },
    async returnToPredecessor() {
      throw new Error('unexpected return');
    },
    async markReturnDelivered() {
      throw new Error('unexpected return delivery');
    },
    async continueFreshRevision() {
      throw new Error('unexpected continuation');
    },
  };
  const delegateProvider = new ProposalStoreDelegateProvider(
    makeProposalStore(proposals),
    new ThreadDelegateBindingProvider(makeProposalLister(proposalItems)),
  );
  const truthResolver = new ActionSubjectTruthResolver(
    mockTruthLeaseStore(),
    { get: async (id) => (id === task.id ? task : null) },
    delegateProvider,
  );
  return {
    service: new ActionSuccessorAdmissionService(leaseStore, truthResolver),
    request: {
      tenantScope: TENANT,
      actorCatId: OWNER_CAT,
      sourceThreadId: OWNER_THREAD,
      targetThreadId,
      holderCatIds: [targetCatId],
      dispatchId: 'cross-post:new-approved-child',
      evidenceRef: 'message:new-approved-child',
      incomingActionLeaseRef: { leaseId: lease.leaseId, generation: lease.generation },
      now: 300,
      action: {
        subjectRef: SUBJECT_REF,
        actionFamily: 'implement',
        successorSlot: 'implementer',
        mode: 'single',
        claimOrigin: 'structured_transfer',
        replace: { leaseId: lease.leaseId, expectedGeneration: lease.generation },
        terminalPredicate: { kind: 'task_done' },
      },
    },
    current: () => lease,
    terminal(outcome = 'failed') {
      lease = recordActionSuccessorOutcome(lease, {
        generation: lease.generation,
        catId: lease.holderCatIds[0],
        outcome,
        evidenceRef: `queue:multi-child:${outcome}`,
        now: lease.updatedAt + 1,
      });
      return lease;
    },
    returnCurrent({ dispatchId = 'cross-post:new-approved-child-return', now = 400 } = {}) {
      lease = returnActionSuccessorToPredecessor(lease, {
        expectedGeneration: lease.generation,
        rejectingCatId: lease.holderCatIds[0],
        rejectingThreadId: lease.holderThreadId,
        dispatchId,
        groundingEvidenceRef: `message:${dispatchId}`,
        now,
      }).lease;
      return lease;
    },
  };
}

export function retargetCurrentGeneration(f, catId, threadId) {
  const lease = f.current();
  f.request.targetThreadId = threadId;
  f.request.holderCatIds = [catId];
  f.request.dispatchId = `dispatch:multi-child:${lease.generation}:${catId}`;
  f.request.evidenceRef = `message:multi-child:${lease.generation}:${catId}`;
  f.request.incomingActionLeaseRef = { leaseId: lease.leaseId, generation: lease.generation };
  f.request.action.replace = { leaseId: lease.leaseId, expectedGeneration: lease.generation };
  f.request.now = lease.updatedAt + 10;
}

export async function advanceAcrossChildSegments(f) {
  assert.equal((await f.service.admit(f.request)).outcome, 'reattached');
  f.terminal();
  retargetCurrentGeneration(f, OLD_CAT, OLD_CHILD);
  assert.equal((await f.service.admit(f.request)).outcome, 'replaced');

  f.returnCurrent({ now: f.current().updatedAt + 1 });
  retargetCurrentGeneration(f, NEW_CAT, NEW_CHILD);
  assert.equal((await f.service.admit(f.request)).outcome, 'reattached');

  f.returnCurrent({ now: f.current().updatedAt + 1 });
  retargetCurrentGeneration(f, 'kimi', NEW_CHILD);
  assert.equal((await f.service.admit(f.request)).outcome, 'reattached');
}
