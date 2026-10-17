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
  CHILD_CAT,
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
    const bindings = await provider.getBindingsForTask(TASK_ID, OWNER_THREAD, TENANT);
    assert.equal(bindings.length, 1, 'should return one binding for the matching task');
    assert.equal(bindings[0].proposalId, PROPOSAL_ID);
    assert.equal(bindings[0].approvedUnderOwner, SOURCE_CAT);
  });

  test('no proposals from thread → empty bindings (fail closed)', async () => {
    const provider = new ThreadDelegateBindingProvider(makeProposalLister([]));
    const bindings = await provider.getBindingsForTask(TASK_ID, OWNER_THREAD, TENANT);
    assert.deepEqual(bindings, [], 'no proposals → fail closed');
  });

  // P1-1 core fix: task B in the same thread cannot borrow task A's approval
  test('same-thread task B cannot borrow task A approval (task isolation)', async () => {
    const TASK_B = 'task-unrelated-b';
    // Thread has one approved proposal, but it's bound to TASK_ID (task A)
    const provider = new ThreadDelegateBindingProvider(
      makeProposalLister([makeProposalListItem({ subjectTaskId: TASK_ID })]),
    );
    // Task A gets the binding
    const bindingsA = await provider.getBindingsForTask(TASK_ID, OWNER_THREAD, TENANT);
    assert.equal(bindingsA.length, 1, 'task A should get the binding');
    // Task B must NOT get the binding
    const bindingsB = await provider.getBindingsForTask(TASK_B, OWNER_THREAD, TENANT);
    assert.deepEqual(bindingsB, [], 'task B must not borrow task A approval');
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
    const bindingsA = await provider.getBindingsForTask(TASK_ID, OWNER_THREAD, TENANT);
    assert.equal(bindingsA.length, 1, 'task A binding must survive addition of unrelated proposal');
    assert.equal(bindingsA[0].proposalId, 'prop-for-a');
    // Task C gets its own binding
    const bindingsC = await provider.getBindingsForTask('task-c', OWNER_THREAD, TENANT);
    assert.equal(bindingsC.length, 1, 'task C should get its own binding');
    assert.equal(bindingsC[0].proposalId, 'prop-for-c');
  });

  test('legacy proposal without subjectTaskId → empty bindings (fail closed)', async () => {
    const provider = new ThreadDelegateBindingProvider(
      makeProposalLister([makeProposalListItem({ subjectTaskId: undefined })]),
    );
    const bindings = await provider.getBindingsForTask(TASK_ID, OWNER_THREAD, TENANT);
    assert.deepEqual(bindings, [], 'legacy proposal without subjectTaskId → fail closed');
  });

  test('approved proposal without createdThreadId is excluded', async () => {
    const provider = new ThreadDelegateBindingProvider(
      makeProposalLister([
        makeProposalListItem({ proposalId: 'prop-no-child', createdThreadId: undefined }),
        makeProposalListItem({ proposalId: 'prop-with-child', createdThreadId: CHILD_THREAD }),
      ]),
    );
    const bindings = await provider.getBindingsForTask(TASK_ID, OWNER_THREAD, TENANT);
    assert.equal(bindings.length, 1, 'should find the one with createdThreadId');
    assert.equal(bindings[0].proposalId, 'prop-with-child');
  });

  test('non-approved proposals are excluded', async () => {
    const provider = new ThreadDelegateBindingProvider(
      makeProposalLister([
        makeProposalListItem({ proposalId: 'prop-pending', status: 'pending' }),
        makeProposalListItem({ proposalId: 'prop-rejected', status: 'rejected' }),
        makeProposalListItem({ proposalId: 'prop-approved' }),
      ]),
    );
    const bindings = await provider.getBindingsForTask(TASK_ID, OWNER_THREAD, TENANT);
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].proposalId, 'prop-approved');
  });

  test('tenant mismatch → empty bindings (fail closed)', async () => {
    const provider = new ThreadDelegateBindingProvider(makeProposalLister([makeProposalListItem()]));
    const bindings = await provider.getBindingsForTask(TASK_ID, OWNER_THREAD, 'wrong-tenant');
    assert.deepEqual(bindings, [], 'tenant mismatch → fail closed');
  });

  test('approvedUnderOwner reflects sourceCatId, not a passed-in value', async () => {
    const DIFFERENT_SOURCE = 'other-proposer-cat';
    const provider = new ThreadDelegateBindingProvider(
      makeProposalLister([makeProposalListItem({ sourceCatId: DIFFERENT_SOURCE })]),
    );
    const bindings = await provider.getBindingsForTask(TASK_ID, OWNER_THREAD, TENANT);
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0].approvedUnderOwner, DIFFERENT_SOURCE, 'approvedUnderOwner must be proposal.sourceCatId');
  });

  test('multiple same-task approvals return independent tenant-scoped bindings', async () => {
    const provider = new ThreadDelegateBindingProvider(
      makeProposalLister([
        makeProposalListItem({ proposalId: 'prop-old', createdThreadId: 'thread-old' }),
        makeProposalListItem({ proposalId: 'prop-current', createdThreadId: 'thread-current' }),
        makeProposalListItem({ proposalId: 'prop-other-tenant', createdBy: 'other-user' }),
      ]),
    );
    const bindings = await provider.getBindingsForTask(TASK_ID, OWNER_THREAD, TENANT);
    assert.deepEqual(
      bindings.map((binding) => binding.proposalId),
      ['prop-old', 'prop-current'],
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Suite 5: Full production pipeline end-to-end
// ═══════════════════════════════════════════════════════════════════════

/** Build full pipeline using real ThreadDelegateBindingProvider + ProposalStoreDelegateProvider. */
function buildProductionPipeline({
  proposal = makeProposal(),
  proposals,
  proposalListItems = [makeProposalListItem()],
  task = makeTask(),
} = {}) {
  const bindingProvider = new ThreadDelegateBindingProvider(makeProposalLister(proposalListItems));
  const delegateProvider = new ProposalStoreDelegateProvider(makeProposalStore(proposals ?? proposal), bindingProvider);
  const taskProvider = {
    async get(id) {
      return id === task.id ? task : null;
    },
  };
  const resolver = new ActionSubjectTruthResolver(mockTruthLeaseStore(), taskProvider, delegateProvider);
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

  test('multiple independently approved proposals admit the exact requested child', async () => {
    const oldProposalId = 'prop-old-child';
    const oldChildCat = 'sonnet';
    const oldChildThread = 'thread-old-child';
    const pipelineOptions = {
      proposals: [
        makeProposal({
          proposalId: oldProposalId,
          createdThreadId: oldChildThread,
          preferredCats: [oldChildCat],
        }),
        makeProposal(),
      ],
      proposalListItems: [
        makeProposalListItem({ proposalId: oldProposalId, createdThreadId: oldChildThread }),
        makeProposalListItem(),
      ],
    };
    const { service } = buildProductionPipeline(pipelineOptions);
    const result = await service.admit(admissionRequest());
    assert.equal(result.admit, true, 'the exact current child pair should select its independently approved proposal');
    assert.ok(
      result.lease.evidenceRefs.includes(`proposal:${PROPOSAL_ID}:approved:thread:${CHILD_THREAD}:cat:${CHILD_CAT}`),
      'the lease must retain the matched proposal authority',
    );

    const { service: structuredTransferService } = buildProductionPipeline(pipelineOptions);
    const structuredTransferRequest = admissionRequest();
    const structuredTransferResult = await structuredTransferService.admit({
      ...structuredTransferRequest,
      actorCatId: OWNER_CAT,
      sourceThreadId: OWNER_THREAD,
      action: {
        ...structuredTransferRequest.action,
        claimOrigin: 'structured_transfer',
      },
    });
    assert.equal(
      structuredTransferResult.admit,
      true,
      'the canonical owner should transfer to the exact approved child through the same proposal set',
    );

    const { service: oldChildService } = buildProductionPipeline(pipelineOptions);
    const oldChildResult = await oldChildService.admit(
      admissionRequest({
        actorCatId: oldChildCat,
        holderCatIds: [oldChildCat],
        sourceThreadId: oldChildThread,
        targetThreadId: oldChildThread,
      }),
    );
    assert.ok(
      oldChildResult.lease.evidenceRefs.includes(
        `proposal:${oldProposalId}:approved:thread:${oldChildThread}:cat:${oldChildCat}`,
      ),
      'the older exact child pair remains backed by its own durable approval',
    );
  });

  test('multiple approved proposals do not authorize a cat/thread pair assembled across approvals', async () => {
    const oldProposalId = 'prop-old-child';
    const oldChildCat = 'sonnet';
    const oldChildThread = 'thread-old-child';
    const { service } = buildProductionPipeline({
      proposals: [
        makeProposal({
          proposalId: oldProposalId,
          createdThreadId: oldChildThread,
          preferredCats: [oldChildCat],
        }),
        makeProposal(),
      ],
      proposalListItems: [
        makeProposalListItem({ proposalId: oldProposalId, createdThreadId: oldChildThread }),
        makeProposalListItem(),
      ],
    });
    await assert.rejects(
      service.admit(
        admissionRequest({
          actorCatId: oldChildCat,
          holderCatIds: [oldChildCat],
          sourceThreadId: CHILD_THREAD,
          targetThreadId: CHILD_THREAD,
        }),
      ),
      (err) => err instanceof ActionSuccessorStandingError,
    );
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
