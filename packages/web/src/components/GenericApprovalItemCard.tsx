'use client';

import type { ApprovalHubItem } from '@cat-cafe/shared';
import { useMemo } from 'react';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import { approvalOriginThreadId } from '@/lib/approval-navigation';
import {
  approvalDisplayTitle,
  approvalLifecyclePresentation,
  formatApprovalAbsoluteTime,
  formatApprovalRelativeTime,
} from '@/lib/approval-presentation';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import type { Thread } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ApprovalDecisionCard, type ApprovalDecisionDetails } from './ApprovalDecisionCard';
import { ApprovalFeatureBadge } from './ApprovalFeatureBadge';
import { ApprovalTechnicalDetailContent } from './ApprovalTechnicalDetails';
import { GenericApprovalDecisionActions } from './GenericApprovalDecisionActions';
import { GenericApprovalRecommendation } from './GenericApprovalRecommendation';
import { MailboxApprovalExplanation } from './shell/mailbox/MailboxApprovalExplanation';
import { useApprovalItemActions } from './useApprovalItemActions';

export function GenericApprovalItemCard({ item }: { item: ApprovalHubItem }) {
  const close = useApprovalHubStore((state) => state.close);
  const resolveCatName = useCatNameResolver();
  const rawThreads = useChatStore((state) => state.threads as Thread[] | unknown);
  const threads = useMemo<Thread[]>(() => (Array.isArray(rawThreads) ? rawThreads : []), [rawThreads]);
  const f193TargetThreadId = item.sourceFeatureId === 'F193' ? String(item.detail.targetThreadId ?? '') : '';
  const sourceThreadId = approvalOriginThreadId(item.navigation) ?? '来源未知';
  const sourceThreadTitle = useMemo(
    () => threads.find((thread) => thread.id === sourceThreadId)?.title ?? sourceThreadId,
    [threads, sourceThreadId],
  );
  const targetThreadTitle = useMemo(
    () =>
      f193TargetThreadId
        ? (threads.find((thread) => thread.id === f193TargetThreadId)?.title ?? f193TargetThreadId)
        : null,
    [threads, f193TargetThreadId],
  );

  const {
    isStale,
    isPersonMemoryClaimSelect,
    decidingState,
    entityConflict,
    handleApprove,
    handleReject,
    handleEntityResolution,
    presentation,
    feedbackDialog,
  } = useApprovalItemActions(item);

  const f225HandoffDetails =
    item.sourceFeatureId === 'F225'
      ? formatDetailLines([
          ['Done', item.detail.done],
          ['Next', item.detail.nextSteps],
        ])
      : undefined;
  const f221TasteEvidence =
    item.sourceFeatureId === 'F221'
      ? formatDetailLines([
          ['猫的判断（假设）', item.detail.takeaway],
          ['场景', item.detail.scene],
          ['引用', item.detail.quote],
        ])
      : undefined;
  const hasRecommendation = ['F128', 'F221', 'F225', 'F193', 'F260'].includes(item.sourceFeatureId);

  const header = (
    <div className="flex items-center gap-2 text-micro">
      <ApprovalFeatureBadge featureId={item.sourceFeatureId} testId="approval-feature-badge" />
      {isStale && <StatusBadge testId="stale-badge">已过期</StatusBadge>}
      <ApprovalLifecycleBadge item={item} />
      <span className="ml-auto opacity-60" title={`发起于 ${formatApprovalAbsoluteTime(item.createdAt)}`}>
        发起于 {formatApprovalRelativeTime(item.createdAt)}
      </span>
    </div>
  );

  const recommendation = hasRecommendation ? (
    <GenericApprovalRecommendation
      item={item}
      f221TasteEvidence={f221TasteEvidence}
      f225HandoffDetails={f225HandoffDetails}
      f193TargetThreadId={f193TargetThreadId}
      sourceThreadTitle={sourceThreadTitle}
      targetThreadTitle={targetThreadTitle}
      resolveCatName={resolveCatName}
    />
  ) : undefined;

  const currentDecision = (
    <GenericApprovalDecisionActions
      item={item}
      isStale={isStale}
      isPersonMemoryClaimSelect={isPersonMemoryClaimSelect}
      entityConflict={entityConflict}
      decidingState={decidingState}
      onApprove={handleApprove}
      onReject={handleReject}
      onEntityResolution={handleEntityResolution}
      onBeforeNavigate={close}
    />
  );

  return (
    <>
      <ApprovalDecisionCard
        testId={`approval-item-${item.proposalId}`}
        embedded={presentation === 'mailbox'}
        header={header}
        title={approvalDisplayTitle(item, { resolveCatName })}
        actionReason={
          item.resolution === 'open' ? (
            <>由 {resolveCatName(item.requesterCatId)} 发起，需要你作出决定。</>
          ) : (
            <>审批决议已记录；后续状态只认 canonical owner receipt。</>
          )
        }
        recommendation={presentation === 'mailbox' ? <MailboxApprovalExplanation item={item} /> : recommendation}
        currentDecision={currentDecision}
        details={approvalDetailDisclosure(item.detail)}
      />
      {feedbackDialog}
    </>
  );
}

function ApprovalLifecycleBadge({ item }: { item: ApprovalHubItem }) {
  if (item.resolution === 'open') return null;
  return <StatusBadge testId="approval-lifecycle-badge">{approvalLifecyclePresentation(item).label}</StatusBadge>;
}

function approvalDetailDisclosure(detail: Record<string, unknown>): ApprovalDecisionDetails | undefined {
  if (Object.keys(detail).length === 0) return undefined;
  return {
    label: '查看技术详情',
    expandedLabel: '收起技术详情',
    testId: 'approval-item-technical-details',
    content: <ApprovalTechnicalDetailContent detail={detail} />,
  };
}

function StatusBadge({ children, testId }: { children: string; testId?: string }) {
  return (
    <span
      className="rounded-md bg-[var(--semantic-warning)] px-1.5 py-0.5 font-medium text-[var(--cafe-accent-foreground)]"
      data-testid={testId}
    >
      {children}
    </span>
  );
}

function formatDetailLines(entries: ReadonlyArray<readonly [label: string, value: unknown]>): string | undefined {
  const lines = entries.flatMap(([label, value]) => (value == null ? [] : [`${label}: ${String(value)}`]));
  return lines.length > 0 ? lines.join('\n') : undefined;
}
