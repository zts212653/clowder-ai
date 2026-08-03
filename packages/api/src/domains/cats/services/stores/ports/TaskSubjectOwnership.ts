import type { CreateTaskInput, TaskItem } from '@cat-cafe/shared';

export const SUBJECT_OWNERSHIP_CONFLICT_CODE = 'TASK_SUBJECT_OWNERSHIP_CONFLICT';

export function createSubjectOwnershipConflict(
  subjectKey: string,
  ownerUserId: string,
  requestedUserId: string,
): Error & {
  code: typeof SUBJECT_OWNERSHIP_CONFLICT_CODE;
  subjectKey: string;
  ownerUserId: string;
  requestedUserId: string;
} {
  const error = new Error(`Subject ${subjectKey} is already owned by another user`) as Error & {
    code: typeof SUBJECT_OWNERSHIP_CONFLICT_CODE;
    subjectKey: string;
    ownerUserId: string;
    requestedUserId: string;
  };
  error.code = SUBJECT_OWNERSHIP_CONFLICT_CODE;
  error.subjectKey = subjectKey;
  error.ownerUserId = ownerUserId;
  error.requestedUserId = requestedUserId;
  return error;
}

export function isSubjectOwnershipConflictError(
  error: unknown,
): error is Error & { code: typeof SUBJECT_OWNERSHIP_CONFLICT_CODE } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === SUBJECT_OWNERSHIP_CONFLICT_CODE
  );
}

export function assertSubjectUpdateOwnership(
  subjectKey: string,
  existing: Pick<TaskItem, 'threadId' | 'userId'>,
  input: Pick<CreateTaskInput, 'threadId' | 'userId'>,
): void {
  if (existing.userId && input.userId && existing.userId === input.userId) return;
  if (!existing.userId && input.userId && existing.threadId === input.threadId) return;
  if (!existing.userId && !input.userId) return;

  throw createSubjectOwnershipConflict(
    subjectKey,
    existing.userId ?? `thread:${existing.threadId}`,
    input.userId ?? `thread:${input.threadId}`,
  );
}
