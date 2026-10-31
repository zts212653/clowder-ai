import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { actionRef, fixture as evalFixture, principal } from '../harness-eval/eval-repair-approval-fixtures.js';
import { assertRedisIsolationOrThrow, cleanupClientKeyspace } from '../helpers/redis-test-helpers.js';
import { anchor, CARD_THREAD, OWNER, REASON, SECRET } from './decision-receipt-producer-fixtures.js';

export async function createExtraProducer(producerId, _db, t) {
  let store, id, settle;
  if (producerId === 'F266') {
    const ctx = evalFixture();
    const proposed = await ctx.service.propose({
      caseActionRef: actionRef,
      clientMessageId: 'receipt-request',
      principal: { ...principal, threadId: CARD_THREAD },
    });
    assert.equal(proposed.status, 'published');
    id = proposed.proposalId;
    const { F266ApprovalAdapter } = await import('../../dist/domains/approval-hub/adapters/F266ApprovalAdapter.js');
    const adapter = new F266ApprovalAdapter(ctx.eventLog);
    settle = (action) =>
      ctx.service.decide({
        proposalId: id,
        decision: action === 'approve' ? 'accept' : 'reject',
        reasonCode: action === 'approve' ? 'accepted_as_proposed' : 'other',
        ...(action === 'reject' ? { reasonText: REASON } : {}),
        decidedByUserId: OWNER,
      });
    return { id, adapter, settle };
  }
  if (producerId === 'F276') {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F246 receipt producer contract');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `receipt-person:${randomUUID()}:` });
    t.after(async () => {
      await cleanupClientKeyspace(redis);
      await redis.quit();
    });
    const { RedisPersonMemoryStore } = await import('../../dist/domains/memory/people/RedisPersonMemoryStore.js');
    store = new RedisPersonMemoryStore(redis);
    id = 'person_candidate_receipt';
    const sourceRef = { kind: 'message', threadId: CARD_THREAD, messageId: 'source-person' };
    const draft = {
      draftId: 'person_draft_receipt',
      payload: { kind: 'reported_fact', predicate: 'organization_unit', value: SECRET, assertedBy: 'owner' },
      normalizedDraft: SECRET,
      sourceRole: 'owner_explicit',
      evidenceExcerpt: SECRET,
      decision: 'pending',
    };
    const secondDraft = {
      ...draft,
      draftId: 'person_draft_receipt_two',
      payload: { ...draft.payload, predicate: 'location' },
    };
    await store.stageCandidate({
      candidateId: id,
      ownerUserId: OWNER,
      requesterCatId: 'codex-sol',
      sourceMessageRef: sourceRef,
      personDraft: { displayName: 'Receipt person', privateAliases: ['Receipt person'] },
      claimDrafts: [draft, secondDraft],
      remainingDraftIds: [draft.draftId, secondDraft.draftId],
      retention: 'owner_controlled_no_ttl',
      createdAt: 100,
      sourceBundle: {
        sources: [
          {
            sourceId: 'source-claim',
            kind: 'message_text',
            sourceRef,
            ownerUserId: OWNER,
            resolvedDigest: 'a'.repeat(64),
            excerpt: SECRET,
          },
        ],
        assertionBindings: [
          { sourceId: 'source-claim', target: { kind: 'claim', draftId: draft.draftId }, role: 'reported_fact' },
          { sourceId: 'source-claim', target: { kind: 'claim', draftId: secondDraft.draftId }, role: 'reported_fact' },
        ],
      },
    });
    await anchor(store, producerId, id, 100);
    settle = async (action) => {
      const approved = await store.approveDrafts({
        ownerUserId: OWNER,
        candidateId: id,
        selectedDraftIds: action === 'approve' ? [draft.draftId, secondDraft.draftId] : [draft.draftId],
        decisionId: 'decision_receipt_approved',
        authorizedAt: 150,
      });
      assert.equal(approved.outcome, 'applied');
      if (action === 'approve') return approved;
      assert.equal(approved.receipt.state, 'partially_materialized');
      // A partial proposal may retain a person ID on rejection. The decision
      // receipt must not resolve that person's private body just to say no.
      store.getPerson = async () => {
        throw new Error('rejected receipt must not read private person data');
      };
      return store.rejectCandidate({
        ownerUserId: OWNER,
        candidateId: id,
        decisionId: 'decision_receipt_rejected',
        feedback: { reasonCode: 'other', detail: REASON },
        decidedAt: 200,
      });
    };
  } else if (producerId === 'F306') {
    const { InMemoryRuntimeInteractionStore } = await import(
      '../../dist/domains/runtime-interaction/stores/InMemoryRuntimeInteractionStore.js'
    );
    store = new InMemoryRuntimeInteractionStore();
    id = 'receipt-runtime';
    await store.createStaged({
      hostEpoch: 'receipt-host',
      now: 100,
      request: {
        version: 1,
        interactionId: id,
        kind: 'approval',
        title: SECRET,
        createdAt: 100,
        owner: { userId: OWNER, threadId: CARD_THREAD, catId: 'codex-sol', invocationId: 'inv' },
        provider: { providerId: 'openai', method: 'item/commandExecution/requestApproval', requestId: 'rpc-receipt' },
        decisions: [
          { id: 'accept', label: 'Allow', outcome: 'accept' },
          { id: 'decline', label: 'Decline', outcome: 'decline' },
        ],
      },
    });
    await store.anchor(
      id,
      'receipt-host',
      { threadId: CARD_THREAD, messageId: 'runtime-card', blockId: 'runtime-block' },
      101,
    );
    settle = (action) =>
      store.settle({
        interactionId: id,
        hostEpoch: 'receipt-host',
        now: 200,
        terminal: {
          status: action === 'approve' ? 'answered' : 'declined',
          reasonCode: action === 'approve' ? 'answered' : 'user_rejected',
          settledAt: 200,
          response: { kind: 'approval', decisionId: action === 'approve' ? 'accept' : 'decline' },
        },
      });
  } else if (producerId === 'F321') {
    const { InMemoryEventMemoryCorrectionProposalStore } = await import(
      '../../dist/domains/memory/event/InMemoryEventMemoryCorrectionProposalStore.js'
    );
    store = new InMemoryEventMemoryCorrectionProposalStore();
    id = 'receipt-event';
    const proposal = await store.create({
      proposalId: id,
      eventId: 'evt-receipt',
      expectedRevision: `sha256:${'a'.repeat(64)}`,
      reason: 'unsupported_by_source',
      suggestedPatch: { summary: SECRET },
      ownerUserId: OWNER,
      sourceCatId: 'codex-sol',
      sourceThreadId: 'source-thread',
      sourceInvocationId: 'inv',
      source: { threadId: 'source-thread', messageId: 'source-event' },
      clientRequestId: 'receipt-event-request',
      approvalOriginRef: { kind: 'message', threadId: CARD_THREAD, messageId: 'source-event' },
    });
    await anchor(store, producerId, id, proposal.createdAt);
    settle = async (action) => {
      if (action === 'reject') return store.markRejected(id, OWNER, REASON);
      await store.claimForApproval(id, OWNER);
      return store.finalizeApproval(id, OWNER, `sha256:${'b'.repeat(64)}`);
    };
  } else throw new Error(`No real decision receipt fixture for catalog producer ${producerId}`);
  const mod = await import(`../../dist/domains/approval-hub/adapters/${producerId}ApprovalAdapter.js`);
  return {
    id,
    adapter: new mod[`${producerId}ApprovalAdapter`](store),
    settle,
    expectedDecisionTimes: producerId === 'F276' ? { approve: 150, reject: 200 } : undefined,
  };
}
