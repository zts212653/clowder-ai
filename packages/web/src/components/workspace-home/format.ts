import type { ManagedCommandActivity } from '@cat-cafe/shared';
import type { HomeCopy } from './workspace-home.shell-copy';

const MINUTE_MS = 60_000;

/** Elapsed clock for a background task: `0:50`, `12:07`, `1:02:03`. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

/** "How long has this been waiting": 3 分钟 / 5 小时 / 1 天, or "3 minutes" / "5 hours" / "1 day" — the words are the caller's. */
export function formatWaitDuration(ms: number, time: HomeCopy['time']): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE_MS);
  if (minutes < 60) return time.minutes(Math.max(1, minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return time.hours(hours);
  return time.days(Math.floor(hours / 24));
}

/** "How long ago was this observed": 刚刚 / 4 分钟前 / 2 小时前 / 1 天前, or "just now" / "4 minutes ago" / … */
export function formatObservedAge(observedAt: number, now: number, time: HomeCopy['time']): string {
  const minutes = Math.floor(Math.max(0, now - observedAt) / MINUTE_MS);
  if (minutes < 1) return time.justNow;
  if (minutes < 60) return time.minutesAgo(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return time.hoursAgo(hours);
  return time.daysAgo(Math.floor(hours / 24));
}

/** The design's name for a managed-command kind; a kind the page does not know reads as the generic 托管命令 / Managed command. */
export function homeActivityLabel(activity: ManagedCommandActivity | undefined, labels: HomeCopy['activity']): string {
  return (activity && labels[activity]) ?? labels.command;
}

export function shortRevision(revision: string): string {
  return revision.slice(0, 8);
}
