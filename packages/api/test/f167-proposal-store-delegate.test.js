/**
 * F167 × F322 — Suite 3: Real ProposalStoreDelegateProvider tests.
 *
 * Uses the real ProposalStoreDelegateProvider class with mock stores,
 * not pre-built delegate arrays. Each test constructs real proposal
 * objects and verifies the 7-step fail-closed authorization chain.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  admissionRequest,
  CHILD_CAT,
  CHILD_THREAD,
  DEV_SCOPE,
  makeBindingProvider,
  makeProposal,
  makeProposalStore,
  makeTask,
  mockCommunityStore,
  mockLeaseStore,
  mockTruthLeaseStore,
  OWNER_CAT,
  OWNER_THREAD,
  PROPOSAL_ID,
  TASK_ID,
  TENANT,
} from './f167-delegate-test-helpers.js';

const { ActionSuccessorAdmissionService, ActionSuccessorStandingError } = await import(
  '../dist/domains/ball-custody/ActionSuccessorAdmissionService.js'
);
const { ActionSubjectTruthResolver } = await import('../dist/domains/ball-custody/ActionSubjectTruthResolver.js');
const { ProposalStoreDelegateProvider } = await import('../dist/domains/ball-custody/ProposalStoreDelegateProvider.js');

const VALID_BINDING = { proposalId: PROPOSAL_ID, approvedUnderOwner: OWNER_CAT };

/** Build full resolver→admission pipeline using real ProposalStoreDelegateProvider. */
function buildRealDelegatePipeline({
  proposal = makeProposal(),
  binding = null,
  task = makeTask(),
  bindingTaskId = TASK_ID,
} = {}) {
  const bindingProvider = makeBindingProvider({ taskId: bindingTaskId, binding });
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

describe('F167 approved-child delegation — real proposal-backed provider', () => {
  // ── Positive: full authorization chain passes ──

  test('approved proposal + valid binding + correct owner → child admitted', async () => {
    const { service } = buildRealDelegatePipeline({ proposal: makeProposal(), binding: VALID_BINDING });
    const result = await service.admit(admissionRequest());
    assert.equal(result.admit, true, 'full authorization chain should admit');
    assert.equal(result.outcome, 'claimed');
  });

  // ── P1-1: task-level scoping via binding ──

  test('no binding for this task → child rejected (task-scoped delegation)', async () => {
    const provider = new ProposalStoreDelegateProvider(
      makeProposalStore(makeProposal()),
      makeBindingProvider({ binding: VALID_BINDING }),
    );
    const delegates = await provider.getForTask('task-f322-different', OWNER_THREAD, OWNER_CAT, TENANT);
    assert.deepEqual(delegates, [], 'no binding for different task → empty delegates');
  });

  // ── P1-2: owner change invalidation via binding ──

  test('owner changed since approval → child rejected', async () => {
    const provider = new ProposalStoreDelegateProvider(
      makeProposalStore(makeProposal()),
      makeBindingProvider({ binding: VALID_BINDING }),
    );
    const delegates = await provider.getForTask(TASK_ID, OWNER_THREAD, 'new-owner-cat', TENANT);
    assert.deepEqual(delegates, [], 'owner mismatch → empty delegates');
  });

  // ── Missing proposal ──

  test('proposal not in store (missing/tampered) → child rejected', async () => {
    const provider = new ProposalStoreDelegateProvider(
      makeProposalStore(null),
      makeBindingProvider({ binding: VALID_BINDING }),
    );
    const delegates = await provider.getForTask(TASK_ID, OWNER_THREAD, OWNER_CAT, TENANT);
    assert.deepEqual(delegates, [], 'missing proposal → empty delegates');
  });

  // ── Non-approved proposal status ──

  test('proposal status is rejected → child rejected', async () => {
    const provider = new ProposalStoreDelegateProvider(
      makeProposalStore(makeProposal({ status: 'rejected' })),
      makeBindingProvider({ binding: VALID_BINDING }),
    );
    const delegates = await provider.getForTask(TASK_ID, OWNER_THREAD, OWNER_CAT, TENANT);
    assert.deepEqual(delegates, [], 'rejected proposal → empty delegates');
  });

  test('proposal status is withdrawn → child rejected', async () => {
    const provider = new ProposalStoreDelegateProvider(
      makeProposalStore(makeProposal({ status: 'withdrawn' })),
      makeBindingProvider({ binding: VALID_BINDING }),
    );
    const delegates = await provider.getForTask(TASK_ID, OWNER_THREAD, OWNER_CAT, TENANT);
    assert.deepEqual(delegates, [], 'withdrawn proposal → empty delegates');
  });

  // ── Thread mismatch ──

  test('proposal sourceThreadId differs from task thread → child rejected', async () => {
    const provider = new ProposalStoreDelegateProvider(
      makeProposalStore(makeProposal({ sourceThreadId: 'thread-different-source' })),
      makeBindingProvider({ binding: VALID_BINDING }),
    );
    const delegates = await provider.getForTask(TASK_ID, OWNER_THREAD, OWNER_CAT, TENANT);
    assert.deepEqual(delegates, [], 'thread mismatch → empty delegates');
  });

  // ── Tenant mismatch ──

  test('proposal creator differs from tenant → child rejected', async () => {
    const provider = new ProposalStoreDelegateProvider(
      makeProposalStore(makeProposal({ createdBy: 'user-wrong' })),
      makeBindingProvider({ binding: VALID_BINDING }),
    );
    const delegates = await provider.getForTask(TASK_ID, OWNER_THREAD, OWNER_CAT, TENANT);
    assert.deepEqual(delegates, [], 'tenant mismatch → empty delegates');
  });

  // ── No createdThreadId ──

  test('approved proposal without createdThreadId → child rejected', async () => {
    const provider = new ProposalStoreDelegateProvider(
      makeProposalStore(makeProposal({ createdThreadId: undefined })),
      makeBindingProvider({ binding: VALID_BINDING }),
    );
    const delegates = await provider.getForTask(TASK_ID, OWNER_THREAD, OWNER_CAT, TENANT);
    assert.deepEqual(delegates, [], 'no createdThreadId → empty delegates');
  });

  // ── preferredCats: only approved target cats, not thread roster ──

  test('empty preferredCats → child rejected (fail closed)', async () => {
    const provider = new ProposalStoreDelegateProvider(
      makeProposalStore(makeProposal({ preferredCats: [] })),
      makeBindingProvider({ binding: VALID_BINDING }),
    );
    const delegates = await provider.getForTask(TASK_ID, OWNER_THREAD, OWNER_CAT, TENANT);
    assert.deepEqual(delegates, [], 'empty preferredCats → fail closed');
  });

  test('undefined preferredCats → child rejected (fail closed)', async () => {
    const provider = new ProposalStoreDelegateProvider(
      makeProposalStore(makeProposal({ preferredCats: undefined })),
      makeBindingProvider({ binding: VALID_BINDING }),
    );
    const delegates = await provider.getForTask(TASK_ID, OWNER_THREAD, OWNER_CAT, TENANT);
    assert.deepEqual(delegates, [], 'undefined preferredCats → fail closed');
  });

  test('only preferredCats get delegation — later-joined reviewer excluded', async () => {
    const REVIEWER_CAT = 'reviewer-only';
    const provider = new ProposalStoreDelegateProvider(
      makeProposalStore(makeProposal({ preferredCats: [CHILD_CAT] })),
      makeBindingProvider({ binding: VALID_BINDING }),
    );
    const delegates = await provider.getForTask(TASK_ID, OWNER_THREAD, OWNER_CAT, TENANT, DEV_SCOPE);
    assert.equal(delegates.length, 1, 'exactly one delegate');
    assert.equal(delegates[0].catId, CHILD_CAT, 'only approved cat gets delegation');
    assert.ok(!delegates.some((d) => d.catId === REVIEWER_CAT), 'later-joined reviewer must NOT gain delegation');
  });

  // ── Full pipeline: real provider → resolver → admission ──

  test('real provider → resolver → admission: full chain with approved proposal', async () => {
    const { service } = buildRealDelegatePipeline({ proposal: makeProposal(), binding: VALID_BINDING });
    const result = await service.admit(admissionRequest());
    assert.equal(result.admit, true);
  });

  test('real provider → resolver → admission: rejected proposal → child rejected', async () => {
    const { service } = buildRealDelegatePipeline({
      proposal: makeProposal({ status: 'rejected' }),
      binding: VALID_BINDING,
    });
    await assert.rejects(service.admit(admissionRequest()), (err) => err instanceof ActionSuccessorStandingError);
  });

  test('real provider → resolver → admission: no binding → child rejected', async () => {
    const { service } = buildRealDelegatePipeline({ proposal: makeProposal(), binding: null });
    await assert.rejects(service.admit(admissionRequest()), (err) => err instanceof ActionSuccessorStandingError);
  });

  // ── Anti-pattern full-pipeline tests (F322 consumption boundary #760) ──

  test('anti-pattern 1: different task borrows same approved child → full pipeline rejects', async () => {
    const TASK_B_ID = 'task-f322-b';
    const { service } = buildRealDelegatePipeline({
      proposal: makeProposal(),
      binding: VALID_BINDING,
      bindingTaskId: TASK_ID,
      task: makeTask({ id: TASK_B_ID }),
    });
    const req = admissionRequest();
    await assert.rejects(
      service.admit({ ...req, action: { ...req.action, subjectRef: `subject:task:${TASK_B_ID}` } }),
      (err) => err instanceof ActionSuccessorStandingError,
    );
  });

  test('anti-pattern 2: tampered/missing proposal → full pipeline rejects', async () => {
    const { service } = buildRealDelegatePipeline({ proposal: null, binding: VALID_BINDING });
    await assert.rejects(service.admit(admissionRequest()), (err) => err instanceof ActionSuccessorStandingError);
  });

  test('anti-pattern 3: proposal withdrawn before claim → full pipeline rejects', async () => {
    const { service } = buildRealDelegatePipeline({
      proposal: makeProposal({ status: 'withdrawn' }),
      binding: VALID_BINDING,
    });
    await assert.rejects(service.admit(admissionRequest()), (err) => err instanceof ActionSuccessorStandingError);
  });

  test('anti-pattern 4: owner changed since approval → full pipeline rejects', async () => {
    const { service } = buildRealDelegatePipeline({
      proposal: makeProposal(),
      binding: VALID_BINDING,
      task: makeTask({ ownerCatId: 'new-owner-cat' }),
    });
    await assert.rejects(service.admit(admissionRequest()), (err) => err instanceof ActionSuccessorStandingError);
  });

  test('anti-pattern 5: later-joined reviewer not in preferredCats → full pipeline rejects', async () => {
    const REVIEWER_CAT = 'reviewer-only';
    const { service } = buildRealDelegatePipeline({
      proposal: makeProposal({ preferredCats: [CHILD_CAT] }),
      binding: VALID_BINDING,
    });
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
    assert.equal(result.admit, true, 'original approved cat should still be admitted');
  });
});
