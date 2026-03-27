'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

/* ── Types ───────────────────────────────────── */

interface RunLedgerRow {
  task_id: string;
  subject_key: string;
  outcome: string;
  signal_summary: string | null;
  duration_ms: number;
  started_at: string;
  assigned_cat_id: string | null;
}

interface RunStats {
  total: number;
  delivered: number;
  failed: number;
  skipped: number;
}

interface TriggerSpec {
  type: 'interval' | 'cron';
  ms?: number;
  expression?: string;
}

interface ScheduleTask {
  id: string;
  profile: string;
  trigger: TriggerSpec;
  enabled: boolean;
  actor?: { role: string; costTier: string };
  context?: { session: string; materialization: string };
  lastRun: RunLedgerRow | null;
  runStats: RunStats;
}

/* ── Helpers ──────────────────────────────────── */

type TaskCategory = 'PR' | 'Repo' | 'System' | 'Custom';

const CATEGORY_STYLES: Record<TaskCategory, string> = {
  PR: 'bg-blue-100 text-blue-700',
  Repo: 'bg-emerald-100 text-emerald-700',
  System: 'bg-amber-100 text-amber-700',
  Custom: 'bg-purple-100 text-purple-700',
};

const CATEGORY_DOT: Record<TaskCategory, string> = {
  PR: 'bg-[#E8913A]',
  Repo: 'bg-emerald-500',
  System: 'bg-amber-500',
  Custom: 'bg-purple-500',
};

function categorize(taskId: string): TaskCategory {
  if (taskId.includes('review') || taskId.includes('conflict')) return 'PR';
  if (taskId.includes('cicd') || taskId.includes('repo') || taskId.includes('issue')) return 'Repo';
  if (taskId.includes('summary') || taskId.includes('compact') || taskId.includes('health')) return 'System';
  return 'Custom';
}

function formatTrigger(trigger: TriggerSpec): string {
  if (trigger.type === 'cron') return `cron: ${trigger.expression}`;
  const ms = trigger.ms ?? 0;
  if (ms >= 3600000) return `${Math.round(ms / 3600000)}h`;
  if (ms >= 60000) return `${Math.round(ms / 60000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function outcomeIcon(outcome: string): string {
  if (outcome === 'RUN_DELIVERED') return '\u2713';
  if (outcome === 'RUN_FAILED') return '\u2717';
  return '\u2013';
}

function outcomeColor(outcome: string): string {
  if (outcome === 'RUN_DELIVERED') return 'text-emerald-600';
  if (outcome === 'RUN_FAILED') return 'text-red-500';
  return 'text-gray-400';
}

function outcomeLabel(outcome: string): string {
  if (outcome === 'RUN_DELIVERED') return 'delivered';
  if (outcome === 'RUN_FAILED') return 'failed';
  if (outcome.startsWith('SKIP_')) return 'idle';
  return outcome.toLowerCase();
}

function extractThreadId(subjectKey: string): string | null {
  if (subjectKey.startsWith('thread-')) return subjectKey.slice(7);
  if (subjectKey.startsWith('thread:')) return subjectKey.slice(7);
  return null;
}

function humanizeId(id: string): string {
  return id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function humanizeSubject(subjectKey: string): string {
  if (subjectKey.startsWith('thread-') || subjectKey.startsWith('thread:')) {
    const id = subjectKey.slice(7);
    return id ? `Thread ${id.slice(0, 8)}` : 'Thread';
  }
  if (subjectKey.startsWith('pr-')) return subjectKey.slice(3);
  if (subjectKey.startsWith('repo:')) return subjectKey.slice(5);
  return subjectKey;
}

/* ── Component ───────────────────────────────── */

type ScopeFilter = 'all' | 'current-thread';

/**
 * F139 Phase 2: Schedule Panel — Workspace 调度 Tab
 * UX V2: flat list + colored type tags + scope filter + NL CTA
 */
export function SchedulePanel() {
  const [tasks, setTasks] = useState<ScheduleTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<ScopeFilter>('all');
  const [nlInput, setNlInput] = useState('');
  const currentThreadId = useChatStore((s) => s.currentThreadId);

  const fetchTasks = useCallback(async () => {
    try {
      const res = await apiFetch('/api/schedule/tasks');
      if (res.ok) {
        const json = await res.json();
        setTasks(json.tasks ?? []);
      }
    } catch {
      // fail-open
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
    const timer = setInterval(fetchTasks, 30000);
    return () => clearInterval(timer);
  }, [fetchTasks]);

  // AC-C3b-2: scope filtering — Current Thread shows only thread-associated tasks matching currentThreadId
  // AC-C3b-3: non-thread tasks (pr-, repo-) only visible in All view (threadId 可空 per AC)
  const filteredTasks = useMemo(() => {
    if (scope === 'all') return tasks;
    return tasks.filter((t) => {
      if (!t.lastRun) return true; // no run yet → show everywhere
      const tid = extractThreadId(t.lastRun.subject_key);
      // P1-2 fix: non-thread tasks (pr-, repo-) should NOT appear in Current Thread
      return tid !== null && tid === currentThreadId;
    });
  }, [tasks, scope, currentThreadId]);

  const handleNlSubmit = useCallback(async () => {
    if (!nlInput.trim()) return;
    try {
      await apiFetch('/api/schedule/nl-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: nlInput.trim() }),
      });
      setNlInput('');
      fetchTasks();
    } catch {
      // fail-open
    }
  }, [nlInput, fetchTasks]);

  const activeCount = tasks.filter((t) => t.enabled).length;
  const pausedCount = tasks.length - activeCount;
  const totalFailed = tasks.reduce((sum, t) => sum + t.runStats.failed, 0);

  if (loading) {
    return <div className="flex-1 flex items-center justify-center text-sm text-[#9A866F]">Loading schedule...</div>;
  }

  return (
    <div className="flex flex-col h-full bg-[#FDFAF6]">
      {/* Scope filter bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[#E8DFD4]">
        <button
          type="button"
          onClick={() => setScope('all')}
          className={`px-2.5 py-1 rounded-full text-[10px] font-semibold transition-all ${
            scope === 'all'
              ? 'bg-[#F5EDE3] text-[#5C4B3A] border border-[#D4A574]/40'
              : 'text-[#9A866F] hover:text-[#5C4B3A]'
          }`}
        >
          All
        </button>
        <button
          type="button"
          onClick={() => setScope('current-thread')}
          className={`px-2.5 py-1 rounded-full text-[10px] font-semibold transition-all ${
            scope === 'current-thread'
              ? 'bg-[#F5EDE3] text-[#5C4B3A] border border-[#D4A574]/40'
              : 'text-[#9A866F] hover:text-[#5C4B3A]'
          }`}
        >
          Current Thread
        </button>
        <span className="ml-auto text-[10px] text-[#9A866F]">
          {tasks.length} tasks · {activeCount} active{pausedCount > 0 ? ` · ${pausedCount} paused` : ''}
        </span>
      </div>

      {/* Current Thread context banner (V2 design) */}
      {scope === 'current-thread' && currentThreadId && (
        <div className="flex items-center gap-1.5 px-4 py-1.5 bg-[#F5EDE3]/60 border-b border-[#E8DFD4]">
          <span className="text-[10px] text-[#9A866F]">Showing tasks for:</span>
          <span className="text-[10px] font-medium text-[#5C4B3A]">{currentThreadId.slice(0, 12)}</span>
        </div>
      )}

      {/* Task list */}
      <div className="flex-1 overflow-y-auto">
        {filteredTasks.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-sm text-[#9A866F]">No scheduled tasks</div>
        ) : (
          <div className="divide-y divide-[#E8DFD4]">
            {filteredTasks.map((task) => {
              const category = categorize(task.id);
              return (
                <div key={task.id} className="px-4 py-3 hover:bg-[#F5EDE3]/50 transition-colors">
                  <div className="flex items-center gap-2">
                    {/* Color dot (V2 design) */}
                    <span className={`w-2 h-2 rounded-full shrink-0 ${CATEGORY_DOT[category]}`} />
                    {/* Type tag */}
                    <span
                      className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${CATEGORY_STYLES[category]}`}
                    >
                      {category}
                    </span>
                    {/* Task name */}
                    <span className="text-xs font-medium text-[#5C4B3A] truncate flex-1">{humanizeId(task.id)}</span>
                    {/* Trigger badge */}
                    <span className="text-[10px] text-[#9A866F] font-mono">{formatTrigger(task.trigger)}</span>
                  </div>

                  {/* Status row */}
                  <div className="flex items-center gap-2 mt-1 ml-[52px]">
                    {task.lastRun ? (
                      <>
                        <span className={`text-xs font-medium ${outcomeColor(task.lastRun.outcome)}`}>
                          {outcomeIcon(task.lastRun.outcome)} {outcomeLabel(task.lastRun.outcome)}
                        </span>
                        <span className="text-[10px] text-[#9A866F]">{timeAgo(task.lastRun.started_at)}</span>
                        {task.lastRun.subject_key !== task.id && (
                          <span className="text-[10px] text-[#B8A594] truncate max-w-[140px]">
                            {humanizeSubject(task.lastRun.subject_key)}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-[10px] text-[#9A866F] italic">never run</span>
                    )}
                    {task.runStats.delivered > 0 && (
                      <span className="ml-auto text-[10px] text-emerald-600">{task.runStats.delivered} delivered</span>
                    )}
                    {!task.enabled && <span className="ml-auto text-[9px] text-red-400 font-medium">PAUSED</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer stats (V2 design) */}
      <div className="px-4 py-1.5 border-t border-[#E8DFD4] text-[10px] text-[#9A866F] flex items-center">
        <span>
          {tasks.length} tasks · {activeCount} active{pausedCount > 0 ? ` · ${pausedCount} paused` : ''}
        </span>
        <span className={`ml-auto font-medium ${totalFailed > 0 ? 'text-red-500' : 'text-emerald-600'}`}>
          {totalFailed > 0 ? `${totalFailed} failed` : 'All healthy'}
        </span>
      </div>

      {/* NL config CTA (AC-C4) */}
      <div className="px-4 py-3 bg-[#F5EDE3] border-t border-[#E8DFD4]">
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="用自然语言添加任务..."
            className="flex-1 px-3 py-2 rounded-lg bg-white/80 text-sm text-[#5C4B3A] placeholder-[#9A866F] border border-[#E8DFD4] focus:border-[#D4A574] focus:outline-none transition-colors"
            value={nlInput}
            onChange={(e) => setNlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleNlSubmit();
            }}
          />
          <button
            type="button"
            onClick={handleNlSubmit}
            className="px-3 py-2 rounded-lg bg-[#D4A574] text-white text-sm font-medium hover:bg-[#C49564] transition-colors"
          >
            添加
          </button>
        </div>
      </div>
    </div>
  );
}
