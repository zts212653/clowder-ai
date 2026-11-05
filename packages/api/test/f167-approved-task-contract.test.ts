import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCatId } from '@cat-cafe/shared';
import { createTaskApprovedDelegateProvider } from '../src/domains/ball-custody/ProposalStoreDelegateProvider.js';
import { InMemoryProposalStore } from '../src/domains/cats/services/stores/ports/ProposalStore.js';
import { TaskStore } from '../src/domains/cats/services/stores/ports/TaskStore.js';
import { ThreadStore } from '../src/domains/cats/services/stores/ports/ThreadStore.js';
import { buildProposalCardBlock } from '../src/routes/proposal-card-block.js';

function genericProposal() {
  const store = new InMemoryProposalStore();
  const proposal = store.create({
    sourceThreadId: 'owner-thread',
    sourceInvocationId: 'inv',
    sourceCatId: createCatId('codex-astra'),
    sourceMessageId: 'human-request',
    title: 'Repair the approved task',
    reason: 'Complete the existing repair',
    parentThreadId: 'owner-thread',
    preferredCats: [createCatId('codex-sol')],
    projectPath: '/fixture',
    initialMessage: 'Implement A/B/C, test the full journey, and preserve the original Task.',
    reportingMode: 'final-only',
    declaredWorkMode: 'parallel',
    createdBy: 'user-1',
    subjectTaskId: 'task-1',
    subjectTaskTitle: 'Existing repair',
  });
  return { store, proposal };
}

test('generic Task approval visibly names the complete proposal as its execution scope', () => {
  const { proposal } = genericProposal();
  const card = buildProposalCardBlock(proposal);
  assert.match(card.fields.find((field) => field.label === '执行范围')?.value ?? '', /本提案完整合同/);
});

test('approval freezes the final complete generic contract, including approval-time edits', () => {
  const { store, proposal } = genericProposal();
  store.claimForApproval({ proposalId: proposal.proposalId, approvedBy: 'user-1' });
  const approved = store.finalizeApproval({
    proposalId: proposal.proposalId,
    createdThreadId: 'child-thread',
    overrides: { title: 'Approved final title', initialMessage: 'Approved final A/B/C contract' },
  });
  assert.ok(approved);
  assert.match(approved.approvedTaskContract?.digest ?? '', /^[a-f0-9]{64}$/, 'generic approval freezes the contract');
  assert.equal(approved.title, 'Approved final title');
  assert.equal(approved.initialMessage, 'Approved final A/B/C contract');
  assert.equal(approved.taskContractContinuation, undefined, 'approval alone does not create continuation authority');
});

test('Memory ProposalStore appends once, isolates returned receipts, and rejects authority drift', async () => {
  const tasks = new TaskStore();
  const threads = new ThreadStore();
  const source = threads.create('user-1', 'Original owner', '/fixture');
  const owner = createCatId('codex-astra');
  const task = tasks.create({
    threadId: source.id,
    title: 'Original Task',
    ownerCatId: owner,
    userId: 'user-1',
    createdBy: 'user',
    why: 'Original request',
  });
  const store = new InMemoryProposalStore();
  const proposal = store.create({
    ...genericProposal().proposal,
    proposalId: 'proposal-memory',
    sourceThreadId: source.id,
    parentThreadId: source.id,
    subjectTaskId: task.id,
    subjectTaskTitle: task.title,
    sourceMessageId: 'owner-source',
  });
  store.commitEnvelope(proposal.proposalId, {
    canonicalProposalId: proposal.proposalId,
    sourceFeatureId: 'F128',
    ownerUserId: 'user-1',
    requesterCatId: owner,
    createdAt: proposal.createdAt,
    originRef: { kind: 'message', threadId: source.id, messageId: 'owner-source' },
    approvalCardRef: { threadId: source.id, messageId: 'approval-card' },
  });
  const child = threads.create('user-1', proposal.title, '/fixture', source.id, {
    createdFromProposalId: proposal.proposalId,
    sourceThreadId: source.id,
    sourceInvocationId: 'inv',
    approvedBy: 'user-1',
    approvedAt: Date.now(),
  });
  store.claimForApproval({ proposalId: proposal.proposalId, approvedBy: 'user-1' });
  store.finalizeApproval({ proposalId: proposal.proposalId, createdThreadId: child.id });
  const authority = {
    task: (id: string) => tasks.get(id),
    child: (id: string) => threads.get(id),
    implementations: () => [],
  };
  const input = {
    proposalId: proposal.proposalId,
    taskId: task.id,
    clientRequestId: 'stable',
    actor: { userId: 'user-1', catId: owner, threadId: source.id },
  };
  const delegates = createTaskApprovedDelegateProvider(store, threads);
  assert.deepEqual(await delegates.getForTask(task.id, source.id, owner, 'user-1', undefined, task.title), []);
  const result = store.continueApprovedTask(input, authority);
  assert.equal(result.outcome, 'continued');
  assert.notEqual(result.outcome, 'rejected');
  if (result.outcome === 'rejected') throw new Error(result.reason);
  const original = structuredClone(result.receipt);
  result.receipt.targetCatIds.push('unapproved-cat');
  const replay = store.continueApprovedTask(input, authority);
  assert.equal(replay.outcome, 'replayed');
  if (replay.outcome === 'rejected') throw new Error(replay.reason);
  assert.deepEqual(replay.receipt, original);
  assert.equal((await delegates.getForTask(task.id, source.id, owner, 'user-1', undefined, task.title)).length, 1);
  tasks.update(task.id, { title: 'Different work' });
  assert.equal(store.continueApprovedTask(input, authority).outcome, 'rejected');
  assert.deepEqual(await delegates.getForTask(task.id, source.id, owner, 'user-1', undefined, 'Different work'), []);
});
