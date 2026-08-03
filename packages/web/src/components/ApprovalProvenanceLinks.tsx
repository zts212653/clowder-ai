'use client';

import type { ApprovalNavigation } from '@cat-cafe/shared';
import { useCallback } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { kickTeleportResolve, planTeleport } from '@/utils/teleport';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';

export function jumpToApprovalAnchor(threadId: string, messageId?: string): void {
  if (!messageId) {
    pushThreadRouteWithHistory(threadId, typeof window !== 'undefined' ? window : undefined);
    return;
  }
  const plan = planTeleport({ threadId, messageId, currentThreadId: useChatStore.getState().currentThreadId });
  if (plan.scrollNow) {
    scrollToMessage(plan.scrollNow);
    kickTeleportResolve();
  } else if (plan.navigateTo) {
    pushThreadRouteWithHistory(plan.navigateTo, typeof window !== 'undefined' ? window : undefined);
  }
}

interface ApprovalProvenanceLinksProps {
  navigation: ApprovalNavigation;
  onBeforeNavigate?: () => void;
  compact?: boolean;
}

export function ApprovalProvenanceLinks({
  navigation,
  onBeforeNavigate,
  compact = false,
}: ApprovalProvenanceLinksProps) {
  const navigate = useCallback(
    (threadId: string, messageId?: string) => {
      onBeforeNavigate?.();
      jumpToApprovalAnchor(threadId, messageId);
    },
    [onBeforeNavigate],
  );
  const buttonClass = compact
    ? 'rounded px-1.5 py-0.5 text-micro text-cafe-interactive/55 transition-colors hover:bg-cafe-surface hover:text-cafe-interactive'
    : 'rounded-md border border-[var(--cafe-border)] px-3 py-1 text-micro font-medium transition-colors hover:bg-[var(--cafe-muted)]';
  if (navigation.state === 'legacy_unanchored') {
    const { legacyThreadId } = navigation;
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="text-micro text-[var(--semantic-warning)]" data-testid="approval-legacy-warning">
          历史记录未建立可靠锚点，无法精确跳转
        </span>
        {legacyThreadId && (
          <button
            type="button"
            className={buttonClass}
            onClick={() => navigate(legacyThreadId)}
            data-testid="approval-legacy-thread-link"
          >
            查看历史 Thread（非精确）
          </button>
        )}
      </div>
    );
  }
  const { originRef } = navigation;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <button
        type="button"
        className={buttonClass}
        onClick={() => navigate(navigation.approvalCardRef.threadId, navigation.approvalCardRef.messageId)}
        data-testid="approval-card-link"
      >
        查看审批卡
      </button>
      {originRef.kind === 'message' ? (
        <button
          type="button"
          className={buttonClass}
          onClick={() => navigate(originRef.threadId, originRef.messageId)}
          data-testid="approval-origin-link"
        >
          查看触发原文
        </button>
      ) : (
        <span
          className="min-w-0 truncate text-micro text-cafe-interactive/55"
          title={`${originRef.anchor}: ${originRef.summary}`}
          data-testid="approval-event-origin"
        >
          来源事件：{originRef.summary}
        </span>
      )}
    </div>
  );
}
