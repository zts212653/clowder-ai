/**
 * F233 — ThreadSplitCollector tests (F252 Phase C prerequisite)
 *
 * ThreadSplitCollector scans approved thread proposals to produce
 * `thread_split` trajectory entries linking parent→child threads.
 *
 * RED tests first — collector doesn't exist yet.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

// ---------------------------------------------------------------------------
// Helpers — inline stubs (no real Redis)
// ---------------------------------------------------------------------------

/** Stub proposal store that returns canned data. */
function makeProposalStoreStub(proposals = []) {
  return {
    listAll: async () => proposals,
  };
}

/** Stub feat index lookup that maps threadId → featId. */
function makeFeatIndexStub(threadToFeat = {}) {
  return {
    lookupByThreadId: async (threadId) => threadToFeat[threadId] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function makeProposal(overrides = {}) {
  return {
    proposalId: 'prop_001',
    status: 'approved',
    sourceThreadId: 'thread_parent',
    parentThreadId: 'thread_parent',
    createdThreadId: 'thread_child',
    sourceCatId: 'opus',
    createdAt: 1719360000000,
    approvedAt: 1719360060000,
    ...overrides,
  };
}

// ==========================================================================
// Tests
// ==========================================================================

describe('F233 ThreadSplitCollector', () => {
  let ThreadSplitCollector;

  beforeEach(async () => {
    // Dynamic import — will fail until implementation exists (RED phase)
    const mod = await import('../dist/domains/feat-trajectory/ThreadSplitCollector.js');
    ThreadSplitCollector = mod.ThreadSplitCollector;
  });

  it('produces thread_split entry for approved proposal with createdThreadId', async () => {
    const proposals = [makeProposal()];
    const proposalStore = makeProposalStoreStub(proposals);
    const featIndex = makeFeatIndexStub({ thread_parent: 'F252' });

    const collector = new ThreadSplitCollector({ proposalStore, featIndex });
    const snapshots = await collector.collectAll();

    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].kind, 'thread_split');
    assert.equal(snapshots[0].parentThreadId, 'thread_parent');
    assert.equal(snapshots[0].childThreadId, 'thread_child');
    assert.equal(snapshots[0].featId, 'F252');
    assert.equal(snapshots[0].proposalId, 'prop_001');
  });

  it('skips proposals without createdThreadId (pending/rejected)', async () => {
    const proposals = [
      makeProposal({ status: 'pending', createdThreadId: undefined }),
      makeProposal({ status: 'rejected', createdThreadId: undefined }),
    ];
    const proposalStore = makeProposalStoreStub(proposals);
    const featIndex = makeFeatIndexStub({ thread_parent: 'F252' });

    const collector = new ThreadSplitCollector({ proposalStore, featIndex });
    const snapshots = await collector.collectAll();

    assert.equal(snapshots.length, 0);
  });

  it('skips proposals in approving state even with createdThreadId (R2 P1: premature split)', async () => {
    // createdThreadId is checkpointed during approving (before finalize),
    // so the collector must gate on status === 'approved' to avoid premature edges.
    const proposals = [makeProposal({ status: 'approving', createdThreadId: 'thread_child' })];
    const proposalStore = makeProposalStoreStub(proposals);
    const featIndex = makeFeatIndexStub({ thread_parent: 'F252' });

    const collector = new ThreadSplitCollector({ proposalStore, featIndex });
    const snapshots = await collector.collectAll();

    assert.equal(snapshots.length, 0, 'approving proposal should not produce a split');
  });

  it('skips proposals where parent thread has no feat association', async () => {
    const proposals = [makeProposal()];
    const proposalStore = makeProposalStoreStub(proposals);
    const featIndex = makeFeatIndexStub({}); // no feat for this thread

    const collector = new ThreadSplitCollector({ proposalStore, featIndex });
    const snapshots = await collector.collectAll();

    assert.equal(snapshots.length, 0);
  });

  it('handles multiple proposals across different features', async () => {
    const proposals = [
      makeProposal({ proposalId: 'p1', parentThreadId: 't1', createdThreadId: 'c1' }),
      makeProposal({ proposalId: 'p2', parentThreadId: 't2', createdThreadId: 'c2' }),
    ];
    const proposalStore = makeProposalStoreStub(proposals);
    const featIndex = makeFeatIndexStub({ t1: 'F100', t2: 'F200' });

    const collector = new ThreadSplitCollector({ proposalStore, featIndex });
    const snapshots = await collector.collectAll();

    assert.equal(snapshots.length, 2);
    assert.equal(snapshots[0].featId, 'F100');
    assert.equal(snapshots[1].featId, 'F200');
  });

  it('uses approvedAt timestamp when available, falls back to createdAt', async () => {
    const proposals = [
      makeProposal({ approvedAt: 1719360060000, createdAt: 1719360000000 }),
      makeProposal({ proposalId: 'p2', approvedAt: undefined, createdAt: 1719360000000 }),
    ];
    const proposalStore = makeProposalStoreStub(proposals);
    const featIndex = makeFeatIndexStub({ thread_parent: 'F252' });

    const collector = new ThreadSplitCollector({ proposalStore, featIndex });
    const snapshots = await collector.collectAll();

    assert.equal(snapshots[0].splitAt, 1719360060000);
    assert.equal(snapshots[1].splitAt, 1719360000000);
  });
});
