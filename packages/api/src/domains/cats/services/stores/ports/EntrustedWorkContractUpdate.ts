import {
  type EntrustedWorkV1,
  entrustedWorkUpdateActionV1Schema,
  entrustedWorkV1Schema,
  type TaskItem,
} from '@cat-cafe/shared';
import type { UpdateEntrustedWorkStoreInput } from './TaskStoreContract.js';

export type PreparedEntrustedWorkUpdate =
  | {
      readonly kind: 'ready';
      readonly status: Exclude<TaskItem['status'], 'done'>;
      readonly entrustedWork: EntrustedWorkV1;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_entrusted'; readonly task: TaskItem }
  | { readonly kind: 'revision_conflict' | 'already_closed' | 'no_change'; readonly task: TaskItem };

export function prepareEntrustedWorkUpdate(
  task: TaskItem | null,
  input: UpdateEntrustedWorkStoreInput,
): PreparedEntrustedWorkUpdate {
  if (!task) return { kind: 'not_found' };
  if (!task.entrustedWork) return { kind: 'not_entrusted', task };
  if (task.entrustedWork.closure.state !== 'open' || task.status === 'done') return { kind: 'already_closed', task };
  if (task.entrustedWork.revision !== input.expectedRevision) return { kind: 'revision_conflict', task };
  const current = task.entrustedWork;
  const status = entrustedWorkUpdateActionV1Schema.shape.status.parse(input.status) ?? task.status;
  const time = patchTime(current.time, input.time);
  const progress = input.progress === undefined ? current.progress : (input.progress ?? undefined);
  const nextProgress = progress ? { ...progress } : undefined;
  if (nextProgress && status !== 'blocked') delete nextProgress.blockerReason;
  const artifactRefs = input.artifactRefs ? [...new Set(input.artifactRefs)].sort() : current.artifactRefs;
  if (
    status === task.status &&
    JSON.stringify(time) === JSON.stringify(current.time) &&
    JSON.stringify(artifactRefs) === JSON.stringify(current.artifactRefs) &&
    JSON.stringify(nextProgress) === JSON.stringify(current.progress)
  ) {
    return { kind: 'no_change', task };
  }
  const candidate: EntrustedWorkV1 = {
    ...current,
    revision: current.revision + 1,
    time,
    artifactRefs,
    progress: nextProgress,
  };
  if (!nextProgress) delete candidate.progress;
  const entrustedWork = entrustedWorkV1Schema.parse(candidate);
  return { kind: 'ready', status, entrustedWork };
}

function patchTime(
  current: EntrustedWorkV1['time'],
  patch: UpdateEntrustedWorkStoreInput['time'],
): EntrustedWorkV1['time'] {
  const next = { ...current };
  for (const key of ['businessDeadline', 'reviewBy', 'plannedStart', 'actualStart', 'estimatedCompletion'] as const) {
    if (!patch || !Object.hasOwn(patch, key)) continue;
    if (patch[key] === null) delete next[key];
    else if (patch[key] !== undefined) next[key] = patch[key];
  }
  return next;
}
