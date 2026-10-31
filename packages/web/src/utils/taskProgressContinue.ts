import type { TaskProgressState } from '@/stores/chat-types';

/**
 * Build a "continue interrupted task" message.
 * @param mentionHandle — full mention alias including `@` prefix (e.g. `@opus`).
 *   Falls back to `@${rawId}` if no alias is available (#967).
 */
export function buildContinueMessage(mentionHandle: string, progress: TaskProgressState): string {
  const tasks = progress.tasks ?? [];
  const remaining = tasks.filter((t) => t.status !== 'completed');
  const trimmedMentionHandle = mentionHandle.trim();
  const normalizedMentionHandle = trimmedMentionHandle.startsWith('@')
    ? trimmedMentionHandle
    : `@${trimmedMentionHandle}`;

  const lines: string[] = [];
  lines.push(`${normalizedMentionHandle} 🔁 继续上次任务（已中断，上次 checklist 见下）`);
  lines.push('');

  const render = (label: string, list: typeof tasks) => {
    if (list.length === 0) return;
    lines.push(`${label}:`);
    for (const t of list) {
      const mark = t.status === 'completed' ? '[x]' : '[ ]';
      lines.push(`- ${mark} ${t.subject}`);
    }
    lines.push('');
  };

  render('未完成', remaining);
  render('全部任务', tasks);

  lines.push('请从“未完成”项继续推进；如计划需要调整，也请直接更新 checklist。');
  return lines.join('\n');
}
