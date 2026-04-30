'use client';

import type { TaskItem, TaskStatus } from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/utils/api-client';

function StatCard({ label, value, warning }: { label: string; value: number; warning?: boolean }) {
  return (
    <div
      className="flex flex-1 flex-col gap-1 rounded-2xl bg-[var(--console-card-bg)] p-4 shadow-[0_8px_22px_rgba(43,33,26,0.04)]"
      style={{ height: 92 }}
    >
      <span className={`text-[22px] font-bold ${warning ? 'text-conn-amber-text' : 'text-cafe'}`}>{value}</span>
      <span className="text-xs text-cafe-secondary">{label}</span>
    </div>
  );
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '待处理',
  doing: '进行中',
  blocked: '阻塞',
  done: '已完成',
};
const STATUS_BG_CLASS: Record<TaskStatus, string> = {
  todo: 'bg-[var(--console-pill-bg)]',
  doing: 'bg-[var(--console-pill-bg)]',
  blocked: 'bg-conn-amber-bg',
  done: 'bg-conn-emerald-bg',
};

function TaskQueueCard({ task, selected, onClick }: { task: TaskItem; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'flex w-full items-center gap-3 rounded-[14px] bg-[var(--console-card-bg)] px-3 text-left transition-shadow',
        selected ? 'shadow-[0_8px_22px_rgba(43,33,26,0.04)] ring-1 ring-[var(--cafe-accent,#C65F3D)]' : '',
      ].join(' ')}
      style={{ height: 82 }}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-[var(--console-active-bg)]">
        <svg className="h-4 w-4 text-cafe" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
        </svg>
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-cafe">{task.title}</p>
        <p className="mt-0.5 truncate text-xs text-cafe-secondary">{task.why || '—'}</p>
      </div>
      <span className={`shrink-0 rounded-xl px-2.5 py-0.5 text-[11px] font-medium ${STATUS_BG_CLASS[task.status]}`}>
        {STATUS_LABEL[task.status]}
      </span>
    </button>
  );
}

function MissionInspector({ task }: { task: TaskItem | null }) {
  return (
    <div className="flex w-80 shrink-0 flex-col gap-3.5 overflow-y-auto rounded-[18px] bg-[var(--console-card-bg)] p-[18px] shadow-[0_8px_22px_rgba(43,33,26,0.04)]">
      {task ? (
        <>
          <h3 className="text-lg font-bold text-cafe">当前任务</h3>
          <p className="text-[13px] leading-[1.35] text-cafe-secondary">{task.title}</p>
          {task.why && <p className="text-xs text-cafe-secondary">{task.why}</p>}
          {task.ownerCatId && (
            <span className="self-start rounded-full bg-[var(--console-pill-bg)] px-3 py-1 text-xs font-bold text-[var(--cafe-interactive,#6F3A2C)]">
              Owner: {task.ownerCatId}
            </span>
          )}
          <div className="mt-auto text-[11px] text-cafe-muted">
            创建于 {new Date(task.createdAt).toLocaleDateString('zh-CN')}
          </div>
        </>
      ) : (
        <>
          <h3 className="text-lg font-bold text-cafe">当前任务</h3>
          <p className="text-[13px] text-cafe-secondary">选择左侧任务查看详情</p>
        </>
      )}
    </div>
  );
}

export function MissionHubView() {
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const loadTasks = useCallback(async () => {
    try {
      const res = await apiFetch('/api/callbacks/list-tasks?kind=work');
      if (res.ok) {
        const data: { tasks?: TaskItem[] } = await res.json();
        setTasks(data.tasks ?? []);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  const stats = useMemo(() => {
    const count = (s: TaskStatus) => tasks.filter((t) => t.status === s).length;
    return { pending: count('todo'), reviewing: count('doing'), blocked: count('blocked') };
  }, [tasks]);

  const activeTasks = useMemo(() => tasks.filter((t) => t.status !== 'done'), [tasks]);
  const selected = tasks.find((t) => t.id === selectedId) ?? null;

  return (
    <div className="h-full bg-[var(--console-panel-bg)]">
      <div className="flex h-full flex-col overflow-hidden rounded-[18px] bg-[var(--console-shell-bg)] shadow-[var(--console-shadow-soft)] m-3 gap-5 px-9 py-8">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-cafe">Mission Hub</h1>
            <p className="mt-1 text-[13px] text-cafe-secondary">管理任务、执行队列和交付门禁</p>
          </div>
          <button
            type="button"
            disabled
            className="flex items-center gap-2 rounded-lg bg-[var(--cafe-accent,#C65F3D)] px-3.5 text-[13px] font-semibold text-[var(--cafe-surface)] opacity-50 cursor-not-allowed"
            style={{ height: 36 }}
            title="任务创建功能即将上线"
          >
            <svg className="h-[15px] w-[15px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            新建任务
          </button>
        </header>

        <div className="flex gap-3.5">
          <StatCard label="待处理任务" value={stats.pending} />
          <StatCard label="审查中" value={stats.reviewing} />
          <StatCard label="需要 CVO 决策" value={stats.blocked} warning />
        </div>

        <div className="flex min-h-0 flex-1 gap-[18px]">
          <div className="flex flex-1 flex-col gap-2 overflow-y-auto rounded-[18px] bg-[var(--console-panel-bg)] p-2">
            <div className="flex h-[42px] items-center justify-between px-2">
              <h2 className="text-base font-bold text-cafe">任务队列</h2>
              <span className="rounded-xl bg-[var(--console-pill-bg)] px-2.5 py-0.5 text-xs text-cafe-secondary">
                本周
              </span>
            </div>
            {loading ? (
              <p className="px-2 text-sm text-cafe-secondary">加载中...</p>
            ) : activeTasks.length === 0 ? (
              <p className="px-2 text-sm text-cafe-secondary">暂无活跃任务</p>
            ) : (
              activeTasks.map((task) => (
                <TaskQueueCard
                  key={task.id}
                  task={task}
                  selected={task.id === selectedId}
                  onClick={() => setSelectedId(task.id === selectedId ? null : task.id)}
                />
              ))
            )}
          </div>
          <MissionInspector task={selected} />
        </div>
      </div>
    </div>
  );
}
