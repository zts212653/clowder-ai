'use client';

/**
 * F246: Individual approval item card for the Approval Hub drawer.
 *
 * Phase A: F128/F225 cards use "jump to thread" for approve — F128 needs full
 * approve-time overrides which the Hub drawer doesn't provide (AC-A4 fallback).
 *
 * Phase B+: Any feature with inlineApprovable=true (F193 dispatch, F260 entity, ...)
 * gets inline approve buttons. The store routes each feature to its own endpoint
 * via resolveEndpoint() (F260 T0).
 *
 * Reject/dismiss: ALWAYS available regardless of inlineApprovable. Approve needs
 * context, reject doesn't — you're just dismissing the proposal. Stale items
 * show "清除" instead of "拒绝" to match dismissal intent (狗皮膏药 fix).
 *
 * Stale items (expiresAt < now) show an orange stale badge (AC-A6).
 */

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
import { ApprovalProvenanceLinks } from './ApprovalProvenanceLinks';
import { CriticalText } from './content-overflow';
import { EntityConflictResolutionPanel } from './EntityConflictResolutionPanel';
import { HumanDispositionFeedbackDialog } from './HumanDispositionFeedbackDialog';
import { PersonMemoryClaimSelector } from './PersonMemoryClaimSelector';

function formatAge(createdAt: number): string {
  const diffMs = Date.now() - createdAt;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDetailLines(entries: ReadonlyArray<readonly [label: string, value: unknown]>): string | undefined {
  const lines = entries.flatMap(([label, value]) => (value == null ? [] : [`${label}: ${String(value)}`]));
  return lines.length > 0 ? lines.join('\n') : undefined;
}
export function ApprovalItemCard({ item }: { item: ApprovalItem }) {
  const close = useApprovalHubStore((s) => s.close);
  const resolveCatName = useCatNameResolver();

  // Thread title lookup for F193 dispatch context (Bug 1 fix).
  // Called unconditionally (Rules of Hooks); value used only when sourceFeatureId === 'F193'.
  // Array.isArray guard: test mocks may return non-arrays; treat them as empty.
  const rawThreads = useChatStore((s) => s.threads as Thread[] | unknown);
  const threads: Thread[] = useMemo(() => (Array.isArray(rawThreads) ? rawThreads : []), [rawThreads]);
  const f193TargetThreadId = item.sourceFeatureId === 'F193' ? String(item.detail.targetThreadId ?? '') : '';
  const sourceThreadId = approvalOriginThreadId(item.navigation) ?? '来源未知';
  const sourceThreadTitle = useMemo(
    () => threads.find((t) => t.id === sourceThreadId)?.title ?? sourceThreadId,
    [threads, sourceThreadId],
  );
  const targetThreadTitle = useMemo(
    () => (f193TargetThreadId ? (threads.find((t) => t.id === f193TargetThreadId)?.title ?? f193TargetThreadId) : null),
    [threads, f193TargetThreadId],
  );

  const isStale = useMemo(() => item.expiresAt != null && item.expiresAt < Date.now(), [item.expiresAt]);
  const isResumeOnly = item.decisionMode === 'resume-only';
  const isPersonMemoryClaimSelect = item.sourceFeatureId === 'F276' && item.decisionMode === 'claim-select';

  const approveProposal = useApprovalHubStore((s) => s.approveProposal);
  const rejectProposal = useApprovalHubStore((s) => s.rejectProposal);
  const decisionError = useApprovalHubStore((s) => s.error);
  const resolveEntityConflict = useApprovalHubStore((s) => s.resolveEntityConflict);
  const decidingState = useApprovalHubStore((s) => s.deciding[item.proposalId]);
  const entityConflict =
    item.sourceFeatureId === 'F260' && isEntityConflictContext(item.detail.conflict) ? item.detail.conflict : undefined;

  const handleApprove = useCallback(() => {
    void approveProposal(item.proposalId);
  }, [approveProposal, item.proposalId]);

  const [feedbackDialogOpen, setFeedbackDialogOpen] = useState(false);
  const [feedbackDialogError, setFeedbackDialogError] = useState<string | null>(null);
  const [feedbackSubmitted, setFeedbackSubmitted] = useState(false);

  const handleEntityResolution = useCallback(
    (resolution: EntityConflictResolutionRequest) => {
      void resolveEntityConflict(item.proposalId, resolution);
    },
    [item.proposalId, resolveEntityConflict],
  );

  const featureMeta = approvalFeatureMeta(item.sourceFeatureId);
  const feedbackReasonCodes = featureMeta.humanDispositionReasonCodes;
  const usesFeedbackDialog = !isStale && feedbackReasonCodes !== null;

  const handleReject = useCallback(() => {
    if (usesFeedbackDialog) {
      setFeedbackDialogError(null);
      setFeedbackSubmitted(false);
      setFeedbackDialogOpen(true);
      return;
    }
    void rejectProposal(item.proposalId);
  }, [item.proposalId, rejectProposal, usesFeedbackDialog]);

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

  return (
    <div
      className="rounded-lg border border-[var(--cafe-border)] p-3 space-y-2"
      data-testid={`approval-item-${item.proposalId}`}
    >
      {/* Header row: feature badge + stale badge + age */}
      <div className="flex items-center gap-2 text-micro">
        <span
          className="px-1.5 py-0.5 rounded-md font-medium"
          style={{ backgroundColor: featureMeta.color, color: 'var(--cafe-accent-foreground)' }}
        >
          {featureMeta.badgeLabel}
        </span>
        {isStale && (
          <span
            className="px-1.5 py-0.5 rounded-md font-medium"
            style={{ backgroundColor: 'var(--semantic-warning)', color: 'var(--cafe-accent-foreground)' }}
            data-testid="stale-badge"
          >
            已过期
          </span>
        )}
        {isResumeOnly && (
          <span
            className="px-1.5 py-0.5 rounded-md font-medium"
            style={{ backgroundColor: 'var(--semantic-warning)', color: 'var(--cafe-accent-foreground)' }}
            data-testid="recovery-badge"
          >
            待恢复
          </span>
        )}
        <span className="ml-auto opacity-60">{formatAge(item.createdAt)}</span>
      </div>

      {/* Summary */}
      <p className="text-sm font-medium">{item.summary}</p>

      {/* Requester */}
      <p className="text-micro opacity-60">by {resolveCatName(item.requesterCatId)}</p>

      {/* F128: detail excerpt */}
      {item.sourceFeatureId === 'F128' && item.detail.reason != null && (
        <CriticalText summary="审批理由" details={String(item.detail.reason)} tone="warning" />
      )}

      {/* F225: handoff note excerpt */}
      {item.sourceFeatureId === 'F225' && f225HandoffDetails && (
        <CriticalText summary="交接记录" details={f225HandoffDetails} tone="info" />
      )}

      {/* F221: taste proposal detail — scene + quote + dimension + tags + privacy */}
      {item.sourceFeatureId === 'F221' && (
        <div className="text-micro opacity-80 space-y-0.5">
          {f221TasteEvidence && <CriticalText summary="品味提案依据" details={f221TasteEvidence} tone="info" />}
          <div className="flex items-center gap-1.5 flex-wrap">
            {item.detail.dimension != null && (
              <span className="px-1 py-0.5 rounded bg-[var(--cafe-muted)] text-micro">
                {String(item.detail.dimension)}
              </span>
            )}
            {item.detail.privacy === 'sensitive' && (
              <span className="px-1 py-0.5 rounded bg-[var(--semantic-warning,#f59e0b)] text-micro text-white">
                sensitive
              </span>
            )}
            {Array.isArray(item.detail.tags) &&
              item.detail.tags.map((tag) => (
                <span key={String(tag)} className="px-1 py-0.5 rounded bg-[var(--cafe-muted)] text-micro">
                  {String(tag)}
                </span>
              ))}
          </div>
        </div>
      )}

      {/* F193: dispatch proposal detail — thread routing context (Bug 1 fix) */}
      {item.sourceFeatureId === 'F193' && (
        <div className="text-micro opacity-80 space-y-0.5">
          {/* Thread routing: 从哪个 thread → 往哪个 thread.
               Each side gets its own truncation so a long source title can't hide the destination. */}
          <div className="flex items-center gap-1 min-w-0">
            <span className="opacity-60 shrink-0">从：</span>
            <span className="truncate flex-1">{sourceThreadTitle}</span>
            <span className="opacity-60 shrink-0">→</span>
            <span className="truncate flex-1">{targetThreadTitle ?? f193TargetThreadId}</span>
          </div>
          {item.detail.content != null && (
            <CriticalText summary="派发内容" details={String(item.detail.content)} tone="info" />
          )}
          {item.detail.targetCats != null && (
            <p>
              Target:{' '}
              {Array.isArray(item.detail.targetCats)
                ? item.detail.targetCats
                    .map((catId) => (typeof catId === 'string' ? resolveCatName(catId) : String(catId)))
                    .join(', ')
                : String(item.detail.targetCats)}
            </p>
          )}
        </div>
      )}

      {/* F260: entity proposal detail — entity registration context */}
      {item.sourceFeatureId === 'F260' && (
        <div className="text-micro opacity-80 space-y-0.5">
          <p data-testid="entity-proposal-identity">
            提案 {item.proposalId} · 目标实体 {String(item.detail.entityId ?? '未指定')}
          </p>
          {item.detail.canonicalName != null && (
            <p className="font-medium">
              {String(item.detail.canonicalName)} ({String(item.detail.entityType ?? 'entity')})
            </p>
          )}
          {Array.isArray(item.detail.aliases) && item.detail.aliases.length > 0 && (
            <p className="truncate">别名: {item.detail.aliases.join(', ')}</p>
          )}
          {item.detail.rationale != null && (
            <CriticalText summary="登记理由" details={String(item.detail.rationale)} tone="info" />
          )}
        </div>
      )}

      {entityConflict && (
        <EntityConflictResolutionPanel
          key={entityConflict.fingerprint}
          conflict={entityConflict}
          error={typeof item.detail.conflictError === 'string' ? item.detail.conflictError : undefined}
          deciding={Boolean(decidingState)}
          onResolve={handleEntityResolution}
          onReject={handleReject}
        />
      )}

      {isPersonMemoryClaimSelect && <PersonMemoryClaimSelector item={item} onReject={handleReject} />}

      {/* Actions: approve for inlineApprovable; reject/dismiss for ALL items */}
      {!isPersonMemoryClaimSelect && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {item.inlineApprovable && isResumeOnly && (
            <button
              type="button"
              onClick={handleApprove}
              disabled={!!decidingState}
              className="px-3 py-1 text-micro font-medium rounded-md text-white disabled:opacity-50"
              style={{ backgroundColor: 'var(--semantic-warning, #f59e0b)' }}
              data-testid="resume-btn"
            >
              {decidingState === 'approving' ? '...' : '继续完成'}
            </button>
          )}
          {item.inlineApprovable && !isResumeOnly && !entityConflict && (
            <button
              type="button"
              onClick={handleApprove}
              disabled={!!decidingState}
              className="px-3 py-1 text-micro font-medium rounded-md text-white disabled:opacity-50"
              style={{ backgroundColor: 'var(--semantic-success, #22c55e)' }}
              data-testid="approve-btn"
            >
              {decidingState === 'approving' ? '...' : '批准'}
            </button>
          )}
          {/* Reject/dismiss: always available (approve needs context, reject doesn't).
            Stale items show "清除" instead of "拒绝" to match dismissal intent.
            Entity conflict panel has its own reject, so skip here. */}
          {!entityConflict && (
            <button
              type="button"
              onClick={handleReject}
              disabled={!!decidingState}
              className="px-3 py-1 text-micro font-medium rounded-md border border-[var(--cafe-border)] hover:bg-[var(--semantic-error,#ef4444)] hover:text-white disabled:opacity-50"
              data-testid="reject-btn"
            >
              {decidingState === 'rejecting' ? '...' : isStale ? '清除' : '拒绝'}
            </button>
          )}
          <ApprovalProvenanceLinks navigation={item.navigation} onBeforeNavigate={close} />
        </div>
      )}
      {isPersonMemoryClaimSelect && (
        <div className="pt-1">
          <ApprovalProvenanceLinks navigation={item.navigation} onBeforeNavigate={close} />
        </div>
      )}
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
    </div>
  );
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
