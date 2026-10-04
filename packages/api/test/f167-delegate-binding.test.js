/**
 * F167 × F322 — Suites 4+5: ThreadDelegateBindingProvider unit tests
 * and full production pipeline end-to-end tests.
 *
 * Suite 4: Isolated ThreadDelegateBindingProvider (thread→proposal binding).
 * Suite 5: End-to-end pipeline with ThreadDelegateBindingProvider →
 *   ProposalStoreDelegateProvider → ActionSubjectTruthResolver → admission.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  admissionRequest,
  CHILD_THREAD,
  makeProposal,
  makeProposalLister,
  makeProposalListItem,
  makeProposalStore,
  makeTask,
  mockCommunityStore,
  mockLeaseStore,
  mockTruthLeaseStore,
  OWNER_CAT,
  OWNER_THREAD,
  PROPOSAL_ID,
  SOURCE_CAT,
  TASK_ID,
  TENANT,
} from './f167-delegate-test-helpers.js';

const { ActionSuccessorAdmissionService, ActionSuccessorStandingError } = await import(
  '../dist/domains/ball-custody/ActionSuccessorAdmissionService.js'
);
const { ActionSubjectTruthResolver } = await import('../dist/domains/ball-custody/ActionSubjectTruthResolver.js');
const { ProposalStoreDelegateProvider, ThreadDelegateBindingProvider } = await import(
  '../dist/domains/ball-custody/ProposalStoreDelegateProvider.js'
);

// ═══════════════════════════════════════════════════════════════════════
// Suite 4: ThreadDelegateBindingProvider unit tests
// ═══════════════════════════════════════════════════════════════════════

describe('F167 ThreadDelegateBindingProvider — task-scoped proposal binding', () => {
  test('proposal with matching subjectTaskId → returns binding', async () => {
    const provider = new ThreadDelegateBindingProvider(makeProposalLister([makeProposalListItem()]));
    const binding = await provider.getBindingForTask(TASK_ID, OWNER_THREAD, TENANT);
    assert.ok(binding, 'should return a binding for the matching task');
    assert.equal(binding.proposalId, PROPOSAL_ID);
    assert.equal(binding.approvedUnderOwner, SOURCE_CAT);
  });

  test('no proposals from thread → null (fail closed)', async () => {
    const provider = new ThreadDelegateBindingProvider(makeProposalLister([]));
    const binding = await provider.getBindingForTask(TASK_ID, OWNER_THREAD, TENANT);
    assert.equal(binding, null, 'no proposals → fail closed');
  });

  // P1-1 core fix: task B in the same thread cannot borrow task A's approval
  test('same-thread task B cannot borrow task A approval (task isolation)', async () => {
    const TASK_B = 'task-unrelated-b';
    // Thread has one approved proposal, but it's bound to TASK_ID (task A)
    const provider = new ThreadDelegateBindingProvider(
      makeProposalLister([makeProposalListItem({ subjectTaskId: TASK_ID })]),
    );
    // Task A gets the binding
    const bindingA = await provider.getBindingForTask(TASK_ID, OWNER_THREAD, TENANT);
    assert.ok(bindingA, 'task A should get the binding');
    // Task B must NOT get the binding
    const bindingB = await provider.getBindingForTask(TASK_B, OWNER_THREAD, TENANT);
    assert.equal(bindingB, null, 'task B must not borrow task A approval');
  });

  // P1-1 core fix: adding unrelated proposal doesn't break existing binding
  test('adding second proposal for task C does not break task A binding', async () => {
    const provider = new ThreadDelegateBindingProvider(
      makeProposalLister([
        makeProposalListItem({ proposalId: 'prop-for-a', subjectTaskId: TASK_ID }),
        makeProposalListItem({
          proposalId: 'prop-for-c',
          subjectTaskId: 'task-c',
          createdThreadId: 'thread-child-c',
        }),
      ]),
    );
    // Task A still gets its binding — not broken by the second proposal
    const bindingA = await provider.getBindingForTask(TASK_ID, OWNER_THREAD, TENANT);
    assert.ok(bindingA, 'task A binding must survive addition of unrelated proposal');
    assert.equal(bindingA.proposalId, 'prop-for-a');
    // Task C gets its own binding
    const bindingC = await provider.getBindingForTask('task-c', OWNER_THREAD, TENANT);
    assert.ok(bindingC, 'task C should get its own binding');
    assert.equal(bindingC.proposalId, 'prop-for-c');
  });

  test('legacy proposal without subjectTaskId → null (fail closed)', async () => {
    const provider = new ThreadDelegateBindingProvider(
      makeProposalLister([makeProposalListItem({ subjectTaskId: undefined })]),
    );
    const binding = await provider.getBindingForTask(TASK_ID, OWNER_THREAD, TENANT);
    assert.equal(binding, null, 'legacy proposal without subjectTaskId → fail closed');
  });

  test('approved proposal without createdThreadId is excluded', async () => {
    const provider = new ThreadDelegateBindingProvider(
      makeProposalLister([
        makeProposalListItem({ proposalId: 'prop-no-child', createdThreadId: undefined }),
        makeProposalListItem({ proposalId: 'prop-with-child', createdThreadId: CHILD_THREAD }),
      ]),
    );
    const binding = await provider.getBindingForTask(TASK_ID, OWNER_THREAD, TENANT);
    assert.ok(binding, 'should find the one with createdThreadId');
    assert.equal(binding.proposalId, 'prop-with-child');
  });

  test('non-approved proposals are excluded', async () => {
    const provider = new ThreadDelegateBindingProvider(
      makeProposalLister([
        makeProposalListItem({ proposalId: 'prop-pending', status: 'pending' }),
        makeProposalListItem({ proposalId: 'prop-rejected', status: 'rejected' }),
        makeProposalListItem({ proposalId: 'prop-approved' }),
      ]),
    );
    const binding = await provider.getBindingForTask(TASK_ID, OWNER_THREAD, TENANT);
    assert.ok(binding);
    assert.equal(binding.proposalId, 'prop-approved');
  });

  test('tenant mismatch → null (fail closed)', async () => {
    const provider = new ThreadDelegateBindingProvider(makeProposalLister([makeProposalListItem()]));
    const binding = await provider.getBindingForTask(TASK_ID, OWNER_THREAD, 'wrong-tenant');
    assert.equal(binding, null, 'tenant mismatch → fail closed');
  });

  test('approvedUnderOwner reflects sourceCatId, not a passed-in value', async () => {
    const DIFFERENT_SOURCE = 'other-proposer-cat';
    const provider = new ThreadDelegateBindingProvider(
      makeProposalLister([makeProposalListItem({ sourceCatId: DIFFERENT_SOURCE })]),
    );
    const binding = await provider.getBindingForTask(TASK_ID, OWNER_THREAD, TENANT);
    assert.ok(binding);
    assert.equal(binding.approvedUnderOwner, DIFFERENT_SOURCE, 'approvedUnderOwner must be proposal.sourceCatId');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Suite 5: Full production pipeline end-to-end
// ═══════════════════════════════════════════════════════════════════════

/** Build full pipeline using real ThreadDelegateBindingProvider + ProposalStoreDelegateProvider. */
function buildProductionPipeline({
  proposal = makeProposal(),
  proposalListItems = [makeProposalListItem()],
  task = makeTask(),
} = {}) {
  const bindingProvider = new ThreadDelegateBindingProvider(makeProposalLister(proposalListItems));
  const delegateProvider = new ProposalStoreDelegateProvider(makeProposalStore(proposal), bindingProvider);
  const taskProvider = {
    async get(id) {
      return id === task.id ? task : null;
    },
  };
  const resolver = new ActionSubjectTruthResolver(
    mockTruthLeaseStore(),
    mockCommunityStore(),
    undefined,
    taskProvider,
    undefined,
    delegateProvider,
  );
  return { service: new ActionSuccessorAdmissionService(mockLeaseStore(), resolver) };
}

describe('F167 production pipeline — ThreadDelegateBindingProvider end-to-end', () => {
  test('approved child admitted through production binding chain', async () => {
    const { service } = buildProductionPipeline();
    const result = await service.admit(admissionRequest());
    assert.equal(result.admit, true, 'production binding should deliver positive capability');
    assert.equal(result.outcome, 'claimed');
  });

  test('no proposals from parent thread → production chain rejects', async () => {
    const { service } = buildProductionPipeline({ proposalListItems: [] });
    await assert.rejects(service.admit(admissionRequest()), (err) => err instanceof ActionSuccessorStandingError);
  });

  test('multiple approved proposals → production chain rejects (ambiguous)', async () => {
    const { service } = buildProductionPipeline({
      proposalListItems: [
        makeProposalListItem({ proposalId: 'prop-1', createdThreadId: 'child-1' }),
        makeProposalListItem({ proposalId: 'prop-2', createdThreadId: 'child-2' }),
      ],
    });
    await assert.rejects(service.admit(admissionRequest()), (err) => err instanceof ActionSuccessorStandingError);
  });

  test('task owner changed from original proposer → production chain rejects', async () => {
    const { service } = buildProductionPipeline({ task: makeTask({ ownerCatId: 'new-owner-cat' }) });
    await assert.rejects(service.admit(admissionRequest()), (err) => err instanceof ActionSuccessorStandingError);
  });

  test('later-joined reviewer rejected through production binding chain', async () => {
    const REVIEWER_CAT = 'reviewer-only';
    const { service } = buildProductionPipeline();
    await assert.rejects(
      service.admit(
        admissionRequest({
          actorCatId: REVIEWER_CAT,
          sourceThreadId: CHILD_THREAD,
          targetThreadId: CHILD_THREAD,
          holderCatIds: [REVIEWER_CAT],
        }),
      ),
      (err) => err instanceof ActionSuccessorStandingError,
    );

    const result = await service.admit(admissionRequest());
    assert.equal(result.admit, true, 'original approved cat still admitted');
  });

  test('withdrawn proposal → production chain rejects', async () => {
    const { service } = buildProductionPipeline({
      proposal: makeProposal({ status: 'withdrawn' }),
      proposalListItems: [makeProposalListItem({ status: 'withdrawn' })],
    });
    await assert.rejects(service.admit(admissionRequest()), (err) => err instanceof ActionSuccessorStandingError);
  });

  test('exact owner still admitted through production pipeline', async () => {
    const { service } = buildProductionPipeline();
    const result = await service.admit(
      admissionRequest({
        actorCatId: OWNER_CAT,
        sourceThreadId: OWNER_THREAD,
        targetThreadId: OWNER_THREAD,
        holderCatIds: [OWNER_CAT],
      }),
    );
    assert.equal(result.admit, true, 'exact owner passes through production pipeline');
  });
});

// Suites 6+7 (persistence chain tests) moved to f167-delegate-persistence.test.js (R4 P1-3: 350-line split)
