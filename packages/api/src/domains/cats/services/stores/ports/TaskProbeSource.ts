import { isDeepStrictEqual } from 'node:util';
import type { TaskItem } from '@cat-cafe/shared';

/** Only the source fields that authorize this original probe result; diagnostic/private metadata is independent. */
export type TaskProbeSource = Pick<
  TaskItem,
  | 'id'
  | 'kind'
  | 'subjectKey'
  | 'status'
  | 'threadId'
  | 'userId'
  | 'ownerCatId'
  | 'ownerRevision'
  | 'probe'
  | 'resolveMode'
>;
export function taskProbeSource(task: TaskItem): TaskProbeSource {
  return structuredClone({
    id: task.id,
    kind: task.kind,
    subjectKey: task.subjectKey,
    status: task.status,
    threadId: task.threadId,
    userId: task.userId,
    ownerCatId: task.ownerCatId,
    ownerRevision: task.ownerRevision,
    probe: task.probe,
    resolveMode: task.resolveMode,
  });
}
export function matchesTaskProbeSource(task: TaskItem, source: TaskProbeSource): boolean {
  return task.status === 'blocked' && isDeepStrictEqual(taskProbeSource(task), source);
}
