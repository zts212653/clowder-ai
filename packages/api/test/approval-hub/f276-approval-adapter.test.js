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
});
