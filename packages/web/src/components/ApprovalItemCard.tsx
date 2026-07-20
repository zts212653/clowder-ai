'use client';

/**
 * F246: Individual approval item card for the Approval Hub drawer.
 *
 * Phase A: F128/F225 cards use "jump to thread" — F128 needs full approve-time
 * overrides which the Hub drawer doesn't provide (AC-A4 强制跳转 fallback).
 *
 * Phase B: F193 (dispatch proposals) cards have inline approve/reject buttons
 * since all required info is in the proposal itself (AC-B1 inlineApprovable).
 *
 * Stale items (expiresAt < now) show an orange stale badge (AC-A6).
 */

import type { ApprovalItem } from '@cat-cafe/shared';
import { useCallback, useMemo } from 'react';
import { useCatNameResolver } from '@/hooks/useCatNameResolver';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import type { Thread } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { kickTeleportResolve, planTeleport } from '@/utils/teleport';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';

function formatAge(createdAt: number): string {
  const diffMs = Date.now() - createdAt;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Navigate to a specific message via teleport, or to thread root as fallback. */
function jumpToApproval(threadId: string, messageId?: string): void {
  if (messageId) {
    const currentThreadId = useChatStore.getState().currentThreadId;
    const plan = planTeleport({ threadId, messageId, currentThreadId });
    if (plan.scrollNow) {
      scrollToMessage(plan.scrollNow);
      kickTeleportResolve();
    } else if (plan.navigateTo) {
      pushThreadRouteWithHistory(plan.navigateTo, typeof window !== 'undefined' ? window : undefined);
    }
    return;
  }
  pushThreadRouteWithHistory(threadId, typeof window !== 'undefined' ? window : undefined);
}

export function ApprovalItemCard({ item }: { item: ApprovalItem }) {
  const close = useApprovalHubStore((s) => s.close);
  const resolveCatName = useCatNameResolver();

  // Thread title lookup for F193 dispatch context (Bug 1 fix).
  // Called unconditionally (Rules of Hooks); value used only when sourceFeatureId === 'F193'.
  // Array.isArray guard: test mocks may return non-arrays; treat them as empty.
  const rawThreads = useChatStore((s) => s.threads as Thread[] | unknown);
  const threads: Thread[] = Array.isArray(rawThreads) ? rawThreads : [];
  const f193TargetThreadId = item.sourceFeatureId === 'F193' ? String(item.detail.targetThreadId ?? '') : '';
  const sourceThreadTitle = useMemo(
    () => threads.find((t) => t.id === item.sourceThreadId)?.title ?? item.sourceThreadId,
    [threads, item.sourceThreadId],
  );
  const targetThreadTitle = useMemo(
    () => (f193TargetThreadId ? (threads.find((t) => t.id === f193TargetThreadId)?.title ?? f193TargetThreadId) : null),
    [threads, f193TargetThreadId],
  );

  const isStale = useMemo(() => item.expiresAt != null && item.expiresAt < Date.now(), [item.expiresAt]);

  const handleJump = useCallback(() => {
    close();
    jumpToApproval(item.sourceThreadId, item.sourceMessageId);
  }, [close, item.sourceThreadId, item.sourceMessageId]);

  const approveProposal = useApprovalHubStore((s) => s.approveProposal);
  const rejectProposal = useApprovalHubStore((s) => s.rejectProposal);
  const decidingState = useApprovalHubStore((s) => s.deciding[item.proposalId]);

  const handleApprove = useCallback(() => {
    void approveProposal(item.proposalId);
  }, [approveProposal, item.proposalId]);

  const handleReject = useCallback(() => {
    void rejectProposal(item.proposalId);
  }, [rejectProposal, item.proposalId]);

  const featureBadge =
    item.sourceFeatureId === 'F128'
      ? 'Thread'
      : item.sourceFeatureId === 'F193'
        ? 'Dispatch'
        : item.sourceFeatureId === 'F231'
          ? 'Profile'
          : 'Handoff';
  const featureColor =
    item.sourceFeatureId === 'F128'
      ? 'var(--semantic-info)'
      : item.sourceFeatureId === 'F193'
        ? 'var(--semantic-success, #22c55e)'
        : item.sourceFeatureId === 'F231'
          ? 'var(--semantic-warning, #f59e0b)'
          : 'var(--semantic-secondary, #8b5cf6)';

  return (
    <div
      className="rounded-lg border border-[var(--cafe-border)] p-3 space-y-2"
      data-testid={`approval-item-${item.proposalId}`}
    >
      {/* Header row: feature badge + stale badge + age */}
      <div className="flex items-center gap-2 text-micro">
        <span
          className="px-1.5 py-0.5 rounded-md font-medium"
          style={{ backgroundColor: featureColor, color: 'var(--cafe-accent-foreground)' }}
        >
          {featureBadge}
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
        <span className="ml-auto opacity-60">{formatAge(item.createdAt)}</span>
      </div>

      {/* Summary */}
      <p className="text-sm font-medium">{item.summary}</p>

      {/* Requester */}
      <p className="text-micro opacity-60">by {resolveCatName(item.requesterCatId)}</p>

      {/* F128: detail excerpt */}
      {item.sourceFeatureId === 'F128' && item.detail.reason != null && (
        <p className="text-micro opacity-80 line-clamp-2">{String(item.detail.reason)}</p>
      )}

      {/* F225: handoff note excerpt */}
      {item.sourceFeatureId === 'F225' && (
        <div className="text-micro opacity-80 space-y-0.5">
          {item.detail.done != null && <p className="line-clamp-1">Done: {String(item.detail.done)}</p>}
          {item.detail.nextSteps != null && <p className="line-clamp-1">Next: {String(item.detail.nextSteps)}</p>}
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
          {item.detail.content != null && <p className="line-clamp-3">{String(item.detail.content)}</p>}
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

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        {item.sourceFeatureId === 'F193' ? (
          <>
            {/* F193 inlineApprovable: approve/reject directly in Hub */}
            {item.inlineApprovable && (
              <>
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
                <button
                  type="button"
                  onClick={handleReject}
                  disabled={!!decidingState}
                  className="px-3 py-1 text-micro font-medium rounded-md border border-[var(--cafe-border)] hover:bg-[var(--semantic-error,#ef4444)] hover:text-white disabled:opacity-50"
                  data-testid="reject-btn"
                >
                  {decidingState === 'rejecting' ? '...' : '拒绝'}
                </button>
              </>
            )}
            {/* F193 always has a jump button so operator can view context before deciding */}
            <button
              type="button"
              onClick={handleJump}
              className="px-3 py-1 text-micro font-medium rounded-md border border-[var(--cafe-border)] hover:bg-[var(--cafe-muted)]"
              data-testid="jump-btn"
            >
              查看上下文
            </button>
          </>
        ) : (
          /* F128/F225/F231: jump to thread for full approval context */
          <button
            type="button"
            onClick={handleJump}
            className="px-3 py-1 text-micro font-medium rounded-md border border-[var(--cafe-border)] hover:bg-[var(--cafe-muted)]"
            data-testid="jump-btn"
          >
            {item.sourceFeatureId === 'F128' ? '跳转审批' : '跳转到 Thread'}
          </button>
        )}
      </div>
    </div>
  );
}
