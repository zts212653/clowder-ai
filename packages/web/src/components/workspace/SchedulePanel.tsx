'use client';

import { useState } from 'react';
import { useShellCopy } from '@/components/shell/shell-copy';
import { useShellLanguage } from '@/components/shell/shell-language';
import { useWorkspaceSurfaceVisibility } from '@/components/workbench/WorkspaceSurfaceVisibility';
import { useChatStore } from '@/stores/chatStore';
import { CompactLabel, CriticalText, ExpandableProse } from '../content-overflow';
import {
  CATEGORY_STYLES,
  fallbackCategory,
  formatTrigger,
  humanizeId,
  outcomeColor,
  outcomeIcon,
  outcomeLabel,
  timeAgo,
} from './schedule-helpers';
import { schedulePanelCopy } from './schedule-panel.shell-copy';
import { useSchedulePanelData } from './useSchedulePanelData';

/* ── Component ───────────────────────────────── */

type ScopeFilter = 'all' | 'current-thread';

/**
 * F139 Phase 2: Schedule Panel — Workspace 调度 Tab
 * UX V2: flat list + colored type tags + scope filter + NL CTA
 */
export function SchedulePanel() {
  const t = useShellCopy(schedulePanelCopy);
  const language = useShellLanguage();
  const [scope, setScope] = useState<ScopeFilter>('all');
  const currentThreadId = useChatStore((s) => s.currentThreadId);
  const surfaceVisible = useWorkspaceSurfaceVisibility();
  const {
    tasks,
    loading,
    tasksError,
    globalControl,
    expandedId,
    runHistory,
    handleGlobalToggle,
    handleToggleTask,
    handleDeleteDynamic,
    handleToggleExpand,
  } = useSchedulePanelData(scope === 'all' ? undefined : currentThreadId || null, surfaceVisible);

  const activeCount = tasks.filter((t) => t.effectiveEnabled ?? t.enabled).length;
  const pausedCount = tasks.length - activeCount;
  // Health: check if ANY task's most recent run failed (not cumulative total)
  const hasAttention = tasks.some((t) => t.lastRun?.outcome === 'RUN_FAILED');

  return (
    <div className="flex flex-col h-full bg-cafe-surface">
      {/* Scope filter bar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-cafe-subtle">
        <button
          type="button"
          onClick={() => setScope('all')}
          className={`px-2.5 py-1 rounded-full text-micro font-semibold transition-all ${
            scope === 'all'
              ? 'bg-cafe-surface-elevated text-cafe border border-cafe-accent/40'
              : 'text-cafe-muted hover:text-cafe'
          }`}
        >
          {t.all}
        </button>
        <button
          type="button"
          onClick={() => setScope('current-thread')}
          className={`px-2.5 py-1 rounded-full text-micro font-semibold transition-all ${
            scope === 'current-thread'
              ? 'bg-cafe-surface-elevated text-cafe border border-cafe-accent/40'
              : 'text-cafe-muted hover:text-cafe'
          }`}
        >
          {t.currentThread}
        </button>
        <span className="ml-auto text-micro text-cafe-muted">
          {loading ? t.loading : tasksError ? t.unverified : t.counts(tasks.length, activeCount, pausedCount)}
        </span>
      </div>

      {/* AC-D1: Global governance toggle */}
      {globalControl && (
        <div
          className={`flex items-center gap-2 px-4 py-1.5 border-b border-cafe-subtle ${
            globalControl.enabled ? 'bg-cafe-surface' : 'bg-conn-red-bg'
          }`}
        >
          <button
            type="button"
            onClick={handleGlobalToggle}
            className={`relative w-7 h-4 rounded-full transition-colors ${
              globalControl.enabled ? 'bg-conn-emerald-text' : 'bg-conn-red-text'
            }`}
            title={globalControl.enabled ? t.pauseHint : t.resumeHint}
          >
            <span
              className={`absolute top-0.5 w-3 h-3 rounded-full bg-cafe-surface shadow transition-transform ${
                globalControl.enabled ? 'left-3.5' : 'left-0.5'
              }`}
            />
          </button>
          <span
            className={`text-micro font-medium ${globalControl.enabled ? 'text-conn-emerald-text' : 'text-conn-red-text'}`}
          >
            {globalControl.enabled ? t.active : t.paused}
          </span>
          {!globalControl.enabled && globalControl.reason && (
            <div data-testid="schedule-global-reason" className="min-w-0 flex-1">
              <CriticalText summary={t.paused} details={globalControl.reason} tone="warning" />
            </div>
          )}
        </div>
      )}

      {/* Current Thread context banner (V2 design) */}
      {scope === 'current-thread' && currentThreadId && (
        <div className="flex items-center gap-1.5 px-4 py-1.5 bg-cafe-surface-elevated/60 border-b border-cafe-subtle">
          <span className="text-micro text-cafe-muted">{t.currentScope}</span>
          <span className="text-micro font-medium text-cafe">{currentThreadId.slice(0, 12)}</span>
        </div>
      )}

      {/* Task list */}
      <div className="flex-1 overflow-y-auto">
        {tasksError && <output className="block px-4 py-2 text-sm text-cafe-muted">{tasksError}</output>}
        {loading ? (
          <div className="flex items-center justify-center h-32 text-sm text-cafe-muted">{t.loading}</div>
        ) : tasks.length === 0 ? (
          !tasksError && <div className="flex items-center justify-center h-32 text-sm text-cafe-muted">{t.empty}</div>
        ) : (
          <div className="space-y-0.5">
            {tasks.map((task) => {
              const taskEnabled = task.effectiveEnabled ?? task.enabled;
              const category = task.display?.category ?? fallbackCategory(task.id);
              const label = task.display?.label ?? humanizeId(task.id);
              const preview = task.subjectPreview ?? task.display?.description ?? null;
              const subjectKey = task.lastRun?.subject_key ?? null;
              // Status dot: green=healthy, red=last run failed, gray=never run
              const statusDot = !task.lastRun
                ? 'bg-conn-gray-text'
                : task.lastRun.outcome === 'RUN_FAILED'
                  ? 'bg-conn-red-text'
                  : 'bg-conn-emerald-text';
              const isExpanded = expandedId === task.id;
              return (
                <div key={task.id}>
                  <div
                    className="px-4 py-3 hover:bg-cafe-surface-elevated/50 transition-colors cursor-pointer"
                    onClick={() => handleToggleExpand(task.id)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      handleToggleExpand(task.id);
                    }}
                    role="button"
                    tabIndex={0}
                    aria-expanded={isExpanded}
                    aria-controls={`schedule-task-detail-${task.id}`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${statusDot}`}
                        title={task.lastRun ? outcomeLabel(task.lastRun.outcome, language) : t.neverRun}
                      />
                      <span
                        className={`px-1.5 py-0.5 rounded text-micro font-bold uppercase ${CATEGORY_STYLES[category]}`}
                      >
                        {t.categories[category]}
                      </span>
                      <span className="text-xs font-medium text-cafe truncate flex-1">{label}</span>
                      {task.source === 'dynamic' && (
                        <span className="px-1 py-0.5 rounded text-micro font-medium bg-conn-violet-bg text-conn-violet-text">
                          {t.dynamic}
                        </span>
                      )}
                      <span className="text-micro text-cafe-muted font-mono">
                        {formatTrigger(task.trigger, language)}
                      </span>
                      <span className="text-micro text-cafe-muted">{isExpanded ? '\u25B4' : '\u25BE'}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-1 ml-[52px]">
                      {task.lastRun ? (
                        <>
                          <span className={`text-xs font-medium ${outcomeColor(task.lastRun.outcome)}`}>
                            {outcomeIcon(task.lastRun.outcome)} {outcomeLabel(task.lastRun.outcome, language)}
                          </span>
                          <span className="text-micro text-cafe-muted">
                            {timeAgo(task.lastRun.started_at, language)}
                          </span>
                          {task.lastRun.outcome === 'RUN_FAILED' && task.lastRun.error_summary && (
                            <div data-testid={`schedule-latest-error-${task.id}`} className="min-w-0 flex-1">
                              <CriticalText
                                summary={t.latestFailure}
                                details={task.lastRun.error_summary}
                                tone="critical"
                              />
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="text-micro text-cafe-muted italic">{t.neverRun}</span>
                      )}
                      {task.runStats.delivered > 0 && (
                        <span className="ml-auto text-micro text-conn-emerald-text">
                          {t.deliveredCount(task.runStats.delivered)}
                        </span>
                      )}
                      {!taskEnabled && (
                        <span className="ml-auto text-micro text-conn-red-text font-medium">{t.taskPaused}</span>
                      )}
                    </div>
                  </div>
                  {preview &&
                    task.lastRun?.outcome !== 'RUN_FAILED' &&
                    (task.subjectPreview ? (
                      <div
                        data-testid={`schedule-subject-preview-${task.id}`}
                        className="ml-[104px] max-w-[320px] pb-2 text-micro leading-4 text-cafe-secondary"
                      >
                        {preview}
                      </div>
                    ) : (
                      <ExpandableProse
                        text={preview}
                        lines={2}
                        className="ml-[104px] max-w-[320px] pb-2"
                        contentClassName="text-micro leading-4 text-cafe-secondary"
                      />
                    ))}
                  {/* AC-F4: expandable detail panel with run history */}
                  {isExpanded && (
                    <div id={`schedule-task-detail-${task.id}`} className="px-4 pb-3 ml-[52px] space-y-2">
                      {subjectKey && (
                        <div
                          data-testid={`schedule-subject-key-${task.id}`}
                          className="flex min-w-0 items-center gap-2"
                        >
                          <span className="shrink-0 text-micro font-medium text-cafe-muted">{t.subject}</span>
                          <CompactLabel
                            label={t.subjectLabel}
                            value={subjectKey}
                            className="min-w-0 flex-1 text-micro text-cafe-secondary"
                          />
                        </div>
                      )}
                      {/* AC-H4: Controls for all tasks — pause/resume universal, delete for dynamic only */}
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleTask(task);
                          }}
                          className="text-micro text-cafe hover:text-cafe-accent transition-colors"
                        >
                          {taskEnabled ? '\u23F8' : '\u25B6'} {taskEnabled ? t.pauseTask : t.resumeTask}
                        </button>
                        {task.source === 'dynamic' && task.dynamicTaskId && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteDynamic(task.dynamicTaskId!);
                            }}
                            className="text-micro text-cafe-muted hover:text-conn-red-text transition-colors"
                          >
                            {t.deleteTask}
                          </button>
                        )}
                      </div>
                      {/* Run history */}
                      <div className="text-micro text-cafe-muted font-medium">{t.recentRuns}</div>
                      {runHistory.length === 0 ? (
                        <div className="text-micro text-cafe-muted italic">{t.noRuns}</div>
                      ) : (
                        <div className="space-y-1">
                          {runHistory.map((r, i) => (
                            <div key={i} className="flex items-start gap-2 text-micro">
                              <span className={outcomeColor(r.outcome)}>{outcomeIcon(r.outcome)}</span>
                              <span className="text-cafe-muted">{timeAgo(r.started_at, language)}</span>
                              <span className="text-cafe-muted">{t.duration(r.duration_ms)}</span>
                              {r.error_summary && (
                                <div data-testid={`schedule-history-error-${task.id}-${i}`} className="min-w-0 flex-1">
                                  <CriticalText summary={t.failureDetails} details={r.error_summary} tone="critical" />
                                </div>
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
      {!loading && !tasksError && (
        <div className="px-4 py-1.5 border-t border-cafe-subtle text-micro text-cafe-muted flex items-center">
          <span>{t.counts(tasks.length, activeCount, pausedCount)}</span>
          <span className={`ml-auto font-medium ${hasAttention ? 'text-conn-red-text' : 'text-conn-emerald-text'}`}>
            {tasksError ? t.unverified : hasAttention ? t.attention : t.healthy}
          </span>
        </div>
      )}

      {/* Conversational CTA (AC-G5: replaces NL input — W1 vision) */}
      <div className="px-4 py-2.5 bg-cafe-surface-elevated border-t border-cafe-subtle">
        <p className="text-xs text-cafe-muted text-center">
          {t.cta}
          <span className="text-cafe font-medium"> {t.example}</span>
        </p>
      </div>
    </div>
  );
}
