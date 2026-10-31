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
const HUMAN_SOURCE_REVISION = `sha256:${'d'.repeat(64)}`;

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
const { claimActionSuccessor, recordActionSuccessorOutcome, replaceActionSuccessor } = await import(
  '../dist/domains/ball-custody/action-successor-state-machine.js'
);
const { resolveTaskExecutionBinding } = await import('../dist/domains/growing/EntrustedWorkTaskExecutionBinding.js');

function initialLease({ terminal = true } = {}) {
  const terminalPredicate = canonicalizeActionTerminalPredicate({
    actionFamily: 'implement',
    subjectRef: SUBJECT_REF,
    predicate: { kind: 'task_done' },
  });
  const claimed = claimActionSuccessor(null, {
    leaseId: 'lease-initial-human-reassignment',
    tenantScope: TENANT,
    subjectRef: SUBJECT_REF,
    actionFamily: 'implement',
    successorSlot: 'implementer',
    mode: 'single',
    holderCatIds: [CHILD_CAT],
    holderThreadId: CHILD_THREAD,
    predecessorCatId: OWNER_CAT,
    predecessorThreadId: OWNER_THREAD,
    dispatchId: 'dispatch:initial-human-reassignment',
    claimOrigin: 'structured_transfer',
    issuerStandingEvidenceRef: 'message:initial-human-reassignment',
    evidenceRefs: [APPROVED_DELEGATE.evidenceRef],
    terminalPredicate,
    now: 100,
  }).lease;
  return terminal
    ? recordActionSuccessorOutcome(claimed, {
        generation: 1,
        catId: CHILD_CAT,
        outcome: 'unavailable',
        evidenceRef: 'queue:initial-delegate-terminal-without-execution',
        now: 180,
      })
    : claimed;
}

function humanProof(overrides = {}) {
  return {
    sourceMessageId: 'human-reassignment',
    sourceMessageRevision: HUMAN_SOURCE_REVISION,
    evidenceRef: `human-reassignment:message:human-reassignment:${HUMAN_SOURCE_REVISION}`,
    userId: TENANT,
    threadId: CHILD_THREAD,
    authoredAt: 200,
    ...overrides,
  };
}

function fixture({
  task = makeTask(),
  proposal = makeProposal(),
  currentLease = initialLease(),
  proof = humanProof(),
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
  const resolver = new ActionSubjectTruthResolver(
    mockTruthLeaseStore(),
    {
      async get(id) {
        return id === task.id ? task : null;
      },
    },
    new ProposalStoreDelegateProvider(
      makeProposalStore(proposal),
      new ThreadDelegateBindingProvider(makeProposalLister([makeProposalListItem()])),
    ),
  );
  const service = new ActionSuccessorAdmissionService(leaseStore, resolver);
  return {
    service,
    current: () => lease,
    request: {
      tenantScope: TENANT,
      actorCatId: OWNER_CAT,
      sourceThreadId: OWNER_THREAD,
      targetThreadId: CHILD_THREAD,
      holderCatIds: [SUCCESSOR_CAT],
      dispatchId: 'dispatch:human-reassigned-successor',
      evidenceRef: 'callback:owner-invocation:human-reassignment',
      humanReassignmentEvidence: proof,
      now: 300,
      action: {
        subjectRef: SUBJECT_REF,
        actionFamily: 'implement',
        successorSlot: 'implementer',
        mode: 'single',
        claimOrigin: 'structured_transfer',
        groundingEvidenceRef: 'message:human-reassignment',
        replace: { leaseId: lease.leaseId, expectedGeneration: lease.generation },
        terminalPredicate: { kind: 'task_done' },
      },
    },
  };
}

test('a direct human correction lets the Task owner replace terminal g1 inside the same approved child', async () => {
  const f = fixture();
  const result = await f.service.admit(f.request);

  assert.equal(result.admit, true);
  assert.equal(result.outcome, 'replaced');
  assert.equal(result.lease.generation, 2);
  assert.deepEqual(result.lease.holderCatIds, [SUCCESSOR_CAT]);
  assert.equal(result.lease.holderThreadId, CHILD_THREAD);
  assert.ok(result.lease.evidenceRefs.includes(APPROVED_DELEGATE.evidenceRef));
  assert.ok(result.lease.evidenceRefs.includes(f.request.humanReassignmentEvidence.evidenceRef));
  assert.ok(
    result.lease.replacementTransitions.at(-1)?.evidenceRefs.includes(f.request.humanReassignmentEvidence.evidenceRef),
  );
  const binding = await resolveTaskExecutionBinding(
    makeTask({ kind: 'work', entrustedWork: { developmentScope: DEV_SCOPE } }),
    result.lease,
    {
      async getForTask() {
        return [APPROVED_DELEGATE];
      },
    },
  );
  assert.deepEqual(binding, {
    kind: 'ready',
    binding: {
      leaseId: result.lease.leaseId,
      generation: 2,
      threadId: CHILD_THREAD,
      catId: SUCCESSOR_CAT,
    },
  });
});

for (const [name, mutate] of [
  ['missing proof', (f) => delete f.request.humanReassignmentEvidence],
  ['foreign-user proof', (f) => (f.request.humanReassignmentEvidence.userId = 'foreign-user')],
  ['wrong-child proof', (f) => (f.request.humanReassignmentEvidence.threadId = 'thread-other-child')],
  ['pre-lease proof', (f) => (f.request.humanReassignmentEvidence.authoredAt = 99)],
  ['mismatched proof ref', (f) => (f.request.action.groundingEvidenceRef = 'message:different-human')],
]) {
  test(`${name} cannot replace the initial approved delegate`, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(f.service.admit(f.request), /standing|approved|human|proof/i);
    assert.equal(f.current().generation, 1);
    assert.deepEqual(f.current().holderCatIds, [CHILD_CAT]);
  });
}

test('an active g1 cannot use the human-correction exception', async () => {
  const f = fixture({ currentLease: initialLease({ terminal: false }) });
  await assert.rejects(f.service.admit(f.request), /standing|replacement|proof/i);
  assert.equal(f.current().generation, 1);
});

test('a later terminal generation continues the same-child lineage without another human proof', async () => {
  const first = fixture();
  const reassigned = await first.service.admit(first.request);
  assert.equal(reassigned.admit, true);
  const terminalG2 = recordActionSuccessorOutcome(reassigned.lease, {
    generation: 2,
    catId: SUCCESSOR_CAT,
    outcome: 'failed',
    evidenceRef: 'queue:reassigned-generation-failed',
    now: 350,
  });
  const next = fixture({ currentLease: terminalG2 });
  next.request.holderCatIds = ['kimi'];
  next.request.action.groundingEvidenceRef = undefined;
  delete next.request.humanReassignmentEvidence;
  next.request.now = 400;

  const result = await next.service.admit(next.request);
  assert.equal(result.admit, true);
  assert.equal(result.outcome, 'replaced');
  assert.equal(result.lease.generation, 3);
  assert.deepEqual(result.lease.holderCatIds, ['kimi']);
});

test('Task, scope, tenant, proposal, and child fences remain current for initial human reassignment', async () => {
  const cases = [
    fixture({ task: makeTask({ ownerCatId: 'other-owner' }) }),
    fixture({ task: makeTask({ developmentScope: { ...DEV_SCOPE, acceptedRevision: 'b'.repeat(40) } }) }),
    fixture({ proposal: makeProposal({ status: 'superseded' }) }),
  ];
  const foreignTenant = fixture();
  foreignTenant.request.tenantScope = 'foreign-user';
  cases.push(foreignTenant);
  const wrongChild = fixture();
  wrongChild.request.targetThreadId = 'thread-other-child';
  cases.push(wrongChild);

  for (const f of cases) {
    await assert.rejects(f.service.admit(f.request), /standing|approved|owner|scope|tenant|child|identity/i);
    assert.equal(f.current().generation, 1);
  }
});
