/* ── Schedule Panel Types & Helpers ──────────── */

import { resolveShellCopy } from '@/components/shell/shell-copy';
import type { ShellLanguage } from '@/components/shell/shell-language';
import { schedulePanelCopy } from './schedule-panel.shell-copy';

export interface RunLedgerRow {
  task_id: string;
  subject_key: string;
  outcome: string;
  signal_summary: string | null;
  duration_ms: number;
  started_at: string;
  assigned_cat_id: string | null;
  error_summary: string | null;
}

export interface RunStats {
  total: number;
  delivered: number;
  failed: number;
  skipped: number;
}

export interface TriggerSpec {
  type: 'interval' | 'cron' | 'once';
  ms?: number;
  expression?: string;
  /** #415: epoch ms — when the once trigger will fire */
  fireAt?: number;
}

export interface TaskDisplayMeta {
  label: string;
  category: DisplayCategory;
  description?: string;
  subjectKind?: string;
}

export type TaskSource = 'builtin' | 'dynamic';

/** Phase 3B (AC-D1): Governance control state */
export interface GlobalControlState {
  enabled: boolean;
  reason: string | null;
  updatedBy: string;
  updatedAt: string;
}

export interface TaskOverrideState {
  taskId: string;
  enabled: boolean;
  updatedBy: string;
  updatedAt: string;
}

export interface ScheduleTask {
  id: string;
  profile: string;
  trigger: TriggerSpec;
  enabled: boolean;
  /** AC-D1: effective enabled state considering global pause + task overrides */
  effectiveEnabled?: boolean;
  actor?: { role: string; costTier: string };
  context?: { session: string; materialization: string };
  lastRun: RunLedgerRow | null;
  runStats: RunStats;
  display?: TaskDisplayMeta;
  subjectPreview: string | null;
  source: TaskSource;
  dynamicTaskId?: string;
}

export type DisplayCategory = 'pr' | 'repo' | 'thread' | 'system' | 'external' | 'issue';

export const CATEGORY_STYLES: Record<DisplayCategory, string> = {
  pr: 'bg-blue-100 text-blue-700',
  repo: 'bg-emerald-100 text-emerald-700',
  thread: 'bg-violet-100 text-violet-700',
  system: 'bg-amber-100 text-amber-700',
  external: 'bg-purple-100 text-purple-700',
  issue: 'bg-orange-100 text-orange-700',
};

export function fallbackCategory(taskId: string): DisplayCategory {
  if (taskId.includes('review') || taskId.includes('conflict') || taskId.includes('cicd')) return 'pr';
  if (taskId.includes('repo') || taskId.includes('issue')) return 'repo';
  if (taskId.includes('summary') || taskId.includes('compact')) return 'thread';
  if (taskId.includes('health')) return 'system';
  return 'system';
}

export function formatTrigger(trigger: TriggerSpec, language: ShellLanguage = 'en'): string {
  const t = resolveShellCopy(schedulePanelCopy, language);
  if (trigger.type === 'cron') return t.cron(trigger.expression);
  if (trigger.type === 'once') {
    if (!trigger.fireAt) return t.once;
    const d = new Date(trigger.fireAt);
    const now = Date.now();
    if (trigger.fireAt <= now) return t.fired;
    const diff = trigger.fireAt - now;
    if (diff < 60_000) return t.onceSeconds(Math.ceil(diff / 1000));
    if (diff < 3_600_000) return t.onceMinutes(Math.ceil(diff / 60_000));
    return t.onceAt(
      d.toLocaleTimeString(language === 'zh' ? 'zh-CN' : 'en-US', { hour: '2-digit', minute: '2-digit' }),
    );
  }
  const ms = trigger.ms ?? 0;
  if (ms >= 3600000) return t.everyHours(Math.round(ms / 3600000));
  if (ms >= 60000) return t.everyMinutes(Math.round(ms / 60000));
  return t.everySeconds(Math.round(ms / 1000));
}

export function timeAgo(iso: string, language: ShellLanguage = 'en'): string {
  const t = resolveShellCopy(schedulePanelCopy, language);
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return t.justNow;
  if (diff < 3600000) return t.minutesAgo(Math.floor(diff / 60000));
  if (diff < 86400000) return t.hoursAgo(Math.floor(diff / 3600000));
  return t.daysAgo(Math.floor(diff / 86400000));
}

export function outcomeIcon(outcome: string): string {
  if (outcome === 'RUN_DELIVERED') return '\u2713';
  if (outcome === 'RUN_FAILED') return '\u2717';
  return '\u2013';
}

export function outcomeColor(outcome: string): string {
  if (outcome === 'RUN_DELIVERED') return 'text-emerald-600';
  if (outcome === 'RUN_FAILED') return 'text-red-500';
  return 'text-cafe-muted';
}

export function outcomeLabel(outcome: string, language: ShellLanguage = 'en'): string {
  const t = resolveShellCopy(schedulePanelCopy, language);
  if (outcome === 'RUN_DELIVERED') return t.delivered;
  if (outcome === 'RUN_FAILED') return t.failed;
  if (outcome.startsWith('SKIP_')) return t.skipped;
  return t.unverified;
}

export function extractThreadId(subjectKey: string): string | null {
  if (subjectKey.startsWith('thread-')) return subjectKey.slice(7);
  if (subjectKey.startsWith('thread:')) return subjectKey.slice(7);
  return null;
}

export function humanizeId(id: string): string {
  return id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
