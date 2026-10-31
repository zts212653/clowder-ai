import type { EntrustedWorkOwnerReadV1, EntrustedWorkTaskExecutionV1, TaskItem } from '@cat-cafe/shared';

export function taskIdFromEntrustedWorkSubjectRef(subjectRef: string): string | null {
  const prefix = 'task:work:';
  if (!subjectRef.startsWith(prefix)) return null;
  const taskId = subjectRef.slice(prefix.length).trim();
  return taskId.length > 0 ? taskId : null;
}

export function sameCompletionArtifact(
  current: EntrustedWorkOwnerReadV1['preparedArtifact'],
  sealed: EntrustedWorkOwnerReadV1['preparedArtifact'],
): boolean {
  if (!current || !sealed) return false;
  return (['artifactRef', 'artifactRevision', 'completenessRef', 'previewRef', 'openInWorkspaceRef'] as const).every(
    (key) => current[key] === sealed[key],
  );
}

export function projectTaskTerminal(task: TaskItem): EntrustedWorkOwnerReadV1['terminal'] {
  const work = task.entrustedWork;
  if (!work || work.closure.state === 'open') return undefined;
  const recordedAt = work.completion?.recordedAt ?? task.updatedAt;
  switch (work.closure.state) {
    case 'satisfied':
      return {
        state: 'satisfied',
        recordedAt,
        evidenceRefs: work.closure.evidenceRefs,
        ...(work.closure.confirmation ? { confirmation: work.closure.confirmation } : {}),
      };
    case 'cancelled':
      return {
        state: 'cancelled',
        recordedAt: work.completion?.recordedAt ?? work.closure.disposition.disposedAt,
        evidenceRefs: work.closure.evidenceRefs,
        disposition: work.closure.disposition,
      };
    case 'abandoned':
      return {
        state: 'abandoned',
        recordedAt: work.completion?.recordedAt ?? work.closure.disposition.disposedAt,
        evidenceRefs: work.closure.evidenceRefs,
        disposition: work.closure.disposition,
      };
  }
}

export async function readOwnerTaskExecution(input: {
  readonly task: TaskItem;
  readonly isCurrent: boolean;
  readonly reader?: { read(task: TaskItem): Promise<EntrustedWorkTaskExecutionV1> };
}): Promise<EntrustedWorkTaskExecutionV1> {
  const projection = input.reader
    ? await input.reader.read(input.task)
    : {
        v: 1 as const,
        scope: 'task_binding' as const,
        state: 'unknown' as const,
        reasonCode: 'binding_source_unavailable' as const,
        canConfirmSatisfied: false as const,
        observedAt: Date.now(),
        taskRef: {
          taskId: input.task.id,
          subjectRef: `task:work:${input.task.id}`,
          ownerRef: `task:item:${input.task.id}`,
          revision: input.task.entrustedWork?.revision ?? 1,
        },
      };
  if (input.isCurrent || projection.state === 'unknown') return projection;
  return {
    v: 1,
    scope: 'task_binding',
    state: 'unknown',
    reasonCode: 'stale_owner_read',
    canConfirmSatisfied: false,
    observedAt: projection.observedAt,
    taskRef: projection.taskRef,
  };
}

export function projectEntrustedWorkTimeRefs(
  time: NonNullable<TaskItem['entrustedWork']>['time'],
  subjectRef: string,
  ownerRef: string,
  revision: number,
) {
  const roles = [
    ['businessDeadline', 'business_deadline'],
    ['reviewBy', 'review_by'],
    ['plannedStart', 'planned_start'],
    ['actualStart', 'actual_start'],
    ['estimatedCompletion', 'estimated_completion'],
  ] as const;
  return roles.flatMap(([key, role]) => {
    const fact = time[key];
    return fact ? [{ role, subjectRef, ownerRef, revision, value: fact.value }] : [];
  });
}
