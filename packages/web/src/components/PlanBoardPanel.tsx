'use client';

import { useMemo, useState } from 'react';
import { formatCatName, useCatData } from '@/hooks/useCatData';
import { useSendMessage } from '@/hooks/useSendMessage';
import type { CatInvocationInfo } from '@/stores/chatStore';
import { buildContinueMessage } from '@/utils/taskProgressContinue';

export interface PlanBoardPanelProps {
  threadId: string;
  catInvocations: Record<string, CatInvocationInfo>;
}

function TaskStatusIcon({ status }: { status: 'completed' | 'in_progress' | 'pending' }) {
  if (status === 'completed') {
    return (
      <svg
        className="w-3.5 h-3.5 text-emerald-600"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
      </svg>
    );
  }
  if (status === 'in_progress') {
    return (
      <svg
        className="w-3.5 h-3.5 text-blue-600 animate-spin"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v6h6M20 20v-6h-6" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M20 9a8 8 0 00-14.9-3M4 15a8 8 0 0014.9 3" />
      </svg>
    );
  }
  return (
    <svg className="w-3.5 h-3.5 text-gray-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  );
}

function taskStatusA11yText(status: 'completed' | 'in_progress' | 'pending'): string {
  if (status === 'completed') return '已完成';
  if (status === 'in_progress') return '进行中';
  return '待处理';
}

/* ── Per-cat plan card ────────────────────────────────────── */

function PlanCard({ catId, threadId, inv }: { catId: string; threadId: string; inv: CatInvocationInfo }) {
  const { getCatById } = useCatData();
  const { handleSend } = useSendMessage(threadId);
  const cat = getCatById(catId);
  const dotColor = cat?.color.primary ?? '#9CA3AF';
  const tp = inv.taskProgress!;
  const { tasks } = tp;
  const completed = tasks.filter((t) => t.status === 'completed').length;
  const status = tp.snapshotStatus;

  const statusLabel =
    status === 'completed' ? '已完成' : status === 'interrupted' ? '已中断' : status === 'running' ? '运行中' : null;
  const statusTone =
    status === 'completed'
      ? 'bg-green-100 text-green-700'
      : status === 'interrupted'
        ? 'bg-rose-100 text-rose-700'
        : status === 'running'
          ? 'bg-blue-100 text-blue-700'
          : 'bg-gray-100 text-gray-600';

  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-1.5">
          <span
            className={`inline-block h-2 w-2 rounded-full ${status === 'running' ? 'animate-pulse' : ''}`}
            style={{ backgroundColor: dotColor }}
          />
          <span className="text-[11px] font-medium text-gray-700">{cat ? formatCatName(cat) : catId}</span>
          <span className="text-[10px] text-gray-400">
            {completed}/{tasks.length}
          </span>
          {statusLabel && <span className={`text-[9px] px-1 py-0.5 rounded ${statusTone}`}>{statusLabel}</span>}
        </div>
        {status === 'interrupted' && (
          <button
            className="text-[10px] px-2 py-0.5 rounded-full border border-gray-300 hover:border-gray-400 hover:bg-gray-100 transition-colors"
            onClick={() => {
              const ok = window.confirm('确认继续上次任务？');
              if (!ok) return;
              void handleSend(buildContinueMessage(catId, tp), undefined, threadId);
            }}
          >
            继续
          </button>
        )}
      </div>
      <div className="space-y-0.5 ml-3.5">
        {tasks.map((t) => {
          const taskText = t.status === 'in_progress' ? (t.activeForm ?? t.subject) : t.subject;
          return (
            <div key={t.id} className="flex items-start gap-1 text-[11px] leading-tight">
              <span className="sr-only">{taskStatusA11yText(t.status)} </span>
              <span className="mt-px flex-shrink-0" aria-hidden="true">
                <TaskStatusIcon status={t.status} />
              </span>
              <span className={t.status === 'completed' ? 'text-gray-400 line-through' : 'text-gray-700'}>
                {taskText}
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-1 ml-3.5 h-1 bg-gray-200 rounded-full overflow-hidden">
        <div
          className="h-full bg-green-500 rounded-full transition-all duration-300"
          style={{ width: `${Math.round((completed / tasks.length) * 100)}%` }}
        />
      </div>
    </div>
  );
}

/* ── Main panel ───────────────────────────────────────────── */

export function PlanBoardPanel({ threadId, catInvocations }: PlanBoardPanelProps) {
  const [completedOpen, setCompletedOpen] = useState(false);

  const { runningCats, interruptedCats, completedCats } = useMemo(() => {
    const running: Array<[string, CatInvocationInfo]> = [];
    const interrupted: Array<[string, CatInvocationInfo]> = [];
    const completed: Array<[string, CatInvocationInfo]> = [];

    for (const [catId, inv] of Object.entries(catInvocations)) {
      const tp = inv.taskProgress;
      if (!tp || tp.tasks.length === 0) continue;

      if (tp.snapshotStatus === 'completed') {
        completed.push([catId, inv]);
      } else if (tp.snapshotStatus === 'interrupted') {
        interrupted.push([catId, inv]);
      } else {
        running.push([catId, inv]);
      }
    }

    running.sort((a, b) => (b[1].startedAt ?? 0) - (a[1].startedAt ?? 0));
    completed.sort((a, b) => (b[1].taskProgress?.lastUpdate ?? 0) - (a[1].taskProgress?.lastUpdate ?? 0));

    return { runningCats: running, interruptedCats: interrupted, completedCats: completed };
  }, [catInvocations]);

  const totalCats = runningCats.length + interruptedCats.length + completedCats.length;
  if (totalCats === 0) return null;

  return (
    <section className="rounded-lg border border-gray-200 bg-gray-50/70 p-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold text-gray-700">猫猫祟祟 ({totalCats})</h3>
      </div>

      {/* Running cats */}
      {runningCats.map(([catId, inv]) => (
        <PlanCard key={catId} catId={catId} threadId={threadId} inv={inv} />
      ))}

      {/* Interrupted cats */}
      {interruptedCats.map(([catId, inv]) => (
        <PlanCard key={catId} catId={catId} threadId={threadId} inv={inv} />
      ))}

      {/* Completed cats — folded */}
      {completedCats.length > 0 && (
        <div className="mt-2 border-t border-gray-200 pt-2">
          <button
            onClick={() => setCompletedOpen((v) => !v)}
            className="w-full flex items-center justify-between text-[10px] text-gray-500 hover:text-gray-700"
          >
            <span>已完成 ({completedCats.length})</span>
            <span>{completedOpen ? '▲' : '▼'}</span>
          </button>
          {completedOpen && (
            <div className="mt-1">
              {completedCats.map(([catId, inv]) => (
                <PlanCard key={catId} catId={catId} threadId={threadId} inv={inv} />
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
