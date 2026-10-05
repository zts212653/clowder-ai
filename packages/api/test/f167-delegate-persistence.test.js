/**
 * F167 × F322 — Suite 6+7: subjectTaskId production persistence chain tests.
 *
 * Suite 6: InMemoryProposalStore create→list→binding round-trip.
 * Suite 7: Redis serializeProposal/hydrateProposal round-trip for subjectTaskId + subjectTaskTitle.
 *
 * Split from f167-delegate-binding.test.js (R4 P1-3: 350-line hard limit).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CHILD_THREAD, OWNER_CAT, OWNER_THREAD, TASK_ID, TENANT } from './f167-delegate-test-helpers.js';

const { InMemoryProposalStore } = await import('../dist/domains/cats/services/stores/ports/ProposalStore.js');
const { serializeProposal, hydrateProposal } = await import(
  '../dist/domains/cats/services/stores/redis/RedisProposalStoreHelpers.js'
);
const { ThreadDelegateBindingProvider } = await import('../dist/domains/ball-custody/ProposalStoreDelegateProvider.js');

// ═══════════════════════════════════════════════════════════════════════
// Suite 6: subjectTaskId production persistence (create→list→binding)
// ═══════════════════════════════════════════════════════════════════════

describe('F167 R3-P1-1 — subjectTaskId production persistence (create→list→binding)', () => {
  test('InMemoryProposalStore persists subjectTaskId through create→listByThread→binding', async () => {
    const store = new InMemoryProposalStore();
    const proposal = store.create({
      sourceThreadId: OWNER_THREAD,
      sourceInvocationId: 'inv-test',
      sourceCatId: OWNER_CAT,
      sourceMessageId: 'msg-test',
      title: 'F322 child delegation',
      reason: 'Delegate task to child thread',
      parentThreadId: OWNER_THREAD,
      preferredCats: ['codex6-sol'],
      projectPath: '/test',
      createdBy: TENANT,
      subjectTaskId: TASK_ID,
      subjectTaskTitle: 'Implement feature X',
    });

    // Verify subjectTaskId is persisted on the created proposal
    assert.equal(proposal.subjectTaskId, TASK_ID, 'subjectTaskId must survive create');
    assert.equal(proposal.subjectTaskTitle, 'Implement feature X', 'subjectTaskTitle must survive create');

    // Simulate approval: finalize the proposal
    store.claimForApproval({ proposalId: proposal.proposalId, approvedBy: TENANT });
    store.finalizeApproval({ proposalId: proposal.proposalId, createdThreadId: CHILD_THREAD });

    // List by thread — this is what ThreadDelegateBindingProvider calls
    const listed = store.listByThread(OWNER_THREAD);
    const found = listed.find((p) => p.proposalId === proposal.proposalId);
    assert.ok(found, 'proposal must appear in listByThread');
    assert.equal(found.subjectTaskId, TASK_ID, 'subjectTaskId must survive list round-trip');
    assert.equal(found.subjectTaskTitle, 'Implement feature X', 'subjectTaskTitle must survive list round-trip');
    assert.equal(found.status, 'approved');
    assert.equal(found.createdThreadId, CHILD_THREAD);

    // Wire through ThreadDelegateBindingProvider — the production consumer
    const bindingProvider = new ThreadDelegateBindingProvider({
      listByThread: async (threadId) => store.listByThread(threadId),
    });
    const binding = await bindingProvider.getBindingForTask(TASK_ID, OWNER_THREAD, TENANT);
    assert.ok(binding, 'binding must resolve from persisted proposal with subjectTaskId');
    assert.equal(binding.proposalId, proposal.proposalId);
    assert.equal(binding.approvedUnderOwner, OWNER_CAT);
  });

  test('proposal without subjectTaskId → binding returns null (fail closed)', async () => {
    const store = new InMemoryProposalStore();
    const proposal = store.create({
      sourceThreadId: OWNER_THREAD,
      sourceInvocationId: 'inv-test-2',
      sourceCatId: OWNER_CAT,
      sourceMessageId: 'msg-test-2',
      title: 'Legacy proposal (no task binding)',
      reason: 'No subjectTaskId',
      parentThreadId: OWNER_THREAD,
      preferredCats: ['codex6-sol'],
      projectPath: '/test',
      createdBy: TENANT,
      // no subjectTaskId — legacy path
    });

    store.claimForApproval({ proposalId: proposal.proposalId, approvedBy: TENANT });
    store.finalizeApproval({ proposalId: proposal.proposalId, createdThreadId: CHILD_THREAD });

    const bindingProvider = new ThreadDelegateBindingProvider({
      listByThread: async (threadId) => store.listByThread(threadId),
    });
    const binding = await bindingProvider.getBindingForTask(TASK_ID, OWNER_THREAD, TENANT);
    assert.equal(binding, null, 'legacy proposal without subjectTaskId → fail closed');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Suite 7: Redis serialize/hydrate round-trip
// ═══════════════════════════════════════════════════════════════════════

describe('F167 R3-P1-1 — subjectTaskId Redis serialize/hydrate round-trip', () => {
  test('serializeProposal includes subjectTaskId + subjectTaskTitle and hydrateProposal recovers them', () => {
    const proposal = {
      proposalId: 'prop-redis-test',
      status: 'approved',
      sourceThreadId: OWNER_THREAD,
      sourceInvocationId: 'inv-redis',
      sourceCatId: OWNER_CAT,
      title: 'Redis round-trip',
      reason: 'Test serialization',
      parentThreadId: OWNER_THREAD,
      preferredCats: ['codex6-sol'],
      projectPath: '/test',
      createdBy: TENANT,
      createdAt: 1000,
      subjectTaskId: TASK_ID,
      subjectTaskTitle: 'Build feature Y',
    };

    const serialized = serializeProposal(proposal);
    // Verify subjectTaskId appears in the serialized pairs
    const taskIdIndex = serialized.indexOf('subjectTaskId');
    assert.ok(taskIdIndex >= 0, 'subjectTaskId must be present in serialized output');
    assert.equal(serialized[taskIdIndex + 1], TASK_ID, 'serialized taskId value must match');

    const titleIndex = serialized.indexOf('subjectTaskTitle');
    assert.ok(titleIndex >= 0, 'subjectTaskTitle must be present in serialized output');
    assert.equal(serialized[titleIndex + 1], 'Build feature Y', 'serialized title value must match');

    // Convert flat array back to Record<string, string> (Redis HGETALL format)
    const data = {};
    for (let i = 0; i < serialized.length; i += 2) {
      data[serialized[i]] = serialized[i + 1];
    }

    const hydrated = hydrateProposal(data);
    assert.equal(hydrated.subjectTaskId, TASK_ID, 'subjectTaskId must survive hydrate');
    assert.equal(hydrated.subjectTaskTitle, 'Build feature Y', 'subjectTaskTitle must survive hydrate');
    assert.equal(hydrated.proposalId, 'prop-redis-test');
  });

  test('serializeProposal omits subjectTaskId and subjectTaskTitle when absent', () => {
    const proposal = {
      proposalId: 'prop-no-task',
      status: 'pending',
      sourceThreadId: OWNER_THREAD,
      sourceInvocationId: 'inv-no-task',
      sourceCatId: OWNER_CAT,
      title: 'No task binding',
      reason: 'Legacy',
      parentThreadId: OWNER_THREAD,
      preferredCats: [],
      projectPath: '/test',
      createdBy: TENANT,
      createdAt: 2000,
    };

    const serialized = serializeProposal(proposal);
    assert.ok(!serialized.includes('subjectTaskId'), 'subjectTaskId must not appear when absent');
    assert.ok(!serialized.includes('subjectTaskTitle'), 'subjectTaskTitle must not appear when absent');

    const data = {};
    for (let i = 0; i < serialized.length; i += 2) {
      data[serialized[i]] = serialized[i + 1];
    }

    const hydrated = hydrateProposal(data);
    assert.equal(hydrated.subjectTaskId, undefined, 'subjectTaskId must remain undefined');
    assert.equal(hydrated.subjectTaskTitle, undefined, 'subjectTaskTitle must remain undefined');
  });
});
