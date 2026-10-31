import { entrustedWorkV1Schema, type TaskItem } from '@cat-cafe/shared';
import type { ITaskStore } from '../../../cats/services/stores/ports/TaskStore.js';

export type CompanionTask = TaskItem & { entrustedWork: NonNullable<TaskItem['entrustedWork']> };
const THREAD_BUDGET = 16;
const TASK_BUDGET = 64;

/** Read the original Task aggregate for this human's project; no owner-read of every project/artifact. */
export async function readCompanionProjectTasks(options: {
  ownerUserId: string;
  threadIds: ReadonlySet<string>;
  tasks: Pick<ITaskStore, 'get' | 'listByThread'>;
}) {
  let complete = options.threadIds.size <= THREAD_BUDGET;
  const candidates: CompanionTask[] = [];
  for (const threadId of [...options.threadIds].slice(0, THREAD_BUDGET)) {
    const rows = await options.tasks.listByThread(threadId);
    for (const task of rows) {
      if (
        task.threadId !== threadId ||
        task.userId !== options.ownerUserId ||
        task.kind !== 'work' ||
        !task.entrustedWork
      )
        continue;
      const entrustedWork = entrustedWorkV1Schema.parse(task.entrustedWork);
      candidates.push(structuredClone({ ...task, entrustedWork }));
    }
  }
  candidates.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  if (candidates.length > TASK_BUDGET) complete = false;
  const items: CompanionTask[] = [];
  for (const row of candidates.slice(0, TASK_BUDGET)) {
    const current = await options.tasks.get(row.id);
    if (
      !current ||
      current.userId !== options.ownerUserId ||
      current.threadId !== row.threadId ||
      current.entrustedWork?.revision !== row.entrustedWork.revision ||
      current.updatedAt !== row.updatedAt
    )
      throw new Error('Companion Task snapshot changed');
    items.push(row);
  }
  return { items, complete };
}
