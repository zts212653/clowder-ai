import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('F276ApprovalAdapter', () => {
  let F276ApprovalAdapter;

  beforeEach(async () => {
    ({ F276ApprovalAdapter } = await import('../../dist/domains/approval-hub/adapters/F276ApprovalAdapter.js'));
  });

  it('projects a complete event narrative with ordered drillable sources', async () => {
    const interactionDraft = {
      draftId: 'person_draft_event',
      normalizedDraft: '与黄挺线下见面约两小时，讨论终端用户计算；日期待确认',
      sourceRole: 'owner_explicit',
      evidenceExcerpt: '线下见了大约两个小时',
      payload: {
        eventKind: 'meeting',
        headline: '与黄挺线下见面并讨论终端用户计算',
        occurredAt: {
          kind: 'conflict',
          raw: '7 月 23 日（周三）',
          alternatives: [
            { label: 'explicit_date', value: '2026-07-23' },
            { label: 'weekday_resolution', value: '2026-07-22' },
          ],
        },
        duration: {
          kind: 'approximate',
          raw: '大约两个小时',
          qualifier: 'about',
        },
        importanceOrTopic: '交流终端用户计算方向，也让双方关系更具体',
        uncertaintyNotes: ['日期与星期存在冲突'],
      },
      sourceEvidence: [
        {
          sourceRef: { kind: 'message', threadId: 'thread_people', messageId: 'msg_event_1' },
          evidenceExcerpt: '线下见了大约两个小时',
          supports: ['eventKind', 'headline', 'occurredAt', 'duration'],
        },
        {
          sourceRef: { kind: 'message', threadId: 'thread_people', messageId: 'msg_event_2' },
          evidenceExcerpt: '聊了终端用户计算，这次见面对我挺重要，但日期和星期冲突',
          supports: ['importanceOrTopic', 'uncertaintyNotes'],
        },
      ],
      decision: 'pending',
    };
    const candidate = {
      candidateId: 'person_candidate_1',
      ownerUserId: 'owner-1',
      requesterCatId: 'codex-sol',
      sourceMessageRef: { kind: 'message', threadId: 'thread_people', messageId: 'msg_intent' },
      personDraft: { displayName: '黄挺', privateAliases: ['黄挺'] },
      claimDrafts: [],
      interactionDraft,
      sourceBundle: {
        sources: interactionDraft.sourceEvidence.map((evidence, index) => ({
          sourceId: `event-source-${index}`,
          kind: 'message_text',
          sourceRef: evidence.sourceRef,
          ownerUserId: 'owner-1',
          resolvedDigest: `${index + 1}`.repeat(64),
          excerpt: evidence.evidenceExcerpt,
        })),
        assertionBindings: interactionDraft.sourceEvidence.flatMap((evidence, index) =>
          evidence.supports.map((field) => ({
            sourceId: `event-source-${index}`,
            target: { kind: 'interaction', draftId: interactionDraft.draftId, field },
            role: field === 'importanceOrTopic' || field === 'uncertaintyNotes' ? 'user_assessment' : 'reported_fact',
          })),
        ),
      },
      replacesProposalId: 'person_candidate_previous',
      remainingDraftIds: [interactionDraft.draftId],
      retention: 'owner_controlled_no_ttl',
      createdAt: 100,
      state: 'pending_approval',
      publication: {
        state: 'anchored',
        envelope: {
          canonicalProposalId: 'person_candidate_1',
          sourceFeatureId: 'F276',
          ownerUserId: 'owner-1',
          requesterCatId: 'codex-sol',
          originRef: { kind: 'message', threadId: 'thread_people', messageId: 'msg_intent' },
          approvalCardRef: { threadId: 'thread_people', messageId: 'msg_card' },
          createdAt: 100,
        },
      },
    };
    const store = {
      async listPending(ownerUserId) {
        return ownerUserId === 'owner-1' ? [candidate] : [];
      },
    };

    const [item] = await new F276ApprovalAdapter(store).listPending('owner-1');
    const [draft] = item.detail.drafts;

    assert.equal(item.inlineApprovable, true);
    assert.equal(item.decisionMode, 'claim-select');
    assert.equal(item.detail.displayName, '黄挺');
    assert.equal(item.detail.replacesProposalId, 'person_candidate_previous');
    assert.deepEqual(draft.event, {
      ...interactionDraft.payload,
      sourceEvidence: interactionDraft.sourceEvidence,
    });
    assert.equal(draft.event.sourceEvidence[0].sourceRef.messageId, 'msg_event_1');
    assert.equal(draft.event.sourceEvidence[1].sourceRef.messageId, 'msg_event_2');
    assert.notEqual(draft.event.sourceEvidence[0].sourceRef.messageId, 'msg_intent');
    assert.deepEqual(
      draft.typedEvidence.map(({ sourceKind, assertionRole }) => ({ sourceKind, assertionRole })),
      [
        { sourceKind: 'message_text', assertionRole: 'reported_fact' },
        { sourceKind: 'message_text', assertionRole: 'reported_fact' },
        { sourceKind: 'message_text', assertionRole: 'reported_fact' },
        { sourceKind: 'message_text', assertionRole: 'reported_fact' },
        { sourceKind: 'message_text', assertionRole: 'user_assessment' },
        { sourceKind: 'message_text', assertionRole: 'user_assessment' },
      ],
    );
    assert.deepEqual(draft.informedEvidence, [
      {
        sourceId: 'event-source-0',
        sourceKind: 'message_text',
        assertionRoles: ['reported_fact'],
        targetFields: ['eventKind', 'headline', 'occurredAt', 'duration'],
        boundedExcerpt: '线下见了大约两个小时',
        drillSourceRef: { kind: 'message', threadId: 'thread_people', messageId: 'msg_event_1' },
      },
      {
        sourceId: 'event-source-1',
        sourceKind: 'message_text',
        assertionRoles: ['user_assessment'],
        targetFields: ['importanceOrTopic', 'uncertaintyNotes'],
        boundedExcerpt: '聊了终端用户计算，这次见面对我挺重要，但日期和星期冲突',
        drillSourceRef: { kind: 'message', threadId: 'thread_people', messageId: 'msg_event_2' },
      },
    ]);
  });

  it('projects a materialized person into privacy-safe settled history', async () => {
    const candidate = {
      candidateId: 'person_candidate_wu_lang',
      ownerUserId: 'owner-1',
      requesterCatId: 'codex-sol',
      sourceMessageRef: { kind: 'message', threadId: 'thread_people', messageId: 'msg_intent' },
      claimDrafts: [],
      remainingDraftIds: [],
      retention: 'owner_controlled_no_ttl',
      createdAt: 100,
      state: 'materialized',
      materializedPersonId: 'person_wu_lang',
      latestDecisionReceipt: {
        decisionId: 'decision_wu_lang',
        candidateId: 'person_candidate_wu_lang',
        state: 'materialized',
        personId: 'person_wu_lang',
        selectedDraftIds: ['person_draft_claim'],
        materializedClaimIds: ['person_claim_wu_lang'],
        materializedRelationshipIds: ['person_relationship_wu_lang'],
        materializedEventIds: [],
        remainingDraftIds: [],
        decidedAt: 200,
      },
      publication: {
        state: 'anchored',
        envelope: {
          canonicalProposalId: 'person_candidate_wu_lang',
          sourceFeatureId: 'F276',
          ownerUserId: 'owner-1',
          requesterCatId: 'codex-sol',
          originRef: { kind: 'message', threadId: 'thread_people', messageId: 'msg_intent' },
          approvalCardRef: { threadId: 'thread_people', messageId: 'msg_card' },
          createdAt: 100,
        },
      },
    };
    const store = {
      async listSettled() {
        return [{ candidate, decidedAt: 200 }];
      },
      async getPerson() {
        return { personId: 'person_wu_lang', displayName: '吴浪' };
      },
    };

    const [item] = await new F276ApprovalAdapter(store).listSettled('owner-1');

    assert.equal(item.status, 'approved');
    assert.equal(item.summary, '记住人物：吴浪');
    assert.equal(item.decidedAt, 200);
    assert.equal(item.decidedBy, 'owner-1');
    assert.deepEqual(item.detail, {
      displayName: '吴浪',
      materialized: { claims: 1, relationships: 1, events: 0 },
    });
    assert.doesNotMatch(JSON.stringify(item), /evidenceExcerpt|sourceBundle|privateAliases/);
  });

  it('projects rejected history without resurrecting purged person drafts', async () => {
    const candidate = {
      candidateId: 'person_candidate_rejected',
      ownerUserId: 'owner-1',
      requesterCatId: 'codex-terra',
      sourceMessageRef: { kind: 'message', threadId: 'thread_people', messageId: 'msg_rejected' },
      claimDrafts: [],
      remainingDraftIds: [],
      retention: 'owner_controlled_no_ttl',
      createdAt: 300,
      state: 'rejected',
      latestDecisionId: 'decision_rejected',
      latestHumanDisposition: { reasonCode: 'not_important' },
      publication: {
        state: 'anchored',
        envelope: {
          canonicalProposalId: 'person_candidate_rejected',
          sourceFeatureId: 'F276',
          ownerUserId: 'owner-1',
          requesterCatId: 'codex-terra',
          originRef: { kind: 'message', threadId: 'thread_people', messageId: 'msg_rejected' },
          approvalCardRef: { threadId: 'thread_people', messageId: 'msg_rejected_card' },
          createdAt: 300,
        },
      },
    };
    const store = {
      async listSettled() {
        return [{ candidate, decidedAt: 400 }];
      },
      async getPerson() {
        throw new Error('rejected history must not resolve a person');
      },
    };

    const [item] = await new F276ApprovalAdapter(store).listSettled('owner-1');

    assert.equal(item.status, 'rejected');
    assert.equal(item.summary, '人物提案（内容已清除）');
    assert.deepEqual(item.detail, { dispositionReason: 'not_important' });
    assert.equal(item.decidedAt, 400);
  });
});
