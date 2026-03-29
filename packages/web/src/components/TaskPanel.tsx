'use client';

import { useState } from 'react';
import { type TaskItem, useTaskStore } from '@/stores/taskStore';
import { CatAvatar } from './CatAvatar';

const STATUS_ORDER: Record<string, number> = { doing: 0, blocked: 1, todo: 2, done: 3 };
const STATUS_ICONS: Record<string, string> = {
  todo: '○',
  doing: '◉',
  blocked: '⊘',
  done: '●',
};
const STATUS_COLORS: Record<string, string> = {
  todo: 'text-cafe-muted',
  doing: 'text-blue-500',
  blocked: 'text-red-400',
  done: 'text-green-500',
};

function TaskItemRow({ task }: { task: TaskItem }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="group">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-3 py-1.5 flex items-center gap-2 hover:bg-cafe-surface-elevated rounded transition-colors"
      >
        <span className={`text-sm ${STATUS_COLORS[task.status]}`}>{STATUS_ICONS[task.status]}</span>
        <span className="text-xs text-cafe-secondary truncate flex-1">{task.title}</span>
        {task.ownerCatId && <CatAvatar catId={task.ownerCatId} size={14} />}
      </button>
      {expanded && task.why && (
        <div className="px-3 pb-2 ml-6">
          <p className="text-[10px] text-cafe-muted leading-relaxed">{task.why}</p>
        </div>
      )}
    </div>
  );
}

/**
 * TaskPanel — 毛线球任务面板
 * Embedded in ThreadSidebar. Shows tasks grouped by status.
 */
export function TaskPanel() {
  const tasks = useTaskStore((s) => s.tasks);

  if (tasks.length === 0) return null;

  const sorted = [...tasks].sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9));
  const activeCount = tasks.filter((t) => t.status !== 'done').length;

  return (
    <div className="border-t border-cafe pt-3 mt-3">
      <div className="flex items-center gap-2 px-3 mb-2">
        <span className="text-xs font-semibold text-cafe-secondary">🧶 毛线球</span>
        {activeCount > 0 && (
          <span className="text-[10px] bg-blue-100 text-blue-600 rounded-full px-1.5 py-0.5 font-medium">
            {activeCount}
          </span>
        )}
      </div>
      <div className="space-y-0.5">
        {sorted.map((task) => (
          <TaskItemRow key={task.id} task={task} />
        ))}
      </div>
    </div>
  );
}
