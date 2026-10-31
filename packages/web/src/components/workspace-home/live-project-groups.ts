import type { ActiveExecutionProjection } from '@cat-cafe/shared';
import { groupRunningWork } from '@/components/workspace/workspace-running-work';
import { groupHomeProjects } from './project-groups';

export interface LiveProjectGroup {
  path: string;
  label: string;
  executions: ActiveExecutionProjection[];
  unavailable: boolean;
}
export function groupLiveProjects(
  executions: readonly ActiveExecutionProjection[],
  currentProject: string | null,
  unavailable: readonly string[],
): LiveProjectGroup[] {
  return groupHomeProjects(
    groupRunningWork(executions).flatMap((work) => work.executions),
    currentProject,
    (execution) => execution.projectPath ?? currentProject ?? 'default',
    (execution) => execution.startedAt,
    unavailable,
  ).map((group) => ({
    path: group.path,
    label: group.label,
    executions: group.items,
    unavailable: unavailable.includes(group.path),
  }));
}
