/** F167: parent-bound proposal discovery when proposal source and Task thread differ. */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  admissionRequest,
  CHILD_CAT,
  CHILD_THREAD,
  makeProposal,
  makeProposalListItem,
  makeTask,
  mockLeaseStore,
  mockTruthLeaseStore,
  OWNER_CAT,
  OWNER_THREAD,
  PROPOSAL_ID,
  STUDIO_THREAD,
  TASK_ID,
  TENANT,
} from './f167-delegate-test-helpers.js';

const { ActionSuccessorAdmissionService } = await import(
  '../dist/domains/ball-custody/ActionSuccessorAdmissionService.js'
);
const { ActionSubjectTruthResolver } = await import('../dist/domains/ball-custody/ActionSubjectTruthResolver.js');
const { createTaskApprovedDelegateProvider, TaskThreadProposalLister, ThreadDelegateBindingProvider } = await import(
  '../dist/domains/ball-custody/ProposalStoreDelegateProvider.js'
);

function child(overrides = {}) {
  return {
    id: CHILD_THREAD,
    parentThreadId: OWNER_THREAD,
    createdBy: TENANT,
    createdFromProposalId: PROPOSAL_ID,
    ...overrides,
  };
}

function lister({ children = [child()], proposals = [makeProposalListItem()] } = {}) {
  const byId = new Map(proposals.map((proposal) => [proposal.proposalId, proposal]));
  const childrenById = new Map(children.map((candidate) => [candidate.id, candidate]));
  return new TaskThreadProposalLister(
    {
      get: async (proposalId) => byId.get(proposalId) ?? null,
      listAllByThread: async (sourceThreadId) =>
        proposals.filter((proposal) => proposal.sourceThreadId === sourceThreadId),
    },
    { getChildThreads: async () => children, get: async (threadId) => childrenById.get(threadId) ?? null },
  );
}

describe('F167 parent-thread proposal discovery', () => {
  test('finds the exact proposal through its approved child, independent of source thread', async () => {
    const proposals = await lister({
      proposals: [makeProposalListItem({ sourceThreadId: STUDIO_THREAD, parentThreadId: OWNER_THREAD })],
    }).listAllByTaskThread(OWNER_THREAD, TENANT);
    assert.deepEqual(
      proposals.map((proposal) => proposal.proposalId),
      [PROPOSAL_ID],
    );
  });

  test('fails closed for deleted, foreign-tenant, or wrong-parent child relations', async () => {
    for (const invalidChild of [
      child({ deletedAt: 10 }),
      child({ createdBy: 'other-user' }),
      child({ parentThreadId: 'thread-other-parent' }),
    ]) {
      assert.deepEqual(
        await lister({
          children: [invalidChild],
          proposals: [makeProposalListItem({ sourceThreadId: STUDIO_THREAD })],
        }).listAllByTaskThread(OWNER_THREAD, TENANT),
        [],
      );
    }
  });

  test('legacy Task-source approval remains bound when its child was re-rooted to another parent', async () => {
    const alternateParent = 'thread-alternate-parent';
    const provider = new ThreadDelegateBindingProvider(
      lister({
        children: [child({ parentThreadId: alternateParent })],
        proposals: [makeProposalListItem({ sourceThreadId: OWNER_THREAD, parentThreadId: alternateParent })],
      }),
    );
    const bindings = await provider.getBindingsForTask(TASK_ID, OWNER_THREAD, TENANT);
    assert.deepEqual(
      bindings.map((binding) => binding.proposalId),
      [PROPOSAL_ID],
    );
  });

  test('cannot assemble proposal id and created child across two different relations', async () => {
    const first = child({ id: 'thread-a', createdFromProposalId: 'proposal-a' });
    const second = child({ id: 'thread-b', createdFromProposalId: 'proposal-b' });
    const proposals = [
      makeProposalListItem({ proposalId: 'proposal-a', createdThreadId: 'thread-b' }),
      makeProposalListItem({ proposalId: 'proposal-b', createdThreadId: 'thread-a' }),
    ];
    assert.deepEqual(
      await lister({ children: [first, second], proposals }).listAllByTaskThread(OWNER_THREAD, TENANT),
      [],
    );
  });
});

test('approved Studio proposal admits structured transfer for its exact parent Task', async () => {
  const fullProposal = makeProposal({ sourceThreadId: STUDIO_THREAD, parentThreadId: OWNER_THREAD });
  const proposalListItem = makeProposalListItem({ sourceThreadId: STUDIO_THREAD, parentThreadId: OWNER_THREAD });
  const approvedChild = child();
  const delegateProvider = createTaskApprovedDelegateProvider(
    {
      get: async (id) => (id === fullProposal.proposalId ? fullProposal : null),
      listAllByThread: async (sourceThreadId) => (sourceThreadId === STUDIO_THREAD ? [proposalListItem] : []),
    },
    {
      getChildThreads: async (parentThreadId) => (parentThreadId === OWNER_THREAD ? [approvedChild] : []),
      get: async (threadId) => (threadId === CHILD_THREAD ? approvedChild : null),
    },
  );
  const resolver = new ActionSubjectTruthResolver(
    mockTruthLeaseStore(),
    { get: async (id) => (id === TASK_ID ? makeTask() : null) },
    delegateProvider,
  );
  const service = new ActionSuccessorAdmissionService(mockLeaseStore(), resolver);
  const request = admissionRequest();
  const result = await service.admit({
    ...request,
    actorCatId: OWNER_CAT,
    sourceThreadId: OWNER_THREAD,
    action: { ...request.action, claimOrigin: 'structured_transfer' },
  });

  assert.equal(result.admit, true);
  assert.ok(
    result.lease.evidenceRefs.includes(`proposal:${PROPOSAL_ID}:approved:thread:${CHILD_THREAD}:cat:${CHILD_CAT}`),
  );
});
