import type { UnifiedAttentionItemV1, UnifiedAttentionReadV1, UnifiedAttentionVisibleApproval } from '@cat-cafe/shared';
import { projectDecisionItems } from './companion-decision-items.js';
import {
  approvalsSourceSchema,
  assertDecisionOwner,
  type DecisionSourceRead,
  needsMeSourceSchema,
} from './companion-decision-sources.js';

function sourceRead(
  coverage: DecisionSourceRead['coverage'],
  observedAt: number,
  exhaustiveness: DecisionSourceRead['exhaustiveness'] = 'unknown',
): DecisionSourceRead {
  return { status: 'available', startedAt: observedAt, observedAt, coverage, exhaustiveness };
}

export function projectCompanionDecisions(
  approvalsSource: unknown,
  needsMeSource: unknown,
  userId: string,
  page: { offset: number; limit: number },
  observedAt: number,
  sourceReads?: { approvals: DecisionSourceRead; needsMe: DecisionSourceRead },
) {
  const approvalRead = approvalsSourceSchema.parse(approvalsSource);
  const workRead = needsMeSourceSchema.parse(needsMeSource);
  const approvals = approvalRead.items;
  const needsMe = workRead.ownerReads;
  assertDecisionOwner(approvals, needsMe, userId);
  const unified = projectDecisionItems(approvals, needsMe);
  const sources = sourceReads ?? {
    approvals: sourceRead('all_registered_F246_producers', observedAt, approvalRead.coverage?.state),
    needsMe: sourceRead('current_linked_F310_five_producers', observedAt, workRead.coverage?.state),
  };
  const availableSources = Object.values(sources).filter((source) => source.status === 'available').length;
  const complete =
    availableSources === 2 && Object.values(sources).every((source) => source.exhaustiveness === 'complete');
  const consistent = unified.reasons.length === 0;
  const approvalItems = unified.items.filter(
    (item): item is UnifiedAttentionItemV1 & { approval: UnifiedAttentionVisibleApproval } =>
      item.approval !== undefined,
  );
  const otherByTask = new Map<
    string,
    { ownerRead: (typeof needsMe)[number]; receipts: (typeof needsMe)[number]['attentionReceipts'] }
  >();
  for (const item of unified.items.filter((item) => !item.approval)) {
    for (const linked of item.linkedNeedsMe) {
      const key = linked.ownerRead.envelope.subjectRef;
      const group = otherByTask.get(key) ?? { ownerRead: linked.ownerRead, receipts: [] };
      group.receipts.push(linked.receipt);
      otherByTask.set(key, group);
    }
  }
  const otherNeedsMe = [...otherByTask.values()].map(({ ownerRead, receipts }) => ({
    ...ownerRead,
    attentionReceipts: receipts,
  }));
  return {
    version: 1 as const,
    status: (complete ? 'available' : availableSources ? 'partial' : 'unavailable') as
      | 'available'
      | 'partial'
      | 'unavailable',
    identity: { ownerUserId: userId },
    sources,
    readWindow: {
      startedAt: Math.min(sources.approvals.startedAt, sources.needsMe.startedAt),
      endedAt: Math.max(sources.approvals.observedAt, sources.needsMe.observedAt),
      consistency: 'independent_source_reads' as const,
    },
    consistency: { state: consistent ? ('verified' as const) : ('uncertain' as const), reasons: unified.reasons },
    items: unified.items.slice(page.offset, page.offset + page.limit),
    ...(complete && consistent ? { totalCount: unified.items.length } : {}),
    scope: 'owner_all_projects' as const,
    observedAt,
    approvalCoverage: 'all_registered_F246_producers' as const,
    needsMeCoverage: 'current_linked_F310_five_producers' as const,
    ...(sources.approvals.status === 'available' ? { approvalCount: approvalItems.length } : {}),
    ...(sources.needsMe.status === 'available'
      ? {
          needsMeCount: new Set(needsMe.map((read) => read.envelope.subjectRef)).size,
          otherNeedsMeCount: otherNeedsMe.length,
        }
      : {}),
    approvals: approvalItems.slice(page.offset, page.offset + page.limit).map((item) => ({
      ...item.approval,
      ...(item.linkedNeedsMe[0] ? { linkedNeedsMe: item.linkedNeedsMe[0].ownerRead } : {}),
    })),
    otherNeedsMe: otherNeedsMe.slice(page.offset, page.offset + page.limit),
    page: {
      ...page,
      scope: 'known_rows' as const,
      hasMore: page.offset + page.limit < unified.items.length,
      hasMoreApprovals: page.offset + page.limit < approvalItems.length,
      hasMoreNeedsMe: page.offset + page.limit < otherNeedsMe.length,
    },
  } satisfies UnifiedAttentionReadV1;
}
