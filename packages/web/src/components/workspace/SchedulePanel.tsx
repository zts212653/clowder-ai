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
    return <div className="flex-1 flex items-center justify-center text-sm text-cafe-muted">Loading schedule...</div>;
  }

  return (
    <div className="flex flex-col h-full bg-[var(--console-card-bg)]">
      {/* Scope filter bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--console-border-soft)]">
        <button
          type="button"
          onClick={() => setScope('all')}
          className={`px-2.5 py-1 rounded-full text-[10px] font-semibold transition-all ${
            scope === 'all'
              ? 'bg-[var(--console-pill-bg)] text-cafe-secondary border border-[var(--cafe-accent)]/40'
              : 'text-cafe-muted hover:text-cafe-secondary'
          }`}
        >
          All
        </button>
        <button
          type="button"
          onClick={() => setScope('current-thread')}
          className={`px-2.5 py-1 rounded-full text-[10px] font-semibold transition-all ${
            scope === 'current-thread'
              ? 'bg-[var(--console-pill-bg)] text-cafe-secondary border border-[var(--cafe-accent)]/40'
              : 'text-cafe-muted hover:text-cafe-secondary'
          }`}
        >
          Current Thread
        </button>
        <span className="ml-auto text-[10px] text-cafe-muted">
          {tasks.length} tasks · {activeCount} active{pausedCount > 0 ? ` · ${pausedCount} paused` : ''}
        </span>
      </div>

      {/* AC-D1: Global governance toggle */}
      {globalControl && (
        <div
          className={`flex items-center gap-2 px-4 py-1.5 border-b border-[var(--console-border-soft)] ${
            globalControl.enabled ? 'bg-[var(--console-card-bg)]' : 'bg-conn-red-bg'
          }`}
        >
          <button
            type="button"
            onClick={handleGlobalToggle}
            className={`relative w-7 h-4 rounded-full transition-colors ${
              globalControl.enabled ? 'bg-conn-emerald-bg' : 'bg-conn-red-bg'
            }`}
            title={globalControl.enabled ? 'Scheduler active — click to pause' : 'Scheduler paused — click to resume'}
          >
            <span
              className={`absolute top-0.5 w-3 h-3 rounded-full bg-cafe-surface shadow transition-transform ${
                globalControl.enabled ? 'left-3.5' : 'left-0.5'
              }`}
            />
          </button>
          <span
            className={`text-[10px] font-medium ${globalControl.enabled ? 'text-conn-emerald-text' : 'text-conn-red-text'}`}
          >
            {globalControl.enabled ? 'Scheduler active' : 'Scheduler paused'}
          </span>
          {!globalControl.enabled && globalControl.reason && (
            <span className="text-[10px] text-conn-red-text truncate max-w-[160px]">{globalControl.reason}</span>
          )}
        </div>
      )}

      {/* Current Thread context banner (V2 design) */}
      {scope === 'current-thread' && currentThreadId && (
        <div className="flex items-center gap-1.5 px-4 py-1.5 bg-[var(--console-pill-bg)]/60 border-b border-[var(--console-border-soft)]">
          <span className="text-[10px] text-cafe-muted">Showing tasks for:</span>
          <span className="text-[10px] font-medium text-cafe-secondary">{currentThreadId.slice(0, 12)}</span>
        </div>
      )}

      {/* Task list */}
      <div className="flex-1 overflow-y-auto">
        {filteredTasks.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-sm text-cafe-muted">No scheduled tasks</div>
        ) : (
          <div className="divide-y divide-[var(--console-border-soft)]">
            {filteredTasks.map((task) => {
              const category = task.display?.category ?? fallbackCategory(task.id);
              const label = task.display?.label ?? humanizeId(task.id);
              const preview = task.subjectPreview ?? task.display?.description ?? null;
              // Status dot: green=healthy, red=last run failed, gray=never run
              const statusDot = !task.lastRun
                ? 'bg-cafe-surface-sunken'
                : task.lastRun.outcome === 'RUN_FAILED'
                  ? 'bg-conn-red-bg'
                  : 'bg-conn-emerald-bg';
              const isExpanded = expandedId === task.id;
              return (
                <div key={task.id}>
                  <div
                    className="px-4 py-3 hover:bg-[var(--console-pill-bg)]/50 transition-colors cursor-pointer"
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
                      <span className="text-xs font-medium text-cafe-secondary truncate flex-1">{label}</span>
                      {task.source === 'dynamic' && (
                        <span className="px-1 py-0.5 rounded text-[8px] font-medium bg-conn-purple-bg text-conn-purple-text">
                          user
                        </span>
                      )}
                      <span className="text-[10px] text-cafe-muted font-mono">{formatTrigger(task.trigger)}</span>
                      <span className="text-[10px] text-cafe-muted">{isExpanded ? '\u25B4' : '\u25BE'}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1 ml-[52px]">
                      {task.lastRun ? (
                        <>
                          <span className={`text-xs font-medium ${outcomeColor(task.lastRun.outcome)}`}>
                            {outcomeIcon(task.lastRun.outcome)} {outcomeLabel(task.lastRun.outcome)}
                          </span>
                          <span className="text-[10px] text-cafe-muted">{timeAgo(task.lastRun.started_at)}</span>
                          {task.lastRun.outcome === 'RUN_FAILED' && task.lastRun.error_summary && (
                            <span
                              className="text-[10px] text-conn-red-text truncate max-w-[160px]"
                              title={task.lastRun.error_summary}
                            >
                              {task.lastRun.error_summary}
                            </span>
                          )}
                          {preview && task.lastRun.outcome !== 'RUN_FAILED' && (
                            <span className="text-[10px] text-cafe-muted truncate max-w-[140px]">{preview}</span>
                          )}
                        </>
                      ) : (
                        <span className="text-[10px] text-cafe-muted italic">never run</span>
                      )}
                      {task.runStats.delivered > 0 && (
                        <span className="ml-auto text-[10px] text-conn-emerald-text">
                          {task.runStats.delivered} delivered
                        </span>
                      )}
                      {!(task.effectiveEnabled ?? task.enabled) && (
                        <span className="ml-auto text-[9px] text-conn-red-text font-medium">PAUSED</span>
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
                          className="text-[10px] text-cafe-secondary hover:text-[var(--cafe-accent)] transition-colors"
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
                            className="text-[10px] text-cafe-muted hover:text-conn-red-text transition-colors"
                          >
                            Delete
                          </button>
                        )}
                      </div>
                      {/* Run history */}
                      <div className="text-[10px] text-cafe-muted font-medium">Recent runs:</div>
                      {runHistory.length === 0 ? (
                        <div className="text-[10px] text-cafe-muted italic">No run history</div>
                      ) : (
                        <div className="space-y-1">
                          {runHistory.map((r, i) => (
                            <div key={i} className="flex items-center gap-2 text-[10px]">
                              <span className={outcomeColor(r.outcome)}>{outcomeIcon(r.outcome)}</span>
                              <span className="text-cafe-muted">{timeAgo(r.started_at)}</span>
                              <span className="text-cafe-muted">{r.duration_ms}ms</span>
                              {r.error_summary && (
                                <span className="text-conn-red-text truncate max-w-[200px]">{r.error_summary}</span>
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
      <div className="px-4 py-1.5 border-t border-[var(--console-border-soft)] text-[10px] text-cafe-muted flex items-center">
        <span>
          {tasks.length} tasks · {activeCount} active{pausedCount > 0 ? ` · ${pausedCount} paused` : ''}
        </span>
        <span className={`ml-auto font-medium ${hasAttention ? 'text-conn-red-text' : 'text-conn-emerald-text'}`}>
          {hasAttention ? 'Attention needed' : 'All healthy'}
        </span>
      </div>

      {/* Conversational CTA (AC-G5: replaces NL input — W1 vision) */}
      <div className="px-4 py-2.5 bg-[var(--console-pill-bg)] border-t border-[var(--console-border-soft)]">
        <p className="text-[11px] text-cafe-muted text-center">
          Want to add a scheduled task? Tell any cat in the chat — e.g.
          <span className="text-cafe-secondary font-medium"> &quot;every morning at 9, check Anthropic news&quot;</span>
        </p>
      </div>
    </div>
  );
}
