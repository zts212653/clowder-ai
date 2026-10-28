import type {
  CollectiveAccountabilityAttentionItem,
  RichInteractiveBlock,
  RuntimeInteractionRecord,
  UnifiedAttentionItemV1,
  UnifiedAttentionReadV1,
  UnifiedAttentionVisibleApproval,
} from '@cat-cafe/shared';
import { collectiveAccountabilityAttentionItemSchema, collectiveProjectAttentionItemSchema } from '@cat-cafe/shared';
import type { CollectiveAccountabilityAttentionSourceRead } from './companion-collective-accountability-source.js';
import { projectDecisionItems } from './companion-decision-items.js';
import { type DecisionPersonalViewInput, selectDecisionPersonalItems } from './companion-decision-personal-view.js';
import {
  approvalsSourceSchema,
  assertDecisionOwner,
  type DecisionSourceRead,
  needsMeSourceSchema,
} from './companion-decision-sources.js';
import { type OriginalApprovalCardRead, originalApprovalCardKey } from './companion-original-approval-cards.js';
import { mergeStructuredChoices } from './companion-structured-choices.js';
import type { UserMentionTodoRead } from './user-mention-todo-projection.js';

type ProjectionSourceReads = {
  approvals: DecisionSourceRead;
  needsMe: DecisionSourceRead;
  structuredChoices?: DecisionSourceRead;
};

function projectionSources(
  sourceReads: ProjectionSourceReads | undefined,
  userMentions: UserMentionTodoRead | undefined,
  observedAt: number,
  approvalCoverage: 'complete' | 'partial' | 'unknown' | undefined,
  needsMeCoverage: 'complete' | 'partial' | 'unknown' | undefined,
  collectiveAccountability: CollectiveAccountabilityAttentionSourceRead | undefined,
) {
  const base =
    sourceReads ??
    ({
      approvals: sourceRead('all_registered_F246_producers', observedAt, approvalCoverage),
      needsMe: sourceRead('current_linked_F310_five_producers', observedAt, needsMeCoverage),
    } satisfies ProjectionSourceReads);
  return {
    ...base,
    ...(collectiveAccountability ? { collectiveAccountabilityRequests: collectiveAccountability.state } : {}),
    ...(collectiveAccountability?.projectRead
      ? { collectiveProjectAttention: collectiveAccountability.projectRead.state }
      : {}),
    ...(userMentions ? { userMentions: userMentions.state } : {}),
  };
}

function exactCountFields(input: {
  complete: boolean;
  consistent: boolean;
  totalCount: number;
  decisionQualifiedCount: number;
  hasStructuredChoices: boolean;
}) {
  if (!input.complete || !input.consistent) return {};
  return {
    totalCount: input.totalCount,
    ...(input.hasStructuredChoices ? { attentionCount: input.decisionQualifiedCount } : {}),
  };
}

function sourceRead(
  coverage: DecisionSourceRead['coverage'],
  observedAt: number,
  exhaustiveness: DecisionSourceRead['exhaustiveness'] = 'unknown',
): DecisionSourceRead {
  return { status: 'available', startedAt: observedAt, observedAt, coverage, exhaustiveness };
}

function summarizeSources(sources: Record<string, DecisionSourceRead>, reasons: string[]) {
  const sourceStates = Object.values(sources);
  const availableSources = sourceStates.filter((source) => source.status === 'available').length;
  const complete =
    availableSources === sourceStates.length && sourceStates.every((source) => source.exhaustiveness === 'complete');
  return {
    sourceStates,
    complete,
    consistent: reasons.length === 0,
    status: complete ? ('available' as const) : availableSources ? ('partial' as const) : ('unavailable' as const),
  };
}

function legacyVectors(selectedItems: UnifiedAttentionItemV1[]) {
  const approvalItems = selectedItems.filter(
    (item): item is UnifiedAttentionItemV1 & { approval: UnifiedAttentionVisibleApproval } =>
      item.approval !== undefined,
  );
  const otherByTask = new Map<
    string,
    {
      ownerRead: UnifiedAttentionItemV1['linkedNeedsMe'][number]['ownerRead'];
      receipts: UnifiedAttentionItemV1['linkedNeedsMe'][number]['receipt'][];
    }
  >();
  for (const item of selectedItems) {
    if (item.approval) continue;
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
  return { approvalItems, otherNeedsMe };
}

function collectiveAccountabilityItems(
  source: CollectiveAccountabilityAttentionSourceRead | undefined,
  reasons: Set<string>,
): UnifiedAttentionItemV1[] {
  if (!source) return [];
  for (const reason of source.reasons) reasons.add(reason);
  const items: UnifiedAttentionItemV1[] = [];
  const seen = new Set<string>();
  for (const candidate of source.items) {
    const parsed = collectiveAccountabilityAttentionItemSchema.safeParse(candidate);
    if (!parsed.success) {
      reasons.add('collective_accountability_item_invalid');
      continue;
    }
    const request: CollectiveAccountabilityAttentionItem = parsed.data;
    const decisionRef = `${request.producerId}:${request.subjectRef}`;
    if (seen.has(decisionRef)) {
      reasons.add('collective_accountability_identity_conflict');
      continue;
    }
    seen.add(decisionRef);
    items.push({
      decisionRef,
      kind: 'judgment',
      summary: `${request.requestedByDisplayName} 邀请你负责「${request.workTitle}」 · ${request.projectTitle}`,
      collectiveAccountabilityRequest: request,
      linkedNeedsMe: [],
    });
  }
  if (source.projectRead) {
    for (const reason of source.projectRead.reasons) reasons.add(reason);
    for (const candidate of source.projectRead.items) {
      const parsed = collectiveProjectAttentionItemSchema.safeParse(candidate);
      if (!parsed.success) {
        reasons.add('collective_project_attention_invalid');
        continue;
      }
      const value = parsed.data,
        decisionRef = `${value.producerId}:${value.subjectRef}`;
      if (seen.has(decisionRef)) {
        reasons.add('collective_project_attention_identity_conflict');
        continue;
      }
      seen.add(decisionRef);
      const summary =
        value.kind === 'triage'
          ? `${value.projectTitle} 来了 ${value.count} 份外部材料 · 去分拣`
          : value.kind === 'date_suggestion'
            ? `${value.workTitle} 有 ${value.count} 条日期建议 · 等你确认`
            : `${value.workTitle} 已超过截止 · 改日期或去看看`;
      items.push({ decisionRef, kind: 'judgment', summary, collectiveProjectAttention: value, linkedNeedsMe: [] });
    }
  }
  return items;
}

function attachOriginalApprovalCards(
  items: UnifiedAttentionItemV1[],
  originalApprovalCards: OriginalApprovalCardRead | undefined,
) {
  if (!originalApprovalCards) return;
  for (const item of items) {
    if (!item.approval) continue;
    const proof = originalApprovalCards.proofs.get(originalApprovalCardKey(item.approval));
    if (proof) item.originalApprovalCard = proof;
  }
}

export function projectCompanionDecisions(
  approvalsSource: unknown,
  needsMeSource: unknown,
  userId: string,
  page: { offset: number; limit: number },
  observedAt: number,
  sourceReads?: ProjectionSourceReads,
  userMentions?: UserMentionTodoRead,
  structuredChoices: RuntimeInteractionRecord[] = [],
  personal?: DecisionPersonalViewInput,
  originalApprovalCards?: OriginalApprovalCardRead,
  conversationPresentations?: ReadonlyMap<string, RichInteractiveBlock>,
  collectiveAccountability?: CollectiveAccountabilityAttentionSourceRead,
) {
  const approvalRead = approvalsSourceSchema.parse(approvalsSource);
  const workRead = needsMeSourceSchema.parse(needsMeSource);
  const approvals = approvalRead.items;
  const needsMe = workRead.ownerReads;
  assertDecisionOwner(approvals, needsMe, userId);
  const unified = projectDecisionItems(approvals, needsMe);
  const reasons = new Set([...unified.reasons, ...(originalApprovalCards?.reasons ?? [])]);
  unified.items.push(...collectiveAccountabilityItems(collectiveAccountability, reasons));
  attachOriginalApprovalCards(unified.items, originalApprovalCards);
  mergeStructuredChoices(unified.items, structuredChoices, reasons, userId, conversationPresentations);
  const canonicalDecisionItems = unified.items;
  const personalProjection = selectDecisionPersonalItems({
    canonicalItems: canonicalDecisionItems,
    reasons,
    userMentions,
    userId,
    personal,
  });
  unified.reasons = [...reasons];
  const sources = {
    ...projectionSources(
      sourceReads,
      userMentions,
      observedAt,
      approvalRead.coverage?.state,
      workRead.coverage?.state,
      collectiveAccountability,
    ),
    ...(personal ? { personalPreferences: personal.state } : {}),
  };
  const { sourceStates, complete, consistent, status } = summarizeSources(sources, unified.reasons);
  const exact = complete && consistent;
  const selectedItems = personalProjection.pageItems;
  const { approvalItems, otherNeedsMe } = legacyVectors(selectedItems);
  return {
    version: 1 as const,
    status,
    identity: { ownerUserId: userId },
    sources,
    readWindow: {
      startedAt: Math.min(...sourceStates.map((source) => source.startedAt)),
      endedAt: Math.max(...sourceStates.map((source) => source.observedAt)),
      consistency: 'independent_source_reads' as const,
    },
    consistency: { state: consistent ? ('verified' as const) : ('uncertain' as const), reasons: unified.reasons },
    items: selectedItems.slice(page.offset, page.offset + page.limit),
    ...exactCountFields({
      complete,
      consistent,
      totalCount: selectedItems.length,
      decisionQualifiedCount: personalProjection.attentionItems.length,
      hasStructuredChoices: sources.structuredChoices !== undefined,
    }),
    ...(userMentions?.counts
      ? {
          ...(exact ? { mentionCounts: userMentions.counts } : {}),
          mentionPeriod: userMentions.period,
        }
      : {}),
    ...(personalProjection.view
      ? {
          personalView: {
            ...personalProjection.view,
            ...(exact ? personalProjection.counts : {}),
          },
        }
      : {}),
    scope: 'owner_all_projects' as const,
    observedAt,
    approvalCoverage: 'all_registered_F246_producers' as const,
    needsMeCoverage: 'current_linked_F310_five_producers' as const,
    ...(exact ? { approvalCount: approvalItems.length } : {}),
    ...(exact
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
      hasMore: page.offset + page.limit < selectedItems.length,
      hasMoreApprovals: page.offset + page.limit < approvalItems.length,
      hasMoreNeedsMe: page.offset + page.limit < otherNeedsMe.length,
    },
  } satisfies UnifiedAttentionReadV1;
}
