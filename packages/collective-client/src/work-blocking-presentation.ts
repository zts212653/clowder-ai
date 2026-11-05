import type { CollectiveWorkProjection } from './client-types.js';
import { resolveWorkDependencies, unreadableDependencyLabel } from './work-dependency-resolution.js';
import { workExecutionPresentation, workStatusLabel } from './work-execution-presentation.js';

export interface WorkDependencyPresentation {
  readonly incompleteWorkIds: readonly string[];
  readonly incompleteLabels: readonly string[];
  readonly completedLabels: readonly string[];
}

export interface WorkBlockingPresentation extends WorkDependencyPresentation {
  readonly kind: 'execution' | 'dependencies' | 'unknown';
  readonly label: string;
  readonly detail: string;
}

export function workDependencyPresentation(
  work: CollectiveWorkProjection,
  availableWorks: readonly CollectiveWorkProjection[],
): WorkDependencyPresentation {
  const dependencies = resolveWorkDependencies(work, availableWorks);
  const incomplete = dependencies.resolved.filter((dependency) => dependency.lifecycle !== 'completed');
  const completed = dependencies.resolved.filter((dependency) => dependency.lifecycle === 'completed');
  return {
    incompleteWorkIds: incomplete.map((dependency) => dependency.workId),
    incompleteLabels: [
      ...incomplete.map((dependency) => dependency.title),
      ...(dependencies.unresolvedCount ? [unreadableDependencyLabel(dependencies.unresolvedCount)] : []),
    ],
    completedLabels: completed.map((dependency) => dependency.title),
  };
}

/** Describe the current cause, while retaining completed dependency edges as history only. */
export function workBlockingPresentation(
  work: CollectiveWorkProjection,
  availableWorks: readonly CollectiveWorkProjection[],
): WorkBlockingPresentation | undefined {
  if (work.status !== 'blocked') return undefined;
  const dependencies = workDependencyPresentation(work, availableWorks);
  const execution = workExecutionPresentation(work);
  if (execution.statusLabel !== workStatusLabel('blocked')) {
    return {
      ...dependencies,
      kind: 'execution',
      label: execution.statusLabel,
      detail: execution.admissionMessage ?? execution.statusLabel,
    };
  }
  if (dependencies.incompleteLabels.length) {
    const label = `等待 ${dependencies.incompleteLabels.join('、')}`;
    return { ...dependencies, kind: 'dependencies', label, detail: label };
  }
  return {
    ...dependencies,
    kind: 'unknown',
    label: '阻塞原因未填写',
    detail: '阻塞原因未填写',
  };
}
