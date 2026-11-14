import type { ApprovalHubItem, RichCardBlock, UnifiedAttentionReadV1 } from '@cat-cafe/shared';

export function memoryGroupPreviewFixture(count: 1 | 4 = 4) {
  const when = Date.UTC(2026, 10, 11, 10);
  const original: RichCardBlock = {
    kind: 'card',
    v: 1,
    id: 'entity-proposal-p-1',
    title: '合成实体提案',
    bodyMarkdown: '这条内容用于界面验证。',
    meta: { approval: { producerId: 'F260', canonicalProposalId: 'p-1' } },
  };
  const item: ApprovalHubItem = {
    ownerUserId: 'owner-1',
    proposalId: 'p-1',
    sourceFeatureId: 'F260',
    requesterCatId: 'codex61-sol',
    createdAt: when,
    resolution: 'open',
    materialization: { state: 'not_started' },
    inlineApprovable: true,
    summary: '减少无意义打断的提醒',
    navigation: {
      state: 'anchored',
      originRef: { kind: 'message', threadId: 'group-preview', messageId: 'origin' },
      approvalCardRef: { threadId: 'group-preview', messageId: 'original-message' },
    },
    detail: {
      entityType: 'concept',
      entityId: 'concept:guardrail',
      canonicalName: '护栏',
      stance: 'endorsed',
      aliases: ['提醒边界'],
      rationale: '减少无意义的打断，保留真正需要确认的地方。',
    },
  };
  const groupId = count === 1 ? 'remember-preview-single' : 'remember-preview';
  const group: RichCardBlock = {
    kind: 'card',
    v: 1,
    id: groupId,
    title: '这次记下的内容',
    meta: {
      kind: 'memory_group',
      memoryGroup: {
        v: 1,
        groupId,
        rows: [
          {
            itemId: 'entity',
            target: 'entity',
            statusCode: 200,
            proposalId: 'p-1',
            messageId: 'original-message',
            status: 'pending',
          },
          { itemId: 'matter', target: 'matter', statusCode: 200, resultRef: 'matter-preview', status: 'updated' },
          { itemId: 'abstain', target: 'person_abstain', statusCode: 200, status: 'abstained' },
          { itemId: 'refused', target: 'taste', statusCode: 422, error: '原来源不符合要求，这一项没有提交。' },
        ].slice(0, count),
      },
    },
  };
  const source = {
    status: 'available' as const,
    startedAt: 1,
    observedAt: 2,
    coverage: 'all_registered_F246_producers' as const,
    exhaustiveness: 'complete' as const,
  };
  const { ownerUserId, ...visible } = item;
  const unified: UnifiedAttentionReadV1 = {
    version: 1,
    status: 'available',
    scope: 'owner_all_projects',
    identity: { ownerUserId },
    observedAt: 2,
    sources: { approvals: source, needsMe: { ...source, coverage: 'current_linked_F310_five_producers' } },
    readWindow: { startedAt: 1, endedAt: 2, consistency: 'independent_source_reads' },
    consistency: { state: 'verified', reasons: [] },
    items: [
      {
        kind: 'approval',
        decisionRef: 'approval:p-1',
        summary: item.summary,
        linkedNeedsMe: [],
        approval: visible,
        originalApprovalCard: {
          cardRef: { threadId: 'group-preview', messageId: 'original-message', blockId: original.id },
          block: original,
        },
      },
    ],
    totalCount: 1,
    page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: false },
  };
  const message = {
    id: 'original-message',
    threadId: 'group-preview',
    timestamp: when,
    catId: 'codex61-sol',
    userId: 'owner-1',
    extra: { rich: { v: 1, blocks: [original] } },
  };
  return { group, original, item, unified, message };
}
