'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';

import type { GlobalControlState, RunLedgerRow, ScheduleTask } from './schedule-helpers';
import {
  CATEGORY_LABELS,
  CATEGORY_STYLES,
  fallbackCategory,
  formatTrigger,
  humanizeId,
  outcomeColor,
  outcomeIcon,
  outcomeLabel,
  timeAgo,
} from './schedule-helpers';

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
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [runHistory, setRunHistory] = useState<RunLedgerRow[]>([]);
  const [globalControl, setGlobalControl] = useState<GlobalControlState | null>(null);
  const currentThreadId = useChatStore((s) => s.currentThreadId);

  const fetchTasks = useCallback(async () => {
    try {
      // #320: When scope is "current-thread", pass threadId to server for unified filtering
      const params =
        scope === 'current-thread' && currentThreadId ? `?threadId=${encodeURIComponent(currentThreadId)}` : '';
      const res = await apiFetch(`/api/schedule/tasks${params}`);
      if (res.ok) {
        const json = await res.json();
        setTasks(json.tasks ?? []);
      }
    } catch {
      // fail-open
    } finally {
      setLoading(false);
    }
  }, [scope, currentThreadId]);

  const fetchControl = useCallback(async () => {
    try {
      const res = await apiFetch('/api/schedule/control');
      if (res.ok) {
        const json = await res.json();
        setGlobalControl(json.global ?? null);
      }
    } catch {
      // fail-open — governance not configured
    }
  }, []);

  useEffect(() => {
    fetchTasks();
    fetchControl();
    const timer = setInterval(() => {
      fetchTasks();
      fetchControl();
    }, 30000);
    return () => clearInterval(timer);
  }, [fetchTasks, fetchControl]);

  const handleGlobalToggle = useCallback(async () => {
    if (!globalControl) return;
    const next = !globalControl.enabled;
    try {
      await apiFetch('/api/schedule/control', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next, reason: next ? null : 'Paused from panel', updatedBy: 'user' }),
      });
      fetchControl();
    } catch {
      /* fail-open */
    }
  }, [globalControl, fetchControl]);

  // #320: Server-side filtering via ?threadId= — no client-side extractThreadId needed
  const filteredTasks = tasks;

  const handleToggleExpand = useCallback(
    async (taskId: string) => {
      if (expandedId === taskId) {
        setExpandedId(null);
        setRunHistory([]);
        return;
      }
      setExpandedId(taskId);
      try {
        const params =
          scope === 'current-thread' && currentThreadId ? `&threadId=${encodeURIComponent(currentThreadId)}` : '';
        const res = await apiFetch(`/api/schedule/tasks/${encodeURIComponent(taskId)}/runs?limit=5${params}`);
        if (res.ok) {
          const json = await res.json();
          setRunHistory(json.runs ?? []);
        }
      } catch {
        setRunHistory([]);
      }
    },
    [currentThreadId, expandedId, scope],
  );

  /** AC-H4: toggle pause/resume for any task — routes to correct API by source */
  const handleToggleTask = useCallback(
    async (task: ScheduleTask) => {
      const isActive = task.effectiveEnabled ?? task.enabled;
      try {
        if (task.source === 'dynamic' && task.dynamicTaskId) {
          await apiFetch(`/api/schedule/tasks/${encodeURIComponent(task.dynamicTaskId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !isActive }),
          });
        } else {
          await apiFetch(`/api/schedule/control/tasks/${encodeURIComponent(task.id)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !isActive, updatedBy: 'user' }),
          });
        }
        fetchTasks();
        fetchControl();
      } catch {
        /* fail-open */
      }
    },
    [fetchTasks, fetchControl],
  );

  const handleDeleteDynamic = useCallback(
    async (taskId: string) => {
      try {
        const res = await apiFetch(`/api/schedule/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' });
        if (res.ok) fetchTasks();
      } catch {
        /* fail-open */
      }
    },
    [fetchTasks],
  );

  const activeCount = tasks.filter((t) => t.effectiveEnabled ?? t.enabled).length;
  const pausedCount = tasks.length - activeCount;
  // Health: check if ANY task's most recent run failed (not cumulative total)
  const hasAttention = tasks.some((t) => t.lastRun?.outcome === 'RUN_FAILED');

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

      {/* AC-D1: Global governance toggle */}
      {globalControl && (
        <div
          className={`flex items-center gap-2 px-4 py-1.5 border-b border-[#E8DFD4] ${
            globalControl.enabled ? 'bg-[#FDFAF6]' : 'bg-red-50'
          }`}
        >
          <button
            type="button"
            onClick={handleGlobalToggle}
            className={`relative w-7 h-4 rounded-full transition-colors ${
              globalControl.enabled ? 'bg-emerald-400' : 'bg-red-300'
            }`}
            title={globalControl.enabled ? 'Scheduler active — click to pause' : 'Scheduler paused — click to resume'}
          >
            <span
              className={`absolute top-0.5 w-3 h-3 rounded-full bg-cafe-surface shadow transition-transform ${
                globalControl.enabled ? 'left-3.5' : 'left-0.5'
              }`}
            />
          </button>
          <span className={`text-[10px] font-medium ${globalControl.enabled ? 'text-emerald-700' : 'text-red-600'}`}>
            {globalControl.enabled ? 'Scheduler active' : 'Scheduler paused'}
          </span>
          {!globalControl.enabled && globalControl.reason && (
            <span className="text-[10px] text-red-400 truncate max-w-[160px]">{globalControl.reason}</span>
          )}
        </div>
      )}

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
              const category = task.display?.category ?? fallbackCategory(task.id);
              const label = task.display?.label ?? humanizeId(task.id);
              const preview = task.subjectPreview ?? task.display?.description ?? null;
              // Status dot: green=healthy, red=last run failed, gray=never run
              const statusDot = !task.lastRun
                ? 'bg-gray-300'
                : task.lastRun.outcome === 'RUN_FAILED'
                  ? 'bg-red-400'
                  : 'bg-emerald-400';
              const isExpanded = expandedId === task.id;
              return (
                <div key={task.id}>
                  <div
                    className="px-4 py-3 hover:bg-[#F5EDE3]/50 transition-colors cursor-pointer"
                    onClick={() => handleToggleExpand(task.id)}
                    onKeyDown={(e) => e.key === 'Enter' && handleToggleExpand(task.id)}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${statusDot}`}
                        title={task.lastRun?.outcome ?? 'never run'}
                      />
                      <span
                        className={`px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${CATEGORY_STYLES[category]}`}
                      >
                        {CATEGORY_LABELS[category]}
                      </span>
                      <span className="text-xs font-medium text-[#5C4B3A] truncate flex-1">{label}</span>
                      {task.source === 'dynamic' && (
                        <span className="px-1 py-0.5 rounded text-[8px] font-medium bg-violet-50 text-violet-500">
                          user
                        </span>
                      )}
                      <span className="text-[10px] text-[#9A866F] font-mono">{formatTrigger(task.trigger)}</span>
                      <span className="text-[10px] text-[#9A866F]">{isExpanded ? '\u25B4' : '\u25BE'}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1 ml-[52px]">
                      {task.lastRun ? (
                        <>
                          <span className={`text-xs font-medium ${outcomeColor(task.lastRun.outcome)}`}>
                            {outcomeIcon(task.lastRun.outcome)} {outcomeLabel(task.lastRun.outcome)}
                          </span>
                          <span className="text-[10px] text-[#9A866F]">{timeAgo(task.lastRun.started_at)}</span>
                          {task.lastRun.outcome === 'RUN_FAILED' && task.lastRun.error_summary && (
                            <span
                              className="text-[10px] text-red-400 truncate max-w-[160px]"
                              title={task.lastRun.error_summary}
                            >
                              {task.lastRun.error_summary}
                            </span>
                          )}
                          {preview && task.lastRun.outcome !== 'RUN_FAILED' && (
                            <span className="text-[10px] text-[#B8A594] truncate max-w-[140px]">{preview}</span>
                          )}
                        </>
                      ) : (
                        <span className="text-[10px] text-[#9A866F] italic">never run</span>
                      )}
                      {task.runStats.delivered > 0 && (
                        <span className="ml-auto text-[10px] text-emerald-600">
                          {task.runStats.delivered} delivered
                        </span>
                      )}
                      {!(task.effectiveEnabled ?? task.enabled) && (
                        <span className="ml-auto text-[9px] text-red-400 font-medium">PAUSED</span>
                      )}
                    </div>
                  </div>
                  {/* AC-F4: expandable detail panel with run history */}
                  {isExpanded && (
                    <div className="px-4 pb-3 ml-[52px] space-y-2">
                      {/* AC-H4: Controls for all tasks — pause/resume universal, delete for dynamic only */}
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleTask(task);
                          }}
                          className="text-[10px] text-[#5C4B3A] hover:text-[#D4A574] transition-colors"
                        >
                          {(task.effectiveEnabled ?? task.enabled) ? '\u23F8 Pause' : '\u25B6 Resume'}
                        </button>
                        {task.source === 'dynamic' && task.dynamicTaskId && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteDynamic(task.dynamicTaskId!);
                            }}
                            className="text-[10px] text-[#9A866F] hover:text-red-500 transition-colors"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                      {/* Run history */}
                      <div className="text-[10px] text-[#9A866F] font-medium">Recent runs:</div>
                      {runHistory.length === 0 ? (
                        <div className="text-[10px] text-[#9A866F] italic">No run history</div>
                      ) : (
                        <div className="space-y-1">
                          {runHistory.map((r, i) => (
                            <div key={i} className="flex items-center gap-2 text-[10px]">
                              <span className={outcomeColor(r.outcome)}>{outcomeIcon(r.outcome)}</span>
                              <span className="text-[#9A866F]">{timeAgo(r.started_at)}</span>
                              <span className="text-[#9A866F]">{r.duration_ms}ms</span>
                              {r.error_summary && (
                                <span className="text-red-400 truncate max-w-[200px]">{r.error_summary}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer: health summary (AC-F1) */}
      <div className="px-4 py-1.5 border-t border-[#E8DFD4] text-[10px] text-[#9A866F] flex items-center">
        <span>
          {tasks.length} tasks · {activeCount} active{pausedCount > 0 ? ` · ${pausedCount} paused` : ''}
        </span>
        <span className={`ml-auto font-medium ${hasAttention ? 'text-red-500' : 'text-emerald-600'}`}>
          {hasAttention ? 'Attention needed' : 'All healthy'}
        </span>
      </div>

      {/* Conversational CTA (AC-G5: replaces NL input — W1 vision) */}
      <div className="px-4 py-2.5 bg-[#F5EDE3] border-t border-[#E8DFD4]">
        <p className="text-[11px] text-[#9A866F] text-center">
          Want to add a scheduled task? Tell any cat in the chat — e.g.
          <span className="text-[#5C4B3A] font-medium"> &quot;every morning at 9, check Anthropic news&quot;</span>
        </p>
      </div>
    </div>
  );
}
