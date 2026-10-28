'use client';

import type { TaskItem } from '@cat-cafe/shared';
import { useId, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import { useChatStore } from '@/stores/chatStore';
import { useTaskStore } from '@/stores/taskStore';
import { apiFetch } from '@/utils/api-client';
import { scrollToMessage } from '@/utils/scrollToMessage';
import { kickTeleportResolve, planTeleport } from '@/utils/teleport';
import { CatAvatar } from '../CatAvatar';
import { ProposalChoice } from '../rich/ProposalChoice';
import { useShellCopy } from '../shell/shell-copy';
import { pushThreadRouteWithHistory } from '../ThreadSidebar/thread-navigation';
import { yarnBallCopy } from './yarn-ball.shell-copy';

const STATUSES = ['doing', 'blocked', 'todo', 'done'] as const;
const DOT: Record<TaskItem['status'], string> = {
  doing: 'var(--semantic-info)',
  blocked: 'var(--semantic-warning)',
  todo: 'var(--cafe-text-muted)',
  done: 'var(--semantic-success)',
};

export function YarnBallCard({ task }: { task: TaskItem }) {
  const t = useShellCopy(yarnBallCopy);
  const { getCatById } = useCatData();
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const detailsId = useId();
  const name = task.ownerCatId ? resolveCatDisplayName(task.ownerCatId, getCatById) : t.unassigned;
  const minutes = Math.max(0, Math.floor((Date.now() - task.updatedAt) / 60000));
  const time =
    minutes === 0
      ? t.justNow
      : minutes < 60
        ? t.minutes(minutes)
        : minutes < 1440
          ? t.hours(Math.floor(minutes / 60))
          : t.days(Math.floor(minutes / 1440));
  const goToSource = () => {
    if (!task.sourceMessageId) return;
    const chat = useChatStore.getState();
    const plan = planTeleport({
      threadId: task.threadId,
      messageId: task.sourceMessageId,
      currentThreadId: chat.currentThreadId,
    });
    if (plan.navigateTo) pushThreadRouteWithHistory(plan.navigateTo, window);
    else if (plan.scrollNow) {
      scrollToMessage(plan.scrollNow);
      kickTeleportResolve();
    }
    chat.closeRightPanel();
  };
  const changeStatus = async (status: TaskItem['status']) => {
    if (pending || status === task.status) return;
    setPending(true);
    setError(false);
    try {
      const response = await apiFetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, expectedOwnerRevision: task.ownerRevision ?? 0 }),
      });
      if (!response.ok) {
        setError(true);
        return;
      }
      const updated: TaskItem = await response.json();
      if (updated.id !== task.id || updated.threadId !== task.threadId) {
        setError(true);
        return;
      }
      if (useChatStore.getState().currentThreadId !== task.threadId) return;
      const store = useTaskStore.getState();
      const current = store.tasks.find((item) => item.id === updated.id);
      if (current && current.updatedAt > updated.updatedAt) return;
      store.updateTask(updated);
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  };

  return (
    <article
      data-yarn-ball-id={task.id}
      data-status={task.status}
      className="rounded-xl border bg-[var(--shell-paper)] p-4 text-[var(--shell-body)]"
      style={{
        borderColor: 'var(--shell-hairline)',
        borderLeftWidth: task.status === 'blocked' ? 3 : 1,
        borderLeftColor: task.status === 'blocked' ? 'var(--semantic-warning)' : 'var(--shell-hairline)',
      }}
    >
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-controls={detailsId}
          className="shell-focusable min-w-0 flex-1 rounded text-left text-sm font-semibold"
        >
          <span className="line-clamp-2">{task.title}</span>
        </button>
        {task.ownerCatId && <CatAvatar catId={task.ownerCatId} size={24} ring="none" />}
        <span
          className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs"
          style={{ background: 'var(--cafe-surface-sunken)' }}
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: DOT[task.status] }} aria-hidden="true" />
          {t.status[task.status]}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--shell-muted)]">
        <time dateTime={new Date(task.updatedAt).toISOString()}>{t.updated(name, time)}</time>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded(!expanded)}
          className="shell-focusable rounded px-1 text-[var(--shell-primary)]"
        >
          {expanded ? t.collapse : t.expand} {expanded ? '⌃' : '⌄'}
        </button>
      </div>
      {expanded && (
        <div
          id={detailsId}
          className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3"
          style={{ borderColor: 'var(--shell-hairline)' }}
        >
          {task.sourceMessageId && (
            <button
              type="button"
              onClick={goToSource}
              className="shell-focusable rounded-lg border px-3 py-1.5 text-xs"
              style={{ borderColor: 'var(--shell-hairline)' }}
            >
              {t.origin}
            </button>
          )}
          <div className="ml-auto">
            <ProposalChoice
              label={`${t.changeStatus}: ${task.title}`}
              value={task.status}
              triggerLabel={pending ? t.changing : t.changeStatus}
              options={STATUSES.map((status) => ({ value: status, label: t.status[status] }))}
              disabled={pending}
              onChange={(value) => {
                const status = STATUSES.find((candidate) => candidate === value);
                if (status) void changeStatus(status);
              }}
            />
          </div>
          {error && (
            <p role="alert" className="w-full text-xs">
              {t.statusError}
            </p>
          )}
        </div>
      )}
    </article>
  );
}
