import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { anchorApproval } from './approval-hub/helpers.js';

describe('approveTasteProposal checkpointed service', () => {
  let approveTasteProposal;
  let InMemoryTasteProposalStore;
  let SessionMutex;
  let store;
  let lock;

  beforeEach(async () => {
    ({ approveTasteProposal } = await import('../dist/domains/taste/services/approveTasteProposal.js'));
    ({ InMemoryTasteProposalStore } = await import('../dist/domains/taste/stores/InMemoryTasteProposalStore.js'));
    ({ SessionMutex } = await import('../dist/domains/cats/services/agents/invocation/SessionMutex.js'));
    store = new InMemoryTasteProposalStore();
    lock = new SessionMutex();
  });

  const makeProposal = () =>
    store.create({
      userId: 'user-1',
      catId: 'codex-sol',
      threadId: 'thread-1',
      scene: 'operator approved a reusable taste judgment',
      quote: '这就是我要的',
      tags: ['真实'],
      dimension: 'authentic-expression',
      privacy: 'public',
    });

  const writerResult = { slug: 'authentic-expression-real-123xyz', path: 'docs/taste/vignettes/real.md' };
  const deps = (writeVignette, overrides = {}) => ({
    store,
    lock,
    lockKey: () => '/repo/docs/taste/index.md',
    writeVignette,
    ...overrides,
  });

  it('claims, checkpoints the durable writer output, and finalizes', async () => {
    const proposal = makeProposal();
    const result = await approveTasteProposal(
      proposal.id,
      'user-1',
      deps(async () => writerResult),
    );

    assert.equal(result.ok, true);
    assert.equal(result.proposal.status, 'approved');
    assert.equal(result.proposal.vignetteSlug, writerResult.slug);
    assert.equal(result.proposal.vignettePath, writerResult.path);
  });

  it('rolls back to pending when the writer fails before a durable checkpoint', async () => {
    const proposal = makeProposal();
    const result = await approveTasteProposal(
      proposal.id,
      'user-1',
      deps(async () => {
        throw new Error('disk full');
      }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'write_failed');
    assert.equal(store.get(proposal.id).status, 'pending');
  });

  it('recovers a durable write when checkpoint persistence failed', async () => {
    class CheckpointFailingStore extends InMemoryTasteProposalStore {
      failuresRemaining = 1;
      recordWriteCheckpoint(id, checkpoint) {
        if (this.failuresRemaining-- > 0) throw new Error('redis down after git commit');
        return super.recordWriteCheckpoint(id, checkpoint);
      }
    }
    store = new CheckpointFailingStore();
    const proposal = makeProposal();
    let writerCalls = 0;
    const writeVignette = async () => {
      writerCalls++;
      return writerResult;
    };

    const first = await approveTasteProposal(proposal.id, 'user-1', deps(writeVignette));
    const retried = await approveTasteProposal(proposal.id, 'user-1', deps(writeVignette));

    assert.equal(first.ok, false);
    assert.equal(store.get(proposal.id).status, 'approved');
    assert.equal(retried.ok, true);
    assert.equal(retried.recovered, true);
    assert.equal(writerCalls, 2, 'retry re-enters the idempotent writer to detect the exact committed vignette');
  });

  it('skips the writer when finalize failed after the checkpoint', async () => {
    class FinalizeFailingStore extends InMemoryTasteProposalStore {
      failuresRemaining = 1;
      finalizeApproval(...args) {
        if (this.failuresRemaining-- > 0) throw new Error('redis down during finalize');
        return super.finalizeApproval(...args);
      }
    }
    store = new FinalizeFailingStore();
    const proposal = makeProposal();
    let writerCalls = 0;
    const writeVignette = async () => {
      writerCalls++;
      return writerResult;
    };

    const first = await approveTasteProposal(proposal.id, 'user-1', deps(writeVignette));
    const retried = await approveTasteProposal(proposal.id, 'user-1', deps(writeVignette));

    assert.equal(first.ok, false);
    assert.equal(retried.ok, true);
    assert.equal(retried.recovered, true);
    assert.equal(writerCalls, 1, 'recorded checkpoint makes finalize retry write-free');
  });

  it('exposes a persisted approving checkpoint to a fresh Hub view and resumes exactly once', async () => {
    const { F221ApprovalAdapter } = await import('../dist/domains/approval-hub/adapters/F221ApprovalAdapter.js');
    const proposal = makeProposal();
    // F246 Phase I: anchor publication so Hub can project the navigation.
    await anchorApproval(store, {
      proposalId: proposal.id,
      sourceFeatureId: 'F221',
      ownerUserId: proposal.userId,
      requesterCatId: proposal.catId,
      threadId: proposal.threadId,
      createdAt: proposal.createdAt,
    });
    store.claimForApproval(proposal.id, 'user-1');
    store.recordWriteCheckpoint(proposal.id, {
      vignetteSlug: writerResult.slug,
      vignettePath: writerResult.path,
    });

    const freshAdapter = new F221ApprovalAdapter(store);
    const [recoveryItem] = await freshAdapter.listPending('user-1');
    assert.ok(recoveryItem, 'fresh Hub view must keep durable approving work discoverable');
    assert.equal(recoveryItem.decisionMode, 'resume-only');
    assert.equal(recoveryItem.inlineApprovable, true);

    let writerCalls = 0;
    const writeVignette = async () => {
      writerCalls++;
      return writerResult;
    };
    const resumed = await approveTasteProposal(proposal.id, 'user-1', deps(writeVignette));
    const retried = await approveTasteProposal(proposal.id, 'user-1', deps(writeVignette));

    assert.equal(resumed.ok, true);
    assert.equal(resumed.recovered, true);
    assert.equal(retried.ok, true);
    assert.equal(store.get(proposal.id).status, 'approved');
    assert.equal(writerCalls, 0, 'a durable checkpoint resumes at finalize and never rewrites');
    assert.deepEqual(await freshAdapter.listPending('user-1'), []);
  });

  it('serializes concurrent approves and writes exactly once', async () => {
    const proposal = makeProposal();
    let writerCalls = 0;
    const writeVignette = async () => {
      writerCalls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return writerResult;
    };

    const [first, second] = await Promise.all([
      approveTasteProposal(proposal.id, 'user-1', deps(writeVignette)),
      approveTasteProposal(proposal.id, 'user-1', deps(writeVignette)),
    ]);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(writerCalls, 1);
  });
});
