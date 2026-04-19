'use client';

import { useCallback, useEffect, useState } from 'react';
import { type Thread, useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { BootcampIcon } from './icons/BootcampIcon';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';

/** Phase labels for human-readable display */
const PHASE_LABELS: Record<string, string> = {
  'phase-0-select-cat': '选猫',
  'phase-1-intro': '天团登场',
  'phase-2-env-check': '环境检测',
  'phase-3-config-help': '配置帮助',
  'phase-3.5-advanced': '进阶功能',
  'phase-4-task-select': '选任务',
  'phase-5-kickoff': '立项',
  'phase-6-design': '设计',
  'phase-7-dev': '开发',
  'phase-8-review': 'Review',
  'phase-9-complete': '完成',
  'phase-10-retro': '回顾',
  'phase-11-farewell': '毕业',
};

const PHASE_ORDER = [
  'phase-0-select-cat',
  'phase-1-intro',
  'phase-2-env-check',
  'phase-3-config-help',
  'phase-3.5-advanced',
  'phase-4-task-select',
  'phase-5-kickoff',
  'phase-6-design',
  'phase-7-dev',
  'phase-8-review',
  'phase-9-complete',
  'phase-10-retro',
  'phase-11-farewell',
];

function phaseProgress(phase: string | undefined): number {
  if (!phase) return 0;
  const idx = PHASE_ORDER.indexOf(phase);
  if (idx < 0) return 0;
  return Math.round(((idx + 1) / PHASE_ORDER.length) * 100);
}

interface BootcampListModalProps {
  open: boolean;
  onClose: () => void;
  /** Current thread ID — to skip showing "already here" */
  currentThreadId?: string;
}

export function BootcampListModal({ open, onClose, currentThreadId }: BootcampListModalProps) {
  const storeThreads = useChatStore((s) => s.threads);
  const setThreads = useChatStore((s) => s.setThreads);
  const [isCreating, setIsCreating] = useState(false);

  // F106 P1 fix: fetch bootcamp threads from API directly, not from sidebar-dependent store
  interface BootcampThreadSummary {
    id: string;
    title?: string;
    phase?: string;
    completedAt?: number;
    startedAt?: number;
    selectedTaskId?: string;
  }
  const [apiThreads, setApiThreads] = useState<BootcampThreadSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchBootcampThreads = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch('/api/bootcamp/threads');
      if (!res.ok) return;
      const data = await res.json();
      setApiThreads(data.threads ?? []);
    } catch {
      // fall through
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) fetchBootcampThreads();
  }, [open, fetchBootcampThreads]);

  if (!open) return null;

  const handleNavigate = (threadId: string) => {
    pushThreadRouteWithHistory(threadId, typeof window !== 'undefined' ? window : undefined);
    onClose();
  };

  const handleCreate = async () => {
    setIsCreating(true);
    try {
      const res = await apiFetch('/api/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: '🎓 猫猫训练营',
          bootcampState: { v: 1, phase: 'phase-0-select-cat', startedAt: Date.now() },
        }),
      });
      if (!res.ok) return;
      const thread: Thread = await res.json();
      setThreads([thread, ...storeThreads]);
      pushThreadRouteWithHistory(thread.id, typeof window !== 'undefined' ? window : undefined);
      onClose();
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="bootcamp-list-modal"
    >
      <div className="bg-cafe-surface rounded-2xl shadow-xl w-[480px] max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-cafe-subtle">
          <div className="flex items-center gap-2.5">
            <BootcampIcon className="w-6 h-6 text-amber-600" />
            <span className="text-lg font-semibold text-cafe">我的训练营</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-cafe-muted hover:text-cafe-secondary transition-colors"
            data-testid="bootcamp-list-close"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3">
          {isLoading ? (
            <p className="text-center text-cafe-muted py-8 text-sm">加载中...</p>
          ) : apiThreads.length === 0 ? (
            <p className="text-center text-cafe-muted py-8 text-sm">还没有训练营，点下面开始一个吧！</p>
          ) : (
            apiThreads.map((t) => {
              const isCompleted = !!t.completedAt;
              const isCurrent = t.id === currentThreadId;
              const progress = phaseProgress(t.phase);
              const phaseLabel = PHASE_LABELS[t.phase ?? ''] ?? t.phase ?? '?';
              const phaseIdx = PHASE_ORDER.indexOf(t.phase ?? '');
              const phaseNum = phaseIdx >= 0 ? phaseIdx + 1 : '?';

              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => handleNavigate(t.id)}
                  disabled={isCurrent}
                  className={`w-full text-left p-4 rounded-xl border transition-colors ${
                    isCurrent
                      ? 'border-amber-300 bg-amber-50 opacity-60 cursor-default'
                      : isCompleted
                        ? 'border-cafe bg-cafe-surface-elevated hover:bg-cafe-surface-elevated'
                        : 'border-amber-200 bg-amber-50/50 hover:bg-amber-50'
                  }`}
                  data-testid={`bootcamp-item-${t.id}`}
                >
                  {/* Top row: title + badge */}
                  <div className="flex items-center justify-between mb-2">
                    <span className={`text-[15px] font-semibold ${isCompleted ? 'text-cafe-secondary' : 'text-cafe'}`}>
                      {t.title ?? '🎓 猫猫训练营'}
                    </span>
                    <span
                      className={`text-xs font-medium px-2.5 py-1 rounded-full ${
                        isCompleted
                          ? 'bg-green-100 text-green-700'
                          : isCurrent
                            ? 'bg-amber-100 text-amber-700'
                            : 'bg-amber-100 text-amber-700'
                      }`}
                    >
                      {isCurrent ? '当前' : isCompleted ? '已完成 ✓' : '进行中'}
                    </span>
                  </div>
                  {/* Meta: task + phase */}
                  <div className="flex items-center justify-between text-[13px] text-cafe-secondary mb-2">
                    <div className="flex items-center gap-4">
                      {t.selectedTaskId && <span>⭐ {t.selectedTaskId}</span>}
                      <span>
                        Phase {phaseNum}/{PHASE_ORDER.length} · {phaseLabel}
                      </span>
                    </div>
                    {!isCurrent && (
                      <svg className="w-4 h-4 text-cafe-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    )}
                  </div>
                  {/* Progress bar */}
                  <div className="w-full h-1.5 rounded-full bg-cafe-surface-elevated">
                    <div
                      className={`h-1.5 rounded-full transition-all ${isCompleted ? 'bg-green-400' : 'bg-amber-400'}`}
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* Footer: create new */}
        <div className="px-6 py-4 border-t border-cafe-subtle flex justify-center">
          <button
            type="button"
            onClick={handleCreate}
            disabled={isCreating}
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-amber-500 text-white font-semibold hover:bg-amber-600 disabled:opacity-40 transition-colors"
            data-testid="bootcamp-list-create"
          >
            <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            {isCreating ? '创建中...' : '开始新训练营'}
          </button>
        </div>
      </div>
    </div>
  );
}
