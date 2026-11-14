'use client';

import type { TaskItem } from '@cat-cafe/shared';
import { useState } from 'react';
import { useCoCreatorDisplay } from '@/hooks/useCoCreatorConfig';
import { CatAvatar } from './CatAvatar';

type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done';

const STATUS_CYCLE: Record<TaskStatus, TaskStatus> = {
  todo: 'doing',
  doing: 'blocked',
  blocked: 'done',
  done: 'todo',
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '待办',
  doing: '进行中',
  blocked: '阻塞中',
  done: '已完成',
};

const STATUS_STYLES: Record<TaskStatus, { text: string; border: string; pillBg: string }> = {
  doing: {
    text: 'text-cafe-crosspost',
    border: 'border-l-cafe-crosspost',
    pillBg: 'bg-cafe-crosspost/10 text-cafe-crosspost',
  },
  blocked: {
    text: 'text-cafe-accent',
    border: 'border-l-cafe-accent',
    pillBg: 'bg-cafe-accent/10 text-cafe-accent',
  },
  todo: {
    text: 'text-cafe-muted',
    border: 'border-l-cafe-muted',
    pillBg: 'bg-cafe-surface-elevated text-cafe-muted',
  },
  done: {
    text: 'text-conn-green-text',
    border: 'border-l-conn-green-text',
    pillBg: 'bg-conn-green-bg text-conn-green-text dark:bg-green-950/20',
  },
};

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

export function TaskCard({
  task,
  onStatusChange,
}: {
  task: TaskItem;
  onStatusChange: (taskId: string, newStatus: string) => void;
}) {
  const owner = useCoCreatorDisplay();
  const [expanded, setExpanded] = useState(false);
  const status = task.status as TaskStatus;
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.todo;

  return (
    <div
      className={`border-l-4 ${style.border} bg-cafe-surface-elevated border border-cafe rounded-xl p-3 mx-3 mb-1.5 hover:-translate-y-0.5 transition-transform ease-out`}
    >
      <div className="flex items-center gap-2">
        {/* Title */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex-1 text-left text-sm font-medium text-cafe-secondary truncate"
        >
          {task.title}
        </button>

        {/* Owner avatar */}
        {task.ownerCatId && <CatAvatar catId={task.ownerCatId} size={14} />}

        {/* Status pill (clickable to cycle) */}
        <button
          type="button"
          onClick={() => onStatusChange(task.id, STATUS_CYCLE[status])}
          className={`text-micro font-semibold px-2 py-0.5 rounded-full ${style.pillBg} transition-colors hover:opacity-80`}
        >
          {STATUS_LABELS[status]}
        </button>
      </div>

      {task.recovery?.incidents.length ? (
        <div data-testid="task-recovery" className="mt-2 rounded border border-cafe-accent/40 bg-cafe-accent/5 p-2">
          <p className="text-xs font-medium text-cafe-secondary">自动恢复已暂停</p>
          {task.recovery.incidents.map((incident) => (
            <p
              key={`${incident.source}:${incident.lane}:${incident.executionRef}`}
              className="mt-1 text-micro text-cafe-muted"
            >
              {incident.disposition === 'needs_attention'
                ? '需要检查'
                : incident.disposition === 'parked'
                  ? '已停放'
                  : '已中断'}
              {' · '}
              {incident.reasonCode}
            </p>
          ))}
        </div>
      ) : null}

      {/* Expanded details */}
      {expanded && (
        <div className="mt-2 pt-2 border-t border-cafe">
          {task.why && <p className="text-xs text-cafe-muted leading-relaxed">{task.why}</p>}
          {task.recovery?.incidents.map((incident) => (
            <p key={incident.executionRef} className="mt-1 break-all text-micro text-cafe-muted">
              原执行：{incident.executionRef}
            </p>
          ))}
          <p className="text-micro text-cafe-muted mt-1">
            {formatRelativeTime(task.createdAt)} · {task.createdBy === 'user' ? owner.nickname : task.createdBy}
          </p>
        </div>
      )}
    </div>
  );
}
