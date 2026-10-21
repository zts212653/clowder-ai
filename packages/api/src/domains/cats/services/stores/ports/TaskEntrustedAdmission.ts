import type { TaskItem } from '@cat-cafe/shared';
import { advanceEntrustedTaskAuthority } from './EntrustedWorkRevision.js';
import { createEntrustedTaskItem } from './TaskItemFactory.js';
import {
  type AdmitEntrustedWorkStoreInput,
  type AdmitEntrustedWorkStoreResult,
  assertEntrustedWorkReplayCompatible,
  createEntrustedWorkAdmissionConflictError,
  createTaskSubjectAlreadyExistsError,
} from './TaskStoreContract.js';
import { assertTaskSubjectSnapshot } from './TaskSubjectUpsert.js';

/** Shared create conflict policy, evaluated inside the memory/Redis atomic admission. */
export function prepareEntrustedTaskCreate(
  existing: TaskItem | null,
  input: AdmitEntrustedWorkStoreInput,
): AdmitEntrustedWorkStoreResult {
  const policy = input.createOptions;
  if (!policy) throw new Error('Task create conflict policy required');
  if (existing && policy.onConflict === 'error') throw createTaskSubjectAlreadyExistsError(input.subjectKey);
  assertTaskSubjectSnapshot(input.subjectKey, existing, policy);
  if (!existing) return { kind: 'admitted', task: createEntrustedTaskItem(input) };
  assertEntrustedWorkReplayCompatible(input.subjectKey, existing, input.entrustedWork);
  if (
    existing.userId !== input.task.userId ||
    existing.threadId !== input.task.threadId ||
    existing.ownerCatId !== input.task.ownerCatId
  )
    throw createEntrustedWorkAdmissionConflictError(input.subjectKey);
  if (existing.title === input.task.title && existing.why === input.task.why)
    return { kind: 'resumed', task: existing };
  // Admission does not reopen a closed Work or overwrite revisioned contract edits.
  return {
    kind: 'resumed',
    task: advanceEntrustedTaskAuthority(existing, {
      ...existing,
      title: input.task.title,
      why: input.task.why,
      updatedAt: Date.now(),
    }),
  };
}

/** Synchronous admission and index commit form one in-memory atomic operation. */
export function admitEntrustedTaskInMemory(
  tasks: Map<string, TaskItem>,
  subjectIndex: Map<string, string>,
  input: AdmitEntrustedWorkStoreInput,
  evictForAdmission: () => void,
): AdmitEntrustedWorkStoreResult {
  if (input.entrustedWork.developmentScope) throw new Error('Development scope requires its typed Task action');
  const existingId = subjectIndex.get(input.subjectKey);
  if (input.createOptions) {
    const existing = existingId ? (tasks.get(existingId) ?? null) : null;
    const result = prepareEntrustedTaskCreate(existing, input);
    if (result.kind === 'admitted') evictForAdmission();
    tasks.set(result.task.id, result.task);
    subjectIndex.set(input.subjectKey, result.task.id);
    return result;
  }
  if (existingId) {
    const existing = tasks.get(existingId);
    if (existing) {
      assertEntrustedWorkReplayCompatible(input.subjectKey, existing, input.entrustedWork);
      return { kind: 'resumed', task: existing };
    }
    subjectIndex.delete(input.subjectKey);
  }

  evictForAdmission();
  const task = createEntrustedTaskItem(input);
  tasks.set(task.id, task);
  subjectIndex.set(input.subjectKey, task.id);
  return { kind: 'admitted', task };
}
