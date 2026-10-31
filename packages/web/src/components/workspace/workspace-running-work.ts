import type { ActiveExecutionProjection } from '@cat-cafe/shared';

export interface RunningWork {
  readonly key: string;
  readonly catId: string;
  readonly threadId: string;
  readonly threadTitle: string | null;
  readonly executions: ActiveExecutionProjection[];
}

/** Presentation scope only: exact execution identities and controls stay in the canonical store. */
export function groupRunningWork(executions: readonly ActiveExecutionProjection[]): RunningWork[] {
  const groups = new Map<string, RunningWork>();
  const ordered = [...executions].sort(
    (left, right) => left.startedAt - right.startedAt || left.executionId.localeCompare(right.executionId),
  );
  for (const execution of ordered) {
    const key = JSON.stringify([execution.threadId, execution.catId]);
    const group = groups.get(key);
    if (group) {
      group.executions.push(execution);
    } else {
      groups.set(key, {
        key,
        catId: execution.catId,
        threadId: execution.threadId,
        threadTitle: execution.threadTitle,
        executions: [execution],
      });
    }
  }
  return [...groups.values()];
}
