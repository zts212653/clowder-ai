'use client';

import { useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useTaskStore } from '@/stores/taskStore';
import { YarnBallIcon } from '../shell/ShellIcons';
import { useShellCopy } from '../shell/shell-copy';
import { TaskComposer } from '../TaskComposer';
import { conversationTasks, openTaskCount } from './conversation-tasks';
import { YarnBallCard } from './YarnBallCard';
import { yarnBallCopy } from './yarn-ball.shell-copy';

export function YarnBallPanel() {
  const threadId = useChatStore((state) => state.currentThreadId);
  return <ConversationYarnBalls key={threadId} threadId={threadId} />;
}

function ConversationYarnBalls({ threadId }: { threadId: string }) {
  const allTasks = useTaskStore((state) => state.tasks);
  const loadedThreadId = useTaskStore((state) => state.loadedThreadId);
  const tasks = conversationTasks(allTasks, threadId);
  const known = tasks.length > 0 || loadedThreadId === threadId;
  const [composerOpen, setComposerOpen] = useState(false);
  const t = useShellCopy(yarnBallCopy);
  return (
    <section
      data-testid="yarn-ball-panel"
      className="flex h-full min-h-0 w-full flex-col bg-[var(--shell-work)] text-[var(--shell-body)]"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <h2 className="text-sm font-semibold">{known ? t.title(openTaskCount(tasks)) : t.pendingTitle}</h2>
        <button
          type="button"
          onClick={() => setComposerOpen(!composerOpen)}
          aria-expanded={composerOpen}
          className="shell-focusable h-8 rounded-lg border bg-[var(--shell-paper)] px-3 text-xs"
          style={{ borderColor: 'var(--shell-hairline)' }}
        >
          {t.newTask}
        </button>
      </header>
      {composerOpen && (
        <TaskComposer
          key={threadId}
          threadId={threadId}
          onClose={() => setComposerOpen(false)}
          onCreated={(task) => {
            if (useChatStore.getState().currentThreadId === task.threadId) useTaskStore.getState().updateTask(task);
          }}
        />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {tasks.length === 0 && !composerOpen && (
          <div className="flex flex-col items-center gap-3 py-10 text-sm text-[var(--shell-muted)]">
            <YarnBallIcon className="h-8 w-8" />
            <p>{known ? t.empty : t.notLoaded}</p>
            <button
              type="button"
              onClick={() => setComposerOpen(true)}
              className="shell-focusable rounded-lg border px-3 py-2 text-[var(--shell-body)]"
              style={{ borderColor: 'var(--shell-hairline)' }}
            >
              {t.createFirst}
            </button>
          </div>
        )}
        {(['doing', 'blocked', 'todo', 'done'] as const).map((status) => {
          const group = tasks.filter((task) => task.status === status).sort((a, b) => b.updatedAt - a.updatedAt);
          if (!group.length) return null;
          if (status === 'done')
            return (
              <details key={status} className="mt-5 text-sm text-[var(--shell-muted)]">
                <summary className="shell-focusable w-fit cursor-pointer list-none rounded py-1 [&::-webkit-details-marker]:hidden">
                  {t.completed(group.length)} ›
                </summary>
                <div className="mt-3 space-y-3">
                  {group.map((task) => (
                    <YarnBallCard key={task.id} task={task} />
                  ))}
                </div>
              </details>
            );
          return (
            <section key={status} className="mb-5" aria-label={t.status[status]}>
              <h3 className="mb-2 flex items-center gap-2 text-xs text-[var(--shell-muted)]">
                {t.status[status]} <span className="tabular-nums">{group.length}</span>
              </h3>
              <div className="space-y-3">
                {group.map((task) => (
                  <YarnBallCard key={task.id} task={task} />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </section>
  );
}
