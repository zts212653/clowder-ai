import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APPROVED_DELEGATE,
  CHILD_CAT,
  CHILD_THREAD,
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
} from './f167-delegate-test-helpers.js';

const SUCCESSOR_CAT = 'codex61-sol';

const { ActionSuccessorAdmissionService } = await import(
  '../dist/domains/ball-custody/ActionSuccessorAdmissionService.js'
);
const { ActionSubjectTruthResolver } = await import('../dist/domains/ball-custody/ActionSubjectTruthResolver.js');
const { ProposalStoreDelegateProvider, ThreadDelegateBindingProvider } = await import(
  '../dist/domains/ball-custody/ProposalStoreDelegateProvider.js'
);
const { canonicalizeActionTerminalPredicate } = await import(
  '../dist/domains/ball-custody/ActionTerminalPredicateCatalog.js'
);
const {
  claimActionSuccessor,
  recordActionSuccessorOutcome,
  replaceActionSuccessor,
  returnActionSuccessorToPredecessor,
} = await import('../dist/domains/ball-custody/action-successor-state-machine.js');

function initialLease() {
  const predicate = canonicalizeActionTerminalPredicate({
    actionFamily: 'implement',
    subjectRef: SUBJECT_REF,
    predicate: { kind: 'task_done' },
  });
  return claimActionSuccessor(null, {
    leaseId: 'lease-task414',
    tenantScope: TENANT,
    subjectRef: SUBJECT_REF,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: [CHILD_CAT],
    holderThreadId: CHILD_THREAD,
    predecessorCatId: OWNER_CAT,
    predecessorThreadId: OWNER_THREAD,
    dispatchId: 'dispatch:initial-delegate',
    claimOrigin: 'structured_transfer',
    issuerStandingEvidenceRef: 'message:initial-delegate',
    evidenceRefs: [APPROVED_DELEGATE.evidenceRef],
    terminalPredicate: predicate,
    now: 100,
  }).lease;
}

function returnedLease() {
  return returnActionSuccessorToPredecessor(initialLease(), {
    expectedGeneration: 1,
    rejectingCatId: CHILD_CAT,
    rejectingThreadId: CHILD_THREAD,
    dispatchId: 'dispatch:delegate-return',
    groundingEvidenceRef: 'message:delegate-release',
    now: 200,
  }).lease;
}

function successorLease() {
  const returned = returnedLease();
  const reattached = replaceActionSuccessor(returned, {
    expectedGeneration: returned.generation,
    holderCatIds: [SUCCESSOR_CAT],
    holderThreadId: CHILD_THREAD,
    predecessorCatId: OWNER_CAT,
    predecessorThreadId: OWNER_THREAD,
    dispatchId: 'dispatch:first-successor',
    terminalPredicate: returned.terminalPredicate,
    evidenceRef: 'message:first-successor-handoff',
    freshnessEvidenceRef: 'task:task-f322:active:2',
    delegateEvidenceRef: APPROVED_DELEGATE.evidenceRef,
    returnedHolderCatId: OWNER_CAT,
    returnedHolderThreadId: OWNER_THREAD,
    returnProof: { kind: 'returned_fence', leaseId: returned.leaseId, generation: returned.generation },
    now: 300,
  });
  assert.equal(reattached.outcome, 'reattached');
  return reattached.lease;
}

function successorReturnedLease() {
  const successor = successorLease();
  return returnActionSuccessorToPredecessor(successor, {
    expectedGeneration: successor.generation,
    rejectingCatId: SUCCESSOR_CAT,
    rejectingThreadId: CHILD_THREAD,
    dispatchId: 'dispatch:first-successor-return',
    groundingEvidenceRef: 'message:first-successor-release',
    now: 400,
  }).lease;
}

function terminalSuccessorLease(outcome) {
  const successor = successorLease();
  return recordActionSuccessorOutcome(successor, {
    generation: successor.generation,
    catId: SUCCESSOR_CAT,
    outcome,
    evidenceRef: `queue:first-successor:${outcome}`,
    now: 400,
  });
}

function fixture({
  task = makeTask(),
  proposal = makeProposal(),
  targetThreadId = CHILD_THREAD,
  currentLease = returnedLease(),
} = {}) {
  let lease = currentLease;
  const leaseStore = {
    async get(id) {
      return id === lease.leaseId ? lease : null;
    },
    async replace(id, input) {
      assert.equal(id, lease.leaseId);
      const result = replaceActionSuccessor(lease, input);
      if (result.outcome === 'replaced' || result.outcome === 'reattached') lease = result.lease;
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
      throw new Error('unexpected delivery');
    },
    async continueFreshRevision() {
      throw new Error('unexpected continuation');
    },
  };
  const delegateProvider = new ProposalStoreDelegateProvider(
    makeProposalStore(proposal),
    new ThreadDelegateBindingProvider(makeProposalLister([makeProposalListItem()])),
  );
  const resolver = new ActionSubjectTruthResolver(
    mockTruthLeaseStore(),
    {
      async get(id) {
        return id === task.id ? task : null;
      },
    },
    delegateProvider,
  );
  const service = new ActionSuccessorAdmissionService(leaseStore, resolver);
  return {
    service,
    request: {
      tenantScope: TENANT,
      actorCatId: OWNER_CAT,
      sourceThreadId: OWNER_THREAD,
      targetThreadId,
      holderCatIds: [SUCCESSOR_CAT],
      dispatchId: 'dispatch:successor-delegate',
      evidenceRef: 'message:successor-handoff',
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
  };
}

test('Task414 shape: exact owner reattaches a new delegate to the same approved child after return', async () => {
  const f = fixture();
  const result = await f.service.admit(f.request);
  assert.equal(result.admit, true);
  assert.equal(result.outcome, 'reattached');
  assert.deepEqual(result.lease.holderCatIds, [SUCCESSOR_CAT]);
  assert.equal(result.lease.holderThreadId, CHILD_THREAD);
  assert.equal(result.lease.generation, 3);
  assert.ok(result.lease.evidenceRefs.includes(APPROVED_DELEGATE.evidenceRef));
  assert.ok(result.lease.evidenceRefs.includes('message:successor-handoff'));
});

test('returned delegation cannot move the successor to an unapproved child', async () => {
  const f = fixture({ targetThreadId: 'thread-unapproved-child' });
  await assert.rejects(f.service.admit(f.request), /standing|approved|child/i);
  assert.equal(f.current().generation, 2);
  assert.deepEqual(f.current().holderCatIds, [OWNER_CAT]);
});

test('scope drift keeps returned delegation fail-closed', async () => {
  const f = fixture({ task: makeTask({ developmentScope: { ...DEV_SCOPE, acceptedRevision: 'b'.repeat(40) } }) });
  await assert.rejects(f.service.admit(f.request), /standing|approved|scope/i);
  assert.equal(f.current().generation, 2);
});

test('owner or tenant drift keeps returned delegation fail-closed', async () => {
  const ownerDrift = fixture({ task: makeTask({ ownerCatId: 'different-owner' }) });
  await assert.rejects(ownerDrift.service.admit(ownerDrift.request), /standing|owner/i);
  assert.equal(ownerDrift.current().generation, 2);

  const tenantDrift = fixture();
  tenantDrift.request.tenantScope = 'different-tenant';
  await assert.rejects(tenantDrift.service.admit(tenantDrift.request), /standing|tenant|identity/i);
  assert.equal(tenantDrift.current().generation, 2);
});

test('an active original delegate cannot be replaced through the returned-successor exception', async () => {
  const f = fixture({ currentLease: initialLease() });
  f.request.incomingActionLeaseRef = { leaseId: f.current().leaseId, generation: f.current().generation };
  f.request.action.replace = { leaseId: f.current().leaseId, expectedGeneration: f.current().generation };
  await assert.rejects(f.service.admit(f.request), /standing|replacement|proof/i);
  assert.equal(f.current().generation, 1);
  assert.deepEqual(f.current().holderCatIds, [CHILD_CAT]);
});

test('two concurrent same-child successor attempts commit exactly one generation', async () => {
  const f = fixture();
  const attempts = await Promise.all([
    f.service.admit(f.request),
    f.service.admit({
      ...f.request,
      holderCatIds: ['kimi'],
      dispatchId: 'dispatch:competing-successor',
      evidenceRef: 'message:competing-successor-handoff',
    }),
  ]);

  assert.equal(attempts.filter((result) => result.admit).length, 1);
  assert.equal(attempts.filter((result) => result.outcome === 'stale_generation').length, 1);
  assert.equal(f.current().generation, 3);
  assert.equal(f.current().holderCatIds.length, 1);
  assert.ok([SUCCESSOR_CAT, 'kimi'].includes(f.current().holderCatIds[0]));
});

test('a later successor can return without making the initial preferredCats a permanent veto', async () => {
  const f = fixture({ currentLease: successorReturnedLease() });
  f.request.holderCatIds = ['kimi'];
  f.request.dispatchId = 'dispatch:second-successor';
  f.request.evidenceRef = 'message:second-successor-handoff';
  f.request.now = 500;

  const result = await f.service.admit(f.request);
  assert.equal(result.admit, true);
  assert.equal(result.outcome, 'reattached');
  assert.equal(result.lease.generation, 5);
  assert.deepEqual(result.lease.holderCatIds, ['kimi']);
  assert.equal(result.lease.returnTransitions.length, 2);
  assert.ok(result.lease.evidenceRefs.includes(APPROVED_DELEGATE.evidenceRef));
});

for (const outcome of ['failed', 'canceled', 'unavailable']) {
  test(`a ${outcome} lineage successor can be replaced in the same approved child`, async () => {
    for (const nextHolder of [SUCCESSOR_CAT, 'kimi']) {
      const f = fixture({ currentLease: terminalSuccessorLease(outcome) });
      f.request.holderCatIds = [nextHolder];
      f.request.dispatchId = `dispatch:after-${outcome}:${nextHolder}`;
      f.request.evidenceRef = `message:after-${outcome}:${nextHolder}`;
      f.request.incomingActionLeaseRef = undefined;
      f.request.now = 500;

      const result = await f.service.admit(f.request);
      assert.equal(result.admit, true);
      assert.equal(result.outcome, 'replaced');
      assert.equal(result.lease.generation, 4);
      assert.deepEqual(result.lease.holderCatIds, [nextHolder]);
      assert.ok(result.lease.evidenceRefs.includes(APPROVED_DELEGATE.evidenceRef));
      const transition = result.lease.replacementTransitions.at(-1);
      assert.equal(transition?.reason, 'holder_terminal');
      assert.ok(transition?.evidenceRefs.includes('task:task-f322:active:100'));
      assert.ok(transition?.evidenceRefs.includes(APPROVED_DELEGATE.evidenceRef));
    }
  });
}

test('a retired read-interruption hint cannot replace an active lineage successor', async () => {
  const f = fixture({ currentLease: successorLease() });
  f.request.holderCatIds = ['kimi'];
  f.request.dispatchId = 'dispatch:after-interrupted-read';
  f.request.evidenceRef = 'message:after-interrupted-read';
  f.request.incomingActionLeaseRef = undefined;
  f.request.now = 500;

  await assert.rejects(f.service.admit(f.request), /standing|replacement|proof/i);
  assert.equal(f.current().generation, 3);

  f.request.interruptedGenerationEvidence = {
    leaseId: f.current().leaseId,
    generation: f.current().generation,
    evidenceRef: `carrier-interrupted-after-read:${f.current().leaseId}:g${f.current().generation}:${SUCCESSOR_CAT}@${CHILD_THREAD}`,
  };
  await assert.rejects(f.service.admit(f.request), /standing|replacement|proof/i);
  assert.equal(f.current().generation, 3);
  assert.deepEqual(f.current().holderCatIds, [SUCCESSOR_CAT]);
});
