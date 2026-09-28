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
  const artifactRefs = input.artifactRefs ? [...new Set(input.artifactRefs)].sort() : current.artifactRefs;
  if (
    status === task.status &&
    JSON.stringify(time) === JSON.stringify(current.time) &&
    JSON.stringify(artifactRefs) === JSON.stringify(current.artifactRefs)
  ) {
    return { kind: 'no_change', task };
  }
  const entrustedWork = entrustedWorkV1Schema.parse({
    ...current,
    revision: current.revision + 1,
    time,
    artifactRefs,
  });
  return { kind: 'ready', status, entrustedWork };
}

function patchTime(
  current: EntrustedWorkV1['time'],
  patch: UpdateEntrustedWorkStoreInput['time'],
): EntrustedWorkV1['time'] {
  const next = { ...current };
  if (patch && Object.hasOwn(patch, 'businessDeadline')) {
    if (patch.businessDeadline === null) delete next.businessDeadline;
    else if (patch.businessDeadline !== undefined) next.businessDeadline = patch.businessDeadline;
  }
  if (patch && Object.hasOwn(patch, 'reviewBy')) {
    if (patch.reviewBy === null) delete next.reviewBy;
    else if (patch.reviewBy !== undefined) next.reviewBy = patch.reviewBy;
  }
  return next;
}
