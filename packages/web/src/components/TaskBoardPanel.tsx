'use client';

import { useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { useTaskStore } from '@/stores/taskStore';
import { TaskCard } from './TaskCard';
import { TaskComposer } from './TaskComposer';

const STORAGE_KEY = 'taskboard-collapsed';

const SECTIONS = [
  { key: 'doing', label: '进行中', icon: '◉', defaultCollapsed: false },
  { key: 'blocked', label: '阻塞中', icon: '⊘', defaultCollapsed: false },
  { key: 'todo', label: '待办', icon: '○', defaultCollapsed: true },
  { key: 'done', label: '已完成', icon: '●', defaultCollapsed: true },
] as const;

type SectionKey = (typeof SECTIONS)[number]['key'];

const SECTION_STYLES: Record<SectionKey, { text: string; border: string; sectionBg: string }> = {
  doing: { text: 'text-cafe-crosspost', border: 'border-l-cafe-crosspost', sectionBg: '' },
  blocked: {
    text: 'text-cafe-accent',
    border: 'border-l-cafe-accent',
    sectionBg: 'bg-red-50 dark:bg-red-950/20',
  },
  todo: { text: 'text-cafe-muted', border: 'border-l-cafe-muted', sectionBg: '' },
  done: { text: 'text-green-600', border: 'border-l-green-600', sectionBg: '' },
};

function getDefaultCollapsed(): Record<SectionKey, boolean> {
  const defaults: Record<SectionKey, boolean> = { doing: false, blocked: false, todo: true, done: true };
  if (typeof window === 'undefined') return defaults;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) return { ...defaults, ...JSON.parse(saved) };
  } catch {
    /* ignore */
  }
  return defaults;
}

function SectionHeader({
  section,
  count,
  collapsed,
  onToggle,
}: {
  section: (typeof SECTIONS)[number];
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const style = SECTION_STYLES[section.key];
  return (
    <button
      type="button"
      onClick={onToggle}
      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-cafe-surface-elevated/50 transition-colors"
    >
      <span className={`text-sm ${style.text}`}>{section.icon}</span>
      <span className={`text-xs font-semibold ${style.text}`}>{section.label}</span>
      <span className="text-[10px] text-cafe-muted bg-cafe-surface-elevated rounded-full px-1.5 py-0.5">{count}</span>
      {collapsed && count > 0 && <span className="text-[10px] text-cafe-muted">{count} 项已折叠</span>}
      <span className="ml-auto text-[10px] text-cafe-muted">{collapsed ? '▸' : '▾'}</span>
    </button>
  );
}

function EmptyState({ onCreateFirst }: { onCreateFirst: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-8 text-center">
      <div className="text-3xl mb-3">&#x1F9F6;</div>
      <h3 className="text-sm font-semibold text-cafe-secondary mb-1">把长期事项挂在线上，不埋回聊天里</h3>
      <p className="text-xs text-cafe-muted mb-4 leading-relaxed">
        需要跨多轮对话跟踪的事项，铲屎官和猫猫都可以创建毛线球。 临时步骤继续留给猫猫祟祟。
      </p>
      <button
        type="button"
        onClick={onCreateFirst}
        className="text-xs font-semibold bg-cafe-crosspost text-white px-4 py-2 rounded-lg transition-colors hover:bg-cafe-crosspost/90"
      >
        创建第一颗毛线球
      </button>
      <div className="mt-6 text-left w-full">
        <p className="text-[10px] font-semibold text-cafe-muted mb-1.5">何时该用毛线球？</p>
        <ul className="text-[10px] text-cafe-muted space-y-1 list-disc pl-4">
          <li>跨对话的持续任务（调研、重构、功能开发）</li>
          <li>需要阻塞跟踪的外部依赖</li>
          <li>想让猫猫记住的长期目标</li>
        </ul>
      </div>
    </div>
  );
}

function handleStatusChange(taskId: string, newStatus: string) {
  fetch(`/api/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: newStatus }),
  }).catch(() => {
    /* socket task_updated will sync state */
  });
}

export function TaskBoardPanel() {
  const tasks = useTaskStore((s) => s.tasks);
  const threadId = useChatStore((s) => s.currentThreadId);
  const [collapsed, setCollapsed] = useState<Record<SectionKey, boolean>>(getDefaultCollapsed);
  const [composerOpen, setComposerOpen] = useState(false);

  const toggle = (key: SectionKey) => {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const grouped = SECTIONS.map((section) => ({
    section,
    tasks: tasks.filter((t) => t.status === section.key),
  }));

  return (
    <div className="flex flex-col h-full bg-cafe-surface">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-cafe">
        <span className="text-xs font-semibold text-cafe-secondary">
          毛线球 · {tasks.length === 0 ? '暂无任务' : '当前对话任务'}
        </span>
        <button
          type="button"
          onClick={() => setComposerOpen(true)}
          className="ml-auto text-[10px] font-semibold bg-cafe-crosspost/80 text-white px-2.5 py-1 rounded-full transition-colors hover:bg-cafe-crosspost"
        >
          + 新任务
        </button>
      </div>
      {/* Stats bar */}
      {tasks.length > 0 && (
        <div className="flex items-center gap-3 px-3 py-1.5 text-[10px] text-cafe-muted border-b border-cafe">
          <span>{tasks.length} 总任务</span>
          {grouped.map(({ section, tasks: st }) =>
            st.length > 0 ? (
              <span key={section.key} className={SECTION_STYLES[section.key].text}>
                {st.length} {section.key}
              </span>
            ) : null,
          )}
        </div>
      )}

      {/* Composer */}
      {composerOpen && threadId && <TaskComposer threadId={threadId} onClose={() => setComposerOpen(false)} />}

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {tasks.length === 0 && !composerOpen ? (
          <EmptyState onCreateFirst={() => setComposerOpen(true)} />
        ) : (
          grouped.map(({ section, tasks: sectionTasks }) => {
            const style = SECTION_STYLES[section.key];
            return (
              <div key={section.key} className={style.sectionBg}>
                <SectionHeader
                  section={section}
                  count={sectionTasks.length}
                  collapsed={collapsed[section.key]}
                  onToggle={() => toggle(section.key)}
                />
                {!collapsed[section.key] &&
                  sectionTasks.map((task) => (
                    <TaskCard key={task.id} task={task} onStatusChange={handleStatusChange} />
                  ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
