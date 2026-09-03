import { type EntrustedWorkV1, entrustedWorkV1Schema, type TaskItem } from '@cat-cafe/shared';
import type { UpdateEntrustedWorkStoreInput } from './TaskStoreContract.js';

export type PreparedEntrustedWorkUpdate =
  | { readonly kind: 'ready'; readonly entrustedWork: EntrustedWorkV1 }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'not_entrusted'; readonly task: TaskItem }
  | { readonly kind: 'revision_conflict' | 'already_closed' | 'no_change'; readonly task: TaskItem };

export function prepareEntrustedWorkUpdate(
  task: TaskItem | null,
  input: UpdateEntrustedWorkStoreInput,
): PreparedEntrustedWorkUpdate {
  if (!task) return { kind: 'not_found' };
  if (!task.entrustedWork) return { kind: 'not_entrusted', task };
  if (task.entrustedWork.closure.state !== 'open') return { kind: 'already_closed', task };
  if (task.entrustedWork.revision !== input.expectedRevision) return { kind: 'revision_conflict', task };
  const entrustedWork = applyEntrustedWorkContractUpdate(task.entrustedWork, input);
  return entrustedWork ? { kind: 'ready', entrustedWork } : { kind: 'no_change', task };
}

/** Pure Task-owner transition shared by memory and Redis CAS implementations. */
export function applyEntrustedWorkContractUpdate(
  current: EntrustedWorkV1,
  input: UpdateEntrustedWorkStoreInput,
): EntrustedWorkV1 | null {
  const time = patchTime(current.time, input.time);
  const artifactRefs = input.artifactRefs ? [...new Set(input.artifactRefs)].sort() : current.artifactRefs;
  if (
    JSON.stringify(time) === JSON.stringify(current.time) &&
    JSON.stringify(artifactRefs) === JSON.stringify(current.artifactRefs)
  ) {
    return null;
  }
  return entrustedWorkV1Schema.parse({
    ...current,
    revision: current.revision + 1,
    time,
    artifactRefs,
  });
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
