'use client';

import type {
  ApprovalItem,
  EntityConflictContext,
  EntityConflictResolutionRequest,
  HumanDispositionFeedbackInput,
} from '@cat-cafe/shared';
import { useCallback, useMemo, useState } from 'react';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import { approvalFeatureMeta } from '@/lib/approval-features';
import { approvalOriginThreadId } from '@/lib/approval-navigation';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import type { Thread } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { ApprovalDecisionCard } from './ApprovalDecisionCard';
import { GenericApprovalDecisionActions } from './GenericApprovalDecisionActions';
import { GenericApprovalRecommendation } from './GenericApprovalRecommendation';
import { HumanDispositionFeedbackDialog } from './HumanDispositionFeedbackDialog';

export function GenericApprovalItemCard({ item }: { item: ApprovalItem }) {
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

  const isStale = useMemo(() => item.expiresAt != null && item.expiresAt < Date.now(), [item.expiresAt]);
  const isResumeOnly = item.decisionMode === 'resume-only';
  const isPersonMemoryClaimSelect = item.sourceFeatureId === 'F276' && item.decisionMode === 'claim-select';
  const approveProposal = useApprovalHubStore((state) => state.approveProposal);
  const rejectProposal = useApprovalHubStore((state) => state.rejectProposal);
  const decisionError = useApprovalHubStore((state) => state.error);
  const resolveEntityConflict = useApprovalHubStore((state) => state.resolveEntityConflict);
  const decidingState = useApprovalHubStore((state) => state.deciding[item.proposalId]);
  const entityConflict =
    item.sourceFeatureId === 'F260' && isEntityConflictContext(item.detail.conflict) ? item.detail.conflict : undefined;
  const featureMeta = approvalFeatureMeta(item.sourceFeatureId);
  const feedbackReasonCodes = featureMeta.humanDispositionReasonCodes;
  const usesFeedbackDialog = !isStale && feedbackReasonCodes !== null;

  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false);
  const [feedbackDialogError, setFeedbackDialogError] = useState<string | null>(null);
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);

  const handleApprove = useCallback(() => {
    void approveProposal(item.proposalId);
  }, [approveProposal, item.proposalId]);

  const handleReject = useCallback(() => {
    if (usesFeedbackDialog) {
      setFeedbackDialogError(null);
      setFeedbackSubmitted(false);
      setFeedbackDialogOpen(true);
      return;
    }
    void rejectProposal(item.proposalId);
  }, [item.proposalId, rejectProposal, usesFeedbackDialog]);

  const handleEntityResolution = useCallback(
    (resolution: EntityConflictResolutionRequest) => {
      void resolveEntityConflict(item.proposalId, resolution);
    },
    [item.proposalId, resolveEntityConflict],
  );

  const submitReject = useCallback(
    async (feedback: HumanDispositionFeedbackInput | undefined) => {
      setFeedbackSubmitted(true);
      setFeedbackDialogError(null);
      const success = await rejectProposal(item.proposalId, feedback);
      if (success) {
        setFeedbackDialogOpen(false);
        setFeedbackSubmitted(false);
        return;
      }
      setFeedbackDialogError('拒绝失败，请检查提案状态后重试。');
    },
    [item.proposalId, rejectProposal],
  );

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
          ['场景', item.detail.scene],
          ['引用', item.detail.quote],
        ])
      : undefined;
  const hasRecommendation = ['F128', 'F221', 'F225', 'F193', 'F260'].includes(item.sourceFeatureId);

  const header = (
    <div className="flex items-center gap-2 text-micro">
      <span
        className="rounded-md px-1.5 py-0.5 font-medium"
        style={{ backgroundColor: featureMeta.color, color: 'var(--cafe-accent-foreground)' }}
      >
        {featureMeta.badgeLabel}
      </span>
      {isStale && <StatusBadge testId="stale-badge">已过期</StatusBadge>}
      {isResumeOnly && <StatusBadge testId="recovery-badge">待恢复</StatusBadge>}
      <span className="ml-auto opacity-60">{formatAge(item.createdAt)}</span>
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
      isResumeOnly={isResumeOnly}
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
        header={header}
        title={item.summary}
        actionReason={<>由 {resolveCatName(item.requesterCatId)} 发起，需要你作出决定。</>}
        recommendation={recommendation}
        currentDecision={currentDecision}
      />
      {feedbackReasonCodes && (
        <HumanDispositionFeedbackDialog
          open={feedbackDialogOpen}
          reasonCodes={feedbackReasonCodes}
          subjectLabel={item.summary}
          submitting={decidingState === 'rejecting'}
          error={feedbackSubmitted ? (feedbackDialogError ?? decisionError) : null}
          onCancel={() => {
            setFeedbackDialogOpen(false);
            setFeedbackDialogError(null);
            setFeedbackSubmitted(false);
          }}
          onSubmit={(feedback) => void submitReject(feedback)}
        />
      )}
    </>
  );
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

function formatAge(createdAt: number): string {
  const diffMs = Date.now() - createdAt;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatDetailLines(entries: ReadonlyArray<readonly [label: string, value: unknown]>): string | undefined {
  const lines = entries.flatMap(([label, value]) => (value == null ? [] : [`${label}: ${String(value)}`]));
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function isEntityConflictContext(value: unknown): value is EntityConflictContext {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<EntityConflictContext>;
  return (
    candidate.version === 1 &&
    (candidate.reason === 'existing-entity-change' || candidate.reason === 'surface-collision') &&
    typeof candidate.fingerprint === 'string' &&
    typeof candidate.incoming === 'object' &&
    Array.isArray(candidate.candidates) &&
    Array.isArray(candidate.allowedActions)
  );
}
