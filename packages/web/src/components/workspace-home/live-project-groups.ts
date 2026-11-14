import type { ActiveExecutionProjection, ActiveHoldWaitProjection } from '@cat-cafe/shared';
import { groupRunningWork } from '@/components/workspace/workspace-running-work';
import { groupHomeProjects } from './project-groups';

export interface LiveProjectGroup {
  path: string;
  label: string;
  executions: ActiveExecutionProjection[];
  /** Held balls in this project: waiting, listed after the running work. */
  waits: ActiveHoldWaitProjection[];
  unavailable: boolean;
}

type LiveItem =
  | { kind: 'run'; execution: ActiveExecutionProjection }
  | { kind: 'wait'; wait: ActiveHoldWaitProjection };

export function groupLiveProjects(
  executions: readonly ActiveExecutionProjection[],
  currentProject: string | null,
  unavailable: readonly string[],
  waits: readonly ActiveHoldWaitProjection[] = [],
): LiveProjectGroup[] {
  const items: LiveItem[] = [
    ...groupRunningWork(executions).flatMap((work) =>
      work.executions.map((execution): LiveItem => ({ kind: 'run', execution })),
    ),
    ...[...waits].sort((left, right) => left.wakeAt - right.wakeAt).map((wait): LiveItem => ({ kind: 'wait', wait })),
  ];
  const pathOf = (projectPath: string | undefined) => projectPath ?? currentProject ?? 'default';
  return groupHomeProjects(
    items,
    currentProject,
    (item) => pathOf(item.kind === 'run' ? item.execution.projectPath : item.wait.projectPath),
    // A project that only waits sorts by when its first hold began.
    (item) => (item.kind === 'run' ? item.execution.startedAt : item.wait.since),
    unavailable,
  ).map((group) => ({
    path: group.path,
    label: group.label,
    executions: group.items.flatMap((item) => (item.kind === 'run' ? [item.execution] : [])),
    waits: group.items.flatMap((item) => (item.kind === 'wait' ? [item.wait] : [])),
    unavailable: unavailable.includes(group.path),
  }));
}
