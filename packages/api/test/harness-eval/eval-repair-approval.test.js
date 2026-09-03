import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createEvalRepairCutover } from '../../dist/infrastructure/harness-eval/eval-repair-cutover.js';
import {
  actionRef,
  caseAction,
  caseId,
  fixture,
  MemoryEventLog,
  ownerAuthorizationRef,
  principal,
  proposeAndAccept,
  ref,
  targetVersionRef,
} from './eval-repair-approval-fixtures.js';

describe('F313/F266 Approval-gated repair dispatch', () => {
  it('keeps the whole v3 route closed when any cutover component is absent or version-skewed', async () => {
    const required = {
      lifecycleVersion: 1,
      loaderVersion: 1,
      routeVersion: 1,
      materializerVersion: 1,
      eventLog: new MemoryEventLog(),
      approvalIngress: { publish() {} },
      approvalAdapter: { featureId: 'F266', listPending: async () => [], listSettled: async () => [] },
      ownerResolver: async () => ({
        status: 'blocked',
        reason: 'owner_unresolved',
        blockerRef: ref('F188', 'blocker:owner'),
      }),
      repairDispatcher: {
        materialize() {
          throw new Error('not called');
        },
      },
      caseActionResolver: async () => null,
      epochAuthority: {
        async authorize() {
          return {
            allowed: true,
            record: {
              producerId: 'F266',
              epoch: 1,
              revision: 3,
              phase: 'v1_active',
              updatedAt: '2026-09-02T00:00:00.000Z',
              cutoverReceiptRef: 'receipt:f266:v1',
            },
          };
        },
      },
    };
    for (const key of [
      'eventLog',
      'approvalIngress',
      'approvalAdapter',
      'ownerResolver',
      'repairDispatcher',
      'caseActionResolver',
    ]) {
      const result = await createEvalRepairCutover({ ...required, [key]: undefined });
      assert.equal(result.status, 'blocked');
      assert.equal(result.effects.openCase, false);
      assert.equal(result.effects.approvalProposal, false);
      assert.equal(result.effects.task, false);
      assert.ok(result.missing.includes(key));
    }
    const skewed = await createEvalRepairCutover({ ...required, routeVersion: 2 });
    assert.equal(skewed.status, 'blocked');
    assert.ok(skewed.missing.includes('routeVersion@1'));
  });

  it('publishes one immutable proposal with exact owner authorization and target refs from server truth', async () => {
    const ctx = fixture();
    const first = await ctx.service.propose({ caseActionRef: actionRef, clientMessageId: 'client-1', principal });
    const replay = await ctx.service.propose({ caseActionRef: actionRef, clientMessageId: 'client-1', principal });
    assert.equal(first.status, 'published');
    assert.equal(replay.proposalId, first.proposalId);
    assert.deepEqual(ctx.counts(), { proposals: 1, cards: 1, tasks: 0, leases: 0, mutations: 0 });
    const proposal = (await ctx.eventLog.read(caseId)).find((event) => event.type === 'approval_proposed');
    assert.deepEqual(proposal.requestSnapshot.ownerAuthorizationRef, ownerAuthorizationRef);
    assert.deepEqual(proposal.requestSnapshot.targetVersionRef, targetVersionRef);
    assert.equal(proposal.requestOrigin.invocationId, principal.invocationId);
    assert.equal(proposal.requestOrigin.threadId, principal.threadId);
    assert.equal(proposal.requestOrigin.messageId, principal.originMessageId);
    assert.equal('clientMessageId' in proposal, false);
    assert.match(proposal.requestIdempotencyRef, /^idempotency:F266:[a-f0-9]{64}$/);
    assert.equal(proposal.requestIdempotencyRef.includes('client-1'), false);
    await ctx.service.decide({
      proposalId: first.proposalId,
      decision: 'accept',
      reasonCode: 'accepted_as_proposed',
      decidedByUserId: 'owner-user',
    });
    const decision = (await ctx.eventLog.read(caseId)).find((event) => event.type === 'approval_decided');
    assert.deepEqual(decision.requestSnapshot.ownerAuthorizationRef, ownerAuthorizationRef);
    assert.deepEqual(decision.requestSnapshot.targetVersionRef, targetVersionRef);
  });

  it('recovers a staged proposal from its immutable first origin rather than replay caller coordinates', async () => {
    const attempts = [];
    const approvalIngress = {
      async publish(draft, store) {
        attempts.push(structuredClone(draft));
        if (attempts.length === 1) throw new Error('simulated post-proposal publication interruption');
        const envelope = {
          canonicalProposalId: draft.canonicalProposalId,
          sourceFeatureId: 'F266',
          ownerUserId: draft.ownerUserId,
          requesterCatId: draft.requesterCatId,
          originRef: draft.originRef,
          approvalCardRef: { threadId: draft.cardThreadId, messageId: `card-${draft.canonicalProposalId}` },
          createdAt: draft.createdAt,
        };
        await store.commitEnvelope(draft.canonicalProposalId, envelope);
        return envelope;
      },
    };
    const ctx = fixture({ approvalIngress });
    await assert.rejects(
      () => ctx.service.propose({ caseActionRef: actionRef, clientMessageId: 'client-first', principal }),
      /interruption/,
    );
    const replayPrincipal = {
      ...principal,
      invocationId: 'invocation-replay',
      userId: 'other-user',
      catId: 'codex-terra',
      threadId: 'thread-other',
      originMessageId: 'message-other',
    };
    const recovered = await ctx.service.propose({
      caseActionRef: actionRef,
      clientMessageId: 'client-replay',
      principal: replayPrincipal,
    });
    assert.equal(recovered.status, 'published');
    assert.equal(attempts.length, 2);
    assert.deepEqual(
      {
        ownerUserId: attempts[1].ownerUserId,
        requesterCatId: attempts[1].requesterCatId,
        originRef: attempts[1].originRef,
        cardThreadId: attempts[1].cardThreadId,
      },
      {
        ownerUserId: principal.userId,
        requesterCatId: principal.catId,
        originRef: { kind: 'message', threadId: principal.threadId, messageId: principal.originMessageId },
        cardThreadId: principal.threadId,
      },
    );
    assert.deepEqual(ctx.counts(), { proposals: 1, cards: 0, tasks: 0, leases: 0, mutations: 0 });
  });

  it('blocks decision and custody while the proposal publication is still staged', async () => {
    const ctx = fixture({
      approvalIngress: {
        async publish() {
          throw new Error('publication interrupted before anchor');
        },
      },
    });
    await assert.rejects(
      () => ctx.service.propose({ caseActionRef: actionRef, clientMessageId: 'client-1', principal }),
      /interrupted/,
    );
    const proposal = (await ctx.eventLog.read(caseId)).find((event) => event.type === 'approval_proposed');
    const decided = await ctx.service.decide({
      proposalId: proposal.proposalId,
      decision: 'accept',
      reasonCode: 'accepted_as_proposed',
      decidedByUserId: 'owner-user',
    });
    assert.deepEqual(decided, { status: 'blocked', reason: 'approval_not_anchored' });
    assert.equal(
      (await ctx.eventLog.read(caseId)).some((event) => event.type === 'approval_decided'),
      false,
    );
    assert.deepEqual(ctx.counts(), { proposals: 1, cards: 0, tasks: 0, leases: 0, mutations: 0 });
  });

  it('settles concurrent conflicting decisions to one canonical resolution without custody', async () => {
    const ctx = fixture();
    const proposed = await ctx.service.propose({ caseActionRef: actionRef, clientMessageId: 'client-1', principal });
    const [accepted, rejected] = await Promise.all([
      ctx.service.decide({
        proposalId: proposed.proposalId,
        decision: 'accept',
        reasonCode: 'accepted_as_proposed',
        decidedByUserId: 'owner-user',
      }),
      ctx.service.decide({
        proposalId: proposed.proposalId,
        decision: 'reject',
        reasonCode: 'insufficient_evidence',
        decidedByUserId: 'owner-user',
      }),
    ]);
    assert.deepEqual(accepted, { status: 'accepted' });
    assert.deepEqual(rejected, { status: 'duplicate', resolution: 'accepted' });
    assert.equal((await ctx.eventLog.read(caseId)).filter((event) => event.type === 'approval_decided').length, 1);
    assert.deepEqual(ctx.counts(), { proposals: 1, cards: 1, tasks: 0, leases: 0, mutations: 0 });
  });

  for (const reason of [
    ['owner_authorization_missing'],
    ['owner_authorization_unreadable'],
    ['owner_authorization_expired'],
    ['owner_authorization_target_mismatch'],
    ['target_version_mismatch'],
  ].flat())
    it(`fails closed on ${reason} before proposal/card/custody`, async () => {
      const ctx = fixture({
        ownerSnapshot: { status: 'blocked', reason, blockerRef: ref('F188', `blocker:${reason}`) },
      });
      const result = await ctx.service.propose({ caseActionRef: actionRef, clientMessageId: 'client-1', principal });
      assert.equal(result.status, 'blocked');
      assert.equal(result.reason, reason);
      assert.deepEqual(ctx.counts(), { proposals: 0, cards: 0, tasks: 0, leases: 0, mutations: 0 });
    });

  it('keeps observe/insufficient outside Approval and custody', async () => {
    for (const analysisDisposition of ['observe', 'insufficient']) {
      const ctx = fixture();
      ctx.actions.set(actionRef, caseAction({ analysisDisposition, approvalRequirement: { kind: 'not_required' } }));
      const result = await ctx.service.propose({
        caseActionRef: actionRef,
        clientMessageId: `client-${analysisDisposition}`,
        principal,
      });
      assert.equal(result.status, 'not_required');
      assert.deepEqual(ctx.counts(), { proposals: 0, cards: 0, tasks: 0, leases: 0, mutations: 0 });
    }
  });

  for (const resolution of ['open', 'rejected', 'closed_without_decision'])
    it(`does not dispatch a ${resolution} Approval`, async () => {
      const ctx = fixture();
      const proposed = await ctx.service.propose({ caseActionRef: actionRef, clientMessageId: 'client-1', principal });
      if (resolution !== 'open') {
        await ctx.service.decide({
          proposalId: proposed.proposalId,
          decision: resolution === 'rejected' ? 'reject' : 'withdraw',
          reasonCode: resolution === 'rejected' ? 'insufficient_evidence' : 'not_now',
          decidedByUserId: 'owner-user',
        });
      }
      const result = await ctx.service.materialize(proposed.proposalId);
      assert.equal(result.status, 'not_eligible');
      assert.equal(result.resolution, resolution);
      assert.deepEqual(ctx.counts(), { proposals: 1, cards: 1, tasks: 0, leases: 0, mutations: 0 });
    });

  it('materializes one ref-only custody for a fresh accepted Approval across replay, concurrency, and service restart', async () => {
    const eventLog = new MemoryEventLog();
    const custody = { dispatches: new Map(), taskCount: 0, leaseCount: 0 };
    const ctx = fixture({ eventLog, custody });
    const restarted = fixture({ eventLog, custody });
    const proposed = await proposeAndAccept(ctx);
    const [left, right] = await Promise.all([
      ctx.service.materialize(proposed.proposalId),
      restarted.service.materialize(proposed.proposalId),
    ]);
    assert.ok(['materialized', 'duplicate'].includes(left.status));
    assert.ok(['materialized', 'duplicate'].includes(right.status));
    const replay = await ctx.service.materialize(proposed.proposalId);
    assert.equal(replay.status, 'duplicate');
    assert.deepEqual(ctx.counts(), { proposals: 1, cards: 1, tasks: 1, leases: 1, mutations: 0 });
    const receipt = (await ctx.eventLog.read(caseId)).find((event) => event.type === 'approval_materialized');
    assert.deepEqual(receipt.dispatchSnapshot.ownerAuthorizationRef, ownerAuthorizationRef);
    assert.deepEqual(receipt.dispatchSnapshot.targetVersionRef, targetVersionRef);
    assert.deepEqual(receipt.requestSnapshot.ownerAuthorizationRef, ownerAuthorizationRef);
    assert.deepEqual(receipt.requestSnapshot.targetVersionRef, targetVersionRef);
  });

  it('keeps custody empty when owner authorization becomes unreadable inside the atomic dispatch boundary', async () => {
    const ctx = fixture({
      beforeDispatchValidation({ setOwner }) {
        setOwner({
          status: 'blocked',
          reason: 'owner_authorization_unreadable',
          blockerRef: ref('F188', 'blocker:owner-authorization-unreadable'),
        });
      },
    });
    const proposed = await proposeAndAccept(ctx);

    const result = await ctx.service.materialize(proposed.proposalId);

    assert.deepEqual(result, { status: 'blocked', reason: 'owner_authorization_unreadable' });
    assert.deepEqual(ctx.counts(), { proposals: 1, cards: 1, tasks: 0, leases: 0, mutations: 0 });
    const events = await ctx.eventLog.read(caseId);
    assert.equal(events.filter((event) => event.type === 'approval_materialization_started').length, 1);
    assert.equal(
      events.some((event) => event.type === 'approval_materialized'),
      false,
    );
  });

  it('fails closed when the v1 epoch is missing, unreadable, or fenced', async () => {
    for (const reason of ['epoch_missing', 'epoch_read_failed', 'operation_fenced']) {
      const ctx = fixture({
        epochAuthority: {
          async authorize() {
            return { allowed: false, reason };
          },
        },
      });
      const result = await ctx.service.propose({ caseActionRef: actionRef, clientMessageId: 'client-1', principal });
      assert.equal(result.status, 'blocked');
      assert.equal(result.reason, 'approval_lifecycle_unavailable');
      assert.deepEqual(ctx.counts(), { proposals: 0, cards: 0, tasks: 0, leases: 0, mutations: 0 });
    }
  });
});
