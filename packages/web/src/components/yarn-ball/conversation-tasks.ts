import type { TaskItem } from '@cat-cafe/shared';

/** Header and panel count the same canonical work tasks for the open conversation. */
export function conversationTasks(tasks: readonly TaskItem[], threadId: string): TaskItem[] {
  return tasks.filter((task) => task.kind === 'work' && task.threadId === threadId);
}

export function openTaskCount(tasks: readonly TaskItem[]): number {
  return tasks.filter((task) => task.status !== 'done').length;
}
