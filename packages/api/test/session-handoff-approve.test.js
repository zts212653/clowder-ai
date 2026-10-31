import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

// F225 Task B1: commit-point approve transaction.
describe('approveSessionHandoff (commit-point model)', () => {
  let approveSessionHandoff;
  let chainStore;
  let handoffStore;

  beforeEach(async () => {
    const approveMod = await import('../dist/domains/cats/services/session/sessionHandoffApprove.js');
    approveSessionHandoff = approveMod.approveSessionHandoff;
    const chainMod = await import('../dist/domains/cats/services/stores/ports/SessionChainStore.js');
    chainStore = new chainMod.SessionChainStore();
    const handoffMod = await import('../dist/domains/cats/services/stores/ports/SessionHandoffProposalStore.js');
    handoffStore = new handoffMod.InMemorySessionHandoffProposalStore();
  });

  const setup = () => {
    const session = chainStore.create({ cliSessionId: 'c1', threadId: 't1', catId: 'opus-45', userId: 'u1' });
    const prop = handoffStore.create({
      sourceThreadId: 't1',
      sourceSessionId: session.id,
      sourceCatId: 'opus-45',
      userId: 'u1',
      note: { done: 'wrote B1', nextSteps: 'write B2' },
    });
    return { session, prop };
  };

  const deps = (over = {}) => ({
    handoffProposalStore: handoffStore,
    sessionChainStore: chainStore,
    requestSeal: async () => ({ accepted: true }),
    enqueueContinuation: async () => ({ entryId: 'entry-1' }),
    ...over,
  });

  it('happy path: claim → persist note → seal → enqueue → finalize approved', async () => {
    const { session, prop } = setup();
    let enqueued = null;
    const res = await approveSessionHandoff(
      deps({ enqueueContinuation: async (i) => ((enqueued = i), { entryId: 'entry-1' }) }),
      prop.proposalId,
    );
    assert.equal(res.ok, true);
    assert.equal(res.proposal.status, 'approved');
    assert.equal(res.proposal.sealedSessionId, session.id, 'commit-point checkpoint recorded');
    assert.equal(res.proposal.sealAcceptedAt > 0, true);
    assert.equal(res.proposal.continuationEntryId, 'entry-1');
    assert.equal(res.proposal.handoffNotePersistedAt > 0, true);
    // note persisted to session (pre-commit, KD-9 reverse-lookup anchor)
    assert.equal(chainStore.get(session.id).catHandoffNote.done, 'wrote B1');
    assert.equal(chainStore.get(session.id).catHandoffNote.proposalId, prop.proposalId);
    assert.equal(enqueued.sourceSessionId, session.id);
  });

  it('not_pending: second approve loses the CAS claim', async () => {
    const { prop } = setup();
    await approveSessionHandoff(deps(), prop.proposalId);
    const res2 = await approveSessionHandoff(deps(), prop.proposalId);
    assert.equal(res2.ok, false);
    assert.equal(res2.reason, 'not_pending');
  });

  it('session_changed: source session no longer active → expire, no seal', async () => {
    const { session, prop } = setup();
    chainStore.update(session.id, { status: 'sealing' }); // superseded / already sealing
    let sealCalled = false;
    const res = await approveSessionHandoff(
      deps({ requestSeal: async () => ((sealCalled = true), { accepted: true }) }),
      prop.proposalId,
    );
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'session_changed');
    assert.equal(sealCalled, false, 'must not seal when session changed');
    assert.equal(handoffStore.get(prop.proposalId).status, 'expired');
  });

  it('seal_rejected: pre-commit, expire (requestSeal not accepted)', async () => {
    const { prop } = setup();
    const res = await approveSessionHandoff(deps({ requestSeal: async () => ({ accepted: false }) }), prop.proposalId);
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'seal_rejected');
    assert.equal(handoffStore.get(prop.proposalId).status, 'expired');
    // no commit-point checkpoint recorded
    assert.equal(handoffStore.get(prop.proposalId).sealedSessionId, undefined);
  });

  it('post-commit recover-forward: enqueue fails AFTER seal → throws, NOT rolled back', async () => {
    const { session, prop } = setup();
    await assert.rejects(
      () =>
        approveSessionHandoff(
          deps({
            requestSeal: async () => ({ accepted: true }),
            enqueueContinuation: async () => {
              throw new Error('enqueue boom');
            },
          }),
          prop.proposalId,
        ),
      /enqueue boom/,
    );
    const p = handoffStore.get(prop.proposalId);
    // commit point crossed: checkpoint durable, proposal NOT expired (recover-forward, not rollback)
    assert.equal(p.sealedSessionId, session.id, 'commit-point checkpoint survives post-commit failure');
    assert.notEqual(p.status, 'expired');
    assert.notEqual(p.status, 'rejected');
  });
});
