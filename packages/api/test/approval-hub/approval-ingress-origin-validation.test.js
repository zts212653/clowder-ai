import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakePublicationStore, makeDraft, makeHarness } from './approval-ingress-fixtures.js';

describe('ApprovalIngress system-origin validation', () => {
  // F167 — a session-handoff proposal anchors on the message that triggered the
  // invocation, and for a long-running session that message IS the scheduler's
  // wake row ("持球唤醒"), persisted under the `scheduler` system pseudo-user with
  // `catId: null`. A bare `origin.userId !== ownerUserId` check therefore rejected
  // exactly the sessions most in need of a handoff: every attempt driven by a
  // timer wake failed with "Approval origin message owner mismatch", while the
  // same proposal from an A2A-triggered turn (userId = the real owner) succeeded.
  //
  // The threadId assertion does NOT by itself pin the origin to the caller's own
  // thread: it only proves the stored message belongs to the thread the draft
  // NAMES. Tenancy holds as a conjunction — the producer binds originRef and
  // ownerUserId to an authenticated InvocationRecord (fixing which thread may be
  // named), and this ingress then checks the stored origin is consistent with it.
  //
  // Given both, what the userId comparison still decides is narrower: WHO may
  // author a row inside an already-bound thread — and a system pseudo-user
  // speaking in that thread is not another tenant.
  //
  // This comment previously stated the opposite. It survived four review rounds
  // that corrected the same claim in ApprovalIngress.ts, because every round
  // fixed the instance being quoted and nobody grepped for the paraphrase living
  // here (maintainer review, PR #1347).
  it('accepts a scheduler-authored origin for a server-attested producer', async () => {
    const harness = makeHarness({ userId: 'scheduler', catId: null });
    const store = new FakePublicationStore();

    const envelope = await harness.ingress.publish(makeDraft({ producerId: 'F225' }), store);

    assert.equal(store.publication.state, 'anchored');
    assert.equal(envelope.approvalCardRef.threadId, 'source-thread');
  });

  // The exemption is scoped to producers that DECLARE the authenticated origin
  // binding, because ApprovalIngress is shared and the argument only ever covered
  // one caller. Without this case the scoping and no scoping are indistinguishable.
  //
  // F221 is the honest negative: its `sourceMessageId` may be supplied by the
  // request body and the derive path does not tie it back to the InvocationRecord,
  // so it really has not established the binding.
  //
  // Two review layers landed on this one case. The maintainer (PR #1347) caught that
  // the exemption was as wide as the shared ingress while the argument covered one
  // caller. Then @codex-luna (PR #1349) caught that my first negative used F128 —
  // a producer that DOES bind (record.threadId / record.originTriggerMessageId /
  // record.userId, verified at the creation site) — so the case was fossilising a
  // regression of the very 500 this branch exists to fix, and its green read as
  // proof. A negative case is only evidence if its subject genuinely lacks the
  // property; picking the wrong subject makes the assertion cosmetic.
  it('rejects a scheduler-authored origin for a producer without the attestation', async () => {
    const harness = makeHarness({ userId: 'scheduler', catId: null });
    const store = new FakePublicationStore();

    await assert.rejects(
      () => harness.ingress.publish(makeDraft({ producerId: 'F221' }), store),
      /Approval origin message owner mismatch/,
    );
  });

  // Regression guard for the producer Luna's audit reclassified: F128 binds, so a
  // scheduler-authored origin must be ACCEPTED for it. If someone flips F128 back to
  // `forbidden`, this fails instead of silently restoring the owner-mismatch 500.
  it('accepts a scheduler-authored origin for F128, whose binding is transitive but record-derived', async () => {
    const harness = makeHarness({ userId: 'scheduler', catId: null });
    const store = new FakePublicationStore();

    const envelope = await harness.ingress.publish(makeDraft({ producerId: 'F128' }), store);

    assert.equal(store.publication.state, 'anchored');
    assert.equal(envelope.approvalCardRef.threadId, 'source-thread');
  });

  // The exemption must not become a hole. A different HUMAN owner is a genuine
  // cross-tenant anchor and stays rejected — without this, the fix above would be
  // indistinguishable from deleting the check.
  it('still rejects an origin authored by another human user', async () => {
    const harness = makeHarness({ userId: 'user-2', catId: null });
    const store = new FakePublicationStore();

    await assert.rejects(() => harness.ingress.publish(makeDraft(), store), /Approval origin message owner mismatch/);
  });

  // isSystemUserMessage requires BOTH a system userId AND a system/null catId, so
  // a cat-authored row wearing a system userId is not a system message. Pinning it
  // here keeps the exemption tied to that predicate rather than to the userId alone.
  it('rejects a system userId carried by a cat-authored message', async () => {
    const harness = makeHarness({ userId: 'scheduler', catId: 'codex-sol' });
    const store = new FakePublicationStore();

    await assert.rejects(() => harness.ingress.publish(makeDraft(), store), /Approval origin message owner mismatch/);
  });
});
