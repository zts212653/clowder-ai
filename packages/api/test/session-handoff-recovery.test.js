import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

// F225 B3: crash-window recovery via session-side reverse-lookup (砚砚 R3).
describe('recoverStaleHandoffProposal (crash-window backfill)', () => {
  let recover;
  let chainStore;
  let handoffStore;

  beforeEach(async () => {
    const mod = await import('../dist/domains/cats/services/session/sessionHandoffApprove.js');
    recover = mod.recoverStaleHandoffProposal;
    const chainMod = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    chainStore = new chainMod.SessionChainStore();
    const handoffMod = await import('../dist/domains/cats/services/stores/ports/SessionHandoffProposalStore.js');
    handoffStore = new handoffMod.InMemorySessionHandoffProposalStore();
  });

  const deps = (over = {}) => ({
    handoffProposalStore: handoffStore,
    sessionChainStore: chainStore,
    requestSeal: async () => ({ accepted: true }),
    enqueueContinuation: async () => ({ entryId: 'entry-1' }),
    ...over,
  });

  // Build an 'approving' proposal whose note is persisted but checkpoint write was lost.
  const crashedAfterClaim = () => {
    const session = chainStore.create({ cliSessionId: 'c1', threadId: 't1', catId: 'opus-45', userId: 'u1' });
    const prop = handoffStore.create({
      sourceThreadId: 't1',
      sourceSessionId: session.id,
      sourceCatId: 'opus-45',
      userId: 'u1',
      note: { done: 'd', nextSteps: 'n' },
    });
    handoffStore.claimForApproval(prop.proposalId);
    handoffStore.recordCheckpoint(prop.proposalId, { handoffNotePersistedAt: 100 });
    return { session, prop };
  };

  it('crash AFTER seal BEFORE checkpoint → backfill from session + enqueue once + finalize', async () => {
    const { session, prop } = crashedAfterClaim();
    // commit point actually crossed (session sealing by this handoff) but proposal checkpoint lost
    chainStore.update(session.id, {
      status: 'sealing',
      sealReason: 'cat_initiated_handoff',
      catHandoffNote: { ...prop.note },
    });
    let enqueueCount = 0;
    const res = await recover(
      deps({ enqueueContinuation: async () => ((enqueueCount += 1), { entryId: 'e1' }) }),
      prop.proposalId,
    );
    assert.equal(res.recovered, true);
    assert.equal(res.outcome, 'completed');
    const p = handoffStore.get(prop.proposalId);
    assert.equal(p.sealedSessionId, session.id, 'backfilled sealedSessionId from session side');
    assert.equal(p.continuationEntryId, 'e1');
    assert.equal(p.status, 'approved');
    assert.equal(enqueueCount, 1, 'enqueue continuation exactly once');
  });

  it('crash BEFORE seal (session still active) → expire, no half-sealed orphan', async () => {
    const { prop } = crashedAfterClaim();
    // session still active → seal never happened → truly pre-commit
    let enqueueCount = 0;
    const res = await recover(
      deps({ enqueueContinuation: async () => ((enqueueCount += 1), { entryId: 'e1' }) }),
      prop.proposalId,
    );
    assert.equal(res.recovered, true);
    assert.equal(res.outcome, 'expired');
    assert.equal(handoffStore.get(prop.proposalId).status, 'expired');
    assert.equal(enqueueCount, 0, 'never enqueue when seal did not happen');
  });

  it('crash AFTER enqueue checkpoint BEFORE finalize → recreate volatile queue entry, then finalize', async () => {
    const { session, prop } = crashedAfterClaim();
    // Post-commit state already has sealedSessionId + continuationEntryId. The entry id is a
    // Redis-backed checkpoint, but the actual InvocationQueue entry is process-local; after a
    // process crash, recovery must recreate it instead of trusting the stale id.
    handoffStore.recordCheckpoint(prop.proposalId, {
      sealedSessionId: session.id,
      sealAcceptedAt: 200,
      continuationEntryId: 'e-prev',
    });
    let enqueueCount = 0;
    const res = await recover(
      deps({ enqueueContinuation: async () => ((enqueueCount += 1), { entryId: 'e2' }) }),
      prop.proposalId,
    );
    assert.equal(res.recovered, true);
    assert.equal(handoffStore.get(prop.proposalId).status, 'approved');
    assert.equal(enqueueCount, 1, 're-enqueues because continuationEntryId is not a durable queue entry');
    assert.equal(handoffStore.get(prop.proposalId).continuationEntryId, 'e2', 'refreshes the active queue entry id');
  });

  it('P1 (砚砚): crash AFTER claim BEFORE note checkpoint (no checkpoint) → expire, NOT completed', async () => {
    const session = chainStore.create({ cliSessionId: 'c1', threadId: 't1', catId: 'opus-45', userId: 'u1' });
    const prop = handoffStore.create({
      sourceThreadId: 't1',
      sourceSessionId: session.id,
      sourceCatId: 'opus-45',
      userId: 'u1',
      note: { done: 'd', nextSteps: 'n' },
    });
    handoffStore.claimForApproval(prop.proposalId);
    // NO recordCheckpoint at all — crash right after claim, before note persisted. seal never happened.
    let enqueueCount = 0;
    const res = await recover(
      deps({ enqueueContinuation: async () => ((enqueueCount += 1), { entryId: 'e1' }) }),
      prop.proposalId,
    );
    assert.equal(res.recovered, true);
    assert.equal(res.outcome, 'expired', 'no-checkpoint approving must expire, not falsely complete');
    assert.equal(handoffStore.get(prop.proposalId).status, 'expired', 'frees A4 slot');
    assert.equal(enqueueCount, 0, 'must not enqueue when seal never happened');
  });

  it('not approving (already approved/terminal) → not recovered', async () => {
    const { prop } = crashedAfterClaim();
    handoffStore.finalizeApproval(prop.proposalId); // already approved
    const res = await recover(deps(), prop.proposalId);
    assert.equal(res.recovered, false);
    assert.equal(res.reason, 'not_approving');
  });
});
