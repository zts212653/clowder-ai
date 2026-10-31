'use client';

import { useBubbleDisplayCycle } from '../bubble-display-cycle';
import { replyLayersCopy } from '../reply-layers/reply-layers.shell-copy';
import { useShellCopy } from '../shell/shell-copy';

/**
 * F322 B — §1.16 合同四, the conversation-level switch of the new shell: whether the execution record of this conversation's
 * replies starts open. Same three states, same field and same PATCH as the classic "命令行气泡" row (`useBubbleDisplayCycle`);
 * only the words are the new shell's: 执行记录 · 展开 · 收起 · 跟随默认.
 */
export function ActivityRecordToggle({ threadId }: { threadId: string }) {
  const t = useShellCopy(replyLayersCopy).settings;
  const { current, currentEffective, next, restorePending, cycle } = useBubbleDisplayCycle(threadId, 'bubbleCli');
  const state = (value: 'expanded' | 'collapsed') => (value === 'expanded' ? t.expanded : t.collapsed);
  const nowWord = current === 'global' ? undefined : state(current);
  const followWord = currentEffective === 'expanded' ? t.followingExpanded : t.followingCollapsed;
  const nextWord = restorePending
    ? t.restoring
    : next === 'global'
      ? t.followDefault
      : next
        ? state(next)
        : t.restoring;

  return (
    <div data-testid="activity-record-toggle" className="flex min-w-0 items-center justify-between gap-2">
      <span className="min-w-0 truncate">
        {t.activity}: <span className="font-medium">{nowWord ?? followWord}</span>
      </span>
      <button
        type="button"
        onClick={cycle}
        disabled={restorePending}
        className="shrink-0 rounded-full px-3 py-1 text-label transition-colors hover:text-cafe"
      >
        {nextWord}
      </button>
    </div>
  );
}
