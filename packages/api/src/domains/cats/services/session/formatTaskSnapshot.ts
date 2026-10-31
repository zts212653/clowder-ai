/**
 * formatTaskSnapshot — F065 Phase A
 * Formats thread tasks into a compact bootstrap-injectable snapshot.
 *
 * Design decisions (KD-6, KD-7 from F065 spec):
 * - Compact list format, not prose
 * - Priority sort: doing > blocked > todo > done
 * - Max 8 open + 2 done tasks displayed
 * - Title truncated to 80 chars, why to 120 chars
 * - Content treated as data block (injection defense)
 */

import type { TaskItem, TaskStatus } from '@cat-cafe/shared';

const STATUS_PRIORITY: Record<TaskStatus, number> = {
  doing: 0,
  blocked: 1,
  todo: 2,
  done: 3,
};

const MAX_OPEN = 8;
const MAX_DONE = 2;
const MAX_TITLE = 80;
const MAX_WHY = 120;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

/** Sanitize user-writable text for safe embedding in bootstrap prompt. */
function sanitize(text: string): string {
  return text
    .replace(/\n/g, ' ') // single-line (before control char strip)
    .replace(/[\x00-\x1f]/g, '') // control chars (after newline→space)
    .replace(/```[^`]*```/g, '') // code blocks
    .replace(/^#{1,6}\s*/gm, '') // headings
    .replace(/^---+\s*/gm, '') // horizontal rules
    .replace(/^>\s*/gm, '') // blockquotes
    .replace(/\[\/Task Snapshot\]/g, '') // prevent closing marker spoofing (R4 P2-1)
    .trim();
}

function formatAge(updatedAt: number): string {
  const diffMs = Date.now() - updatedAt;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatTaskSnapshot(tasks: readonly TaskItem[]): string {
  if (tasks.length === 0) return '';

  // Count by status
  const counts: Record<TaskStatus, number> = { doing: 0, blocked: 0, todo: 0, done: 0 };
  for (const t of tasks) counts[t.status]++;

  // Sort by priority, then by updatedAt descending within same priority
  const sorted = [...tasks].sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status] ?? 99;
    const pb = STATUS_PRIORITY[b.status] ?? 99;
    if (pa !== pb) return pa - pb;
    return b.updatedAt - a.updatedAt;
  });

  // Split into open (doing/blocked/todo) and done
  const open = sorted.filter((t) => t.status !== 'done').slice(0, MAX_OPEN);
  const done = sorted.filter((t) => t.status === 'done').slice(0, MAX_DONE);
  const display = [...open, ...done];

  // Header with counts
  const countParts: string[] = [];
  if (counts.doing > 0) countParts.push(`${counts.doing} doing`);
  if (counts.blocked > 0) countParts.push(`${counts.blocked} blocked`);
  if (counts.todo > 0) countParts.push(`${counts.todo} todo`);
  if (counts.done > 0) countParts.push(`${counts.done} done`);

  const lines: string[] = [];
  lines.push(`[Task Snapshot — ${tasks.length} tasks (${countParts.join(', ')})]`);

  // Blocked reminder (F160 Phase C: AC-C3)
  if (counts.blocked > 0) {
    const blockedTasks = sorted.filter((t) => t.status === 'blocked').slice(0, MAX_OPEN);
    lines.push(`⚠️ 有 ${counts.blocked} 个任务被阻塞，请优先处理或更新状态：`);
    for (const bt of blockedTasks) {
      const title = truncate(sanitize(bt.title), MAX_TITLE);
      lines.push(`  → ${title}`);
    }
    lines.push('');
  }

  // Find focus task (first doing, else first blocked)
  const focusId = display.find((t) => t.status === 'doing')?.id ?? display.find((t) => t.status === 'blocked')?.id;

  for (const t of display) {
    const isFocus = t.id === focusId;
    const prefix = isFocus ? '▸' : ' ';
    const title = truncate(sanitize(t.title), MAX_TITLE);
    const owner = t.ownerCatId ? ` — ${t.ownerCatId}` : '';
    const age = formatAge(t.updatedAt);

    let line = `${prefix} [${t.status}] ${title}${owner} (${age})`;

    if (t.status === 'blocked' && t.why) {
      const why = truncate(sanitize(t.why), MAX_WHY);
      line += `\n    ⚠ ${why}`;
    }

    lines.push(line);
  }

  const omitted = tasks.length - display.length;
  if (omitted > 0) {
    lines.push(`  ... and ${omitted} more tasks`);
  }

  lines.push('[/Task Snapshot]');
  return lines.join('\n');
}
