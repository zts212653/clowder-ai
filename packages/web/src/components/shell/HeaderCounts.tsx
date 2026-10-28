'use client';

import { useThreadArtifacts } from '@/hooks/useThreadArtifacts';
import { useChatStore } from '@/stores/chatStore';
import { useTaskStore } from '@/stores/taskStore';
import { AppTooltip } from '../AppTooltip';
import { conversationTasks, openTaskCount } from '../yarn-ball/conversation-tasks';
import { headerCountsCopy } from './header-counts.shell-copy';
import { WorksIcon, YarnBallIcon } from './ShellIcons';
import { useShellCopy } from './shell-copy';

function HeaderChip({
  icon,
  label,
  count,
  tip,
  tipDetail,
  onClick,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  /** Shown only when a real, definable number exists; otherwise the chip stays a plain label. */
  count?: number;
  tip: string;
  tipDetail?: string;
  onClick: () => void;
  testId: string;
}) {
  const t = useShellCopy(headerCountsCopy);
  const accessibleName = t.accessibleName(count !== undefined ? `${label} ${count}` : label, tip);
  return (
    <AppTooltip label={tip} detail={tipDetail} side="bottom">
      <button
        type="button"
        onClick={onClick}
        aria-label={accessibleName}
        data-testid={testId}
        className="shell-rail-item shell-focusable inline-flex h-[30px] flex-none items-center gap-1.5 rounded-lg px-2.5 text-compact"
        style={{ color: 'var(--shell-body)' }}
      >
        <span style={{ color: 'var(--shell-muted)' }}>{icon}</span>
        <span>{label}</span>
        {count !== undefined ? <span className="tabular-nums">{count}</span> : null}
      </button>
    </AppTooltip>
  );
}

/**
 * Shares Home and All Works' canonical projection. Remounting the reader on a thread change prevents
 * the previous conversation's total from appearing while the new owner's read starts.
 */
export function ThreadWorksButton({ threadId }: { threadId: string }) {
  return <ThreadWorksCount key={threadId} threadId={threadId} />;
}

function ThreadWorksCount({ threadId }: { threadId: string | undefined }) {
  const t = useShellCopy(headerCountsCopy);
  const setWorkspaceMode = useChatStore((s) => s.setWorkspaceMode);
  const { total, complete, error } = useThreadArtifacts(threadId, 'works');
  const count = complete && !error && total !== null ? total : undefined;
  return (
    <HeaderChip
      icon={<WorksIcon className="h-4 w-4" />}
      label={t.works}
      count={count}
      tip={t.worksTip}
      onClick={() => setWorkspaceMode('artifacts')}
      testId="header-works"
    />
  );
}

/**
 * 毛线球 N (this conversation's 毛线球). N = this conversation's tasks that are not done, from the task store the chat already
 * loads for the open thread. A completed thread read distinguishes a known zero from an empty store that has not loaded yet.
 */
export function ThreadTasksButton() {
  const t = useShellCopy(headerCountsCopy);
  const setWorkspaceMode = useChatStore((s) => s.setWorkspaceMode);
  const threadId = useChatStore((s) => s.currentThreadId);
  const allTasks = useTaskStore((s) => s.tasks);
  const loadedThreadId = useTaskStore((s) => s.loadedThreadId);
  const tasks = conversationTasks(allTasks, threadId);
  const total = tasks.length;
  const open = openTaskCount(tasks);
  return (
    <HeaderChip
      icon={<YarnBallIcon />}
      label={t.tasks}
      count={total > 0 || loadedThreadId === threadId ? open : undefined}
      tip={t.tasksTip}
      tipDetail={total > 0 ? t.taskDetail(open, total) : undefined}
      onClick={() => setWorkspaceMode('tasks')}
      testId="header-tasks"
    />
  );
}
