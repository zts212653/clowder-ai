import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

// F225 Task A1: SessionHandoffProposal store — CAS claim + commit-point checkpoints.
describe('SessionHandoffProposalStore (in-memory)', () => {
  let store;
  let receiptIndex;

  beforeEach(async () => {
    const [{ InMemorySessionHandoffProposalStore }, { InMemoryHumanDispositionReceiptIndex }] = await Promise.all([
      import('../dist/domains/cats/services/stores/ports/SessionHandoffProposalStore.js'),
      import('../dist/domains/human-disposition/InMemoryHumanDispositionReceiptIndex.js'),
    ]);
    receiptIndex = new InMemoryHumanDispositionReceiptIndex();
    store = new InMemorySessionHandoffProposalStore(receiptIndex);
  });

  const baseInput = (over = {}) => ({
    sourceThreadId: 'thread_1',
    sourceSessionId: 'sess_1',
    sourceCatId: 'opus-45',
    userId: 'user_1',
    note: { done: 'wrote types', nextSteps: 'write store' },
    ...over,
  });

  it('create fills proposalId/sourceSessionId/persistedAt into note + status pending', () => {
    const p = store.create(baseInput());
    assert.equal(p.kind, 'session_handoff');
    assert.equal(p.status, 'pending');
    assert.ok(p.proposalId);
    assert.equal(p.note.proposalId, p.proposalId);
    assert.equal(p.note.sourceSessionId, 'sess_1');
    assert.ok(p.note.persistedAt > 0);
    assert.equal(p.note.done, 'wrote types');
    assert.deepEqual(store.get(p.proposalId), p);
  });

  it('claimForApproval: concurrent claim only one wins (CAS pending→approving)', () => {
    const p = store.create(baseInput());
    const first = store.claimForApproval(p.proposalId);
    const second = store.claimForApproval(p.proposalId);
    assert.ok(first, 'first claim wins');
    assert.equal(first.status, 'approving');
    assert.equal(second, null, 'second claim loses (not pending)');
  });

  it('recordCheckpoint persists commit-point fields WITHOUT changing status', () => {
    const p = store.create(baseInput());
    store.claimForApproval(p.proposalId);
    const patched = store.recordCheckpoint(p.proposalId, {
      handoffNotePersistedAt: 111,
      sealedSessionId: 'sess_1',
      sealAcceptedAt: 222,
    });
    assert.equal(patched.status, 'approving', 'checkpoint does not change status');
    assert.equal(patched.handoffNotePersistedAt, 111);
    assert.equal(patched.sealedSessionId, 'sess_1');
    assert.equal(patched.sealAcceptedAt, 222);
    // persisted (re-read)
    assert.equal(store.get(p.proposalId).sealedSessionId, 'sess_1');
  });

  it('finalizeApproval: CAS approving→approved (null if not approving)', () => {
    const p = store.create(baseInput());
    assert.equal(store.finalizeApproval(p.proposalId), null, 'cannot finalize pending');
    store.claimForApproval(p.proposalId);
    assert.equal(store.finalizeApproval(p.proposalId).status, 'approved');
  });

  it('markRejected: CAS pending→rejected (null if already claimed)', () => {
    const p = store.create(baseInput());
    const rejected = store.markRejected(p.proposalId, { decidedAt: 100 });
    assert.equal(rejected.outcome, 'applied');
    assert.equal(rejected.proposal.status, 'rejected');
    assert.equal(rejected.proposal.humanDispositionLedgerEntry.envelope, undefined);
    assert.ok(receiptIndex.get('user_1', rejected.proposal.humanDispositionLedgerEntry.episode.sourceRef));
    const p2 = store.create(baseInput());
    store.claimForApproval(p2.proposalId);
    assert.equal(store.markRejected(p2.proposalId, { decidedAt: 101 }).outcome, 'not_available');
  });

  it('markRejected atomically captures normalized feedback without allowing terminal mutation', () => {
    const p = store.create(baseInput());
    const result = store.markRejected(p.proposalId, {
      decidedAt: 200,
      feedback: { reasonCode: 'other', detail: '  内容不属于本次交接  ' },
    });
    assert.equal(result.outcome, 'applied');
    const rejected = result.proposal;
    assert.equal(rejected.status, 'rejected');
    assert.deepEqual(rejected.latestHumanDisposition, {
      reasonCode: 'other',
      detail: '内容不属于本次交接',
    });
    assert.equal(
      store.markRejected(p.proposalId, { decidedAt: 201, feedback: { reasonCode: 'wrong' } }).outcome,
      'conflict',
    );
    assert.equal(
      store.markRejected(p.proposalId, {
        decidedAt: 999,
        feedback: { reasonCode: 'other', detail: '内容不属于本次交接' },
      }).outcome,
      'replayed',
    );
    assert.deepEqual(store.get(p.proposalId).latestHumanDisposition, rejected.latestHumanDisposition);
    assert.equal(rejected.humanDispositionLedgerEntry.episode.decidedAt, 200);
  });

  it('markExpired: pending|approving→expired, terminal stays', () => {
    const p = store.create(baseInput());
    assert.equal(store.markExpired(p.proposalId).status, 'expired');
    const p2 = store.create(baseInput());
    store.markRejected(p2.proposalId, { decidedAt: 300 });
    assert.equal(store.markExpired(p2.proposalId), null, 'cannot expire rejected');
  });

  // ── F246: listPendingByUser (Approval Hub aggregation query) ──

  it('listPendingByUser: returns only pending proposals for the given user', () => {
    store.create(baseInput({ userId: 'user_1' }));
    store.create(baseInput({ userId: 'user_1', sourceSessionId: 'sess_2', sourceCatId: 'sonnet' }));
    store.create(baseInput({ userId: 'user_2', sourceSessionId: 'sess_3' }));
    const result = store.listPendingByUser('user_1');
    assert.equal(result.length, 2);
    assert.ok(result.every((p) => p.userId === 'user_1'));
    assert.ok(result.every((p) => p.status === 'pending'));
  });

  it('listPendingByUser: excludes rejected/expired/approved proposals', () => {
    const p1 = store.create(baseInput({ userId: 'user_1' }));
    store.create(baseInput({ userId: 'user_1', sourceSessionId: 'sess_2' }));
    store.markRejected(p1.proposalId, { decidedAt: 301 });
    const result = store.listPendingByUser('user_1');
    assert.equal(result.length, 1);
    assert.notEqual(result[0].proposalId, p1.proposalId);
  });

  it('listPendingByUser: returns empty array when no pending proposals exist', () => {
    assert.deepEqual(store.listPendingByUser('no-such-user'), []);
  });

  it('listPendingByUser: sorts newest first', () => {
    store.create(baseInput({ userId: 'user_1' }));
    store.create(baseInput({ userId: 'user_1', sourceSessionId: 'sess_2' }));
    const result = store.listPendingByUser('user_1');
    assert.ok(result[0].createdAt >= result[1].createdAt);
  });

  it('listActiveBySession: only pending|approving for that session (A4 ≤1 guard)', () => {
    const p1 = store.create(baseInput());
    store.create(baseInput({ sourceSessionId: 'sess_2' }));
    assert.equal(store.listActiveBySession('sess_1').length, 1);
    store.claimForApproval(p1.proposalId);
    assert.equal(store.listActiveBySession('sess_1').length, 1, 'approving still active');
    store.markExpired(p1.proposalId);
    assert.equal(store.listActiveBySession('sess_1').length, 0, 'expired no longer active');
    assert.equal(store.listActiveBySession('sess_2').length, 1);
  });
});
