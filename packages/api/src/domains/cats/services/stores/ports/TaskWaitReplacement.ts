import type { ManagedWorkBinding, TaskItem } from '@cat-cafe/shared';
import { isTrackingKind } from '@cat-cafe/shared';
import { createManagedWorkBindingConflict } from './TaskManagedWorkBinding.js';
import type { ReplaceAutomationStateIfGenerationInput } from './TaskStoreContract.js';
import { assertSubjectUpdateOwnership } from './TaskSubjectOwnership.js';

const TRACKING_REGISTRATION_CONFLICT = 'TASK_TRACKING_REGISTRATION_CONFLICT';

export function isTrackingRegistrationConflict(error: unknown): error is Error {
  return error instanceof Error && 'code' in error && error.code === TRACKING_REGISTRATION_CONFLICT;
}

function assertTrackingRegistration(
  existing: TaskItem,
  input: ReplaceAutomationStateIfGenerationInput,
  currentBinding?: ManagedWorkBinding | null,
): void {
  const registration = input.trackingRegistration;
  if (registration) {
    if (!isTrackingKind(existing.kind) || !existing.subjectKey) {
      throw new Error('Wait registration requires a tracking subject');
    }
    assertSubjectUpdateOwnership(existing.subjectKey, existing, registration);
    if (
      (existing.automationState?.waitOutcome?.delivery === 'pending' ||
        input.automationState?.waitOutcome?.delivery === 'pending') &&
      (registration.threadId !== existing.threadId ||
        (registration.ownerCatId ?? existing.ownerCatId) !== existing.ownerCatId)
    ) {
      throw Object.assign(
        new Error('Tracking wait has a pending delivery to its current owner — retry after recovery'),
        {
          code: TRACKING_REGISTRATION_CONFLICT,
        },
      );
    }
    const binding = registration.managedWorkBinding;
    if (binding) {
      if (existing.kind !== 'pr_tracking' || !binding.workId || !binding.attemptId) {
        throw new Error('Managed-work registration requires a PR task and complete binding');
      }
      if (
        currentBinding &&
        (currentBinding.workId !== binding.workId || currentBinding.attemptId !== binding.attemptId)
      ) {
        throw createManagedWorkBindingConflict(existing.id);
      }
    }
  }
}

/** Pure preparation: callers commit metadata, private receipts and automation together. */
export function buildTaskWaitReplacement(
  existing: TaskItem,
  input: ReplaceAutomationStateIfGenerationInput,
  currentBinding?: ManagedWorkBinding | null,
): TaskItem {
  assertTrackingRegistration(existing, input, currentBinding);
  const registration = input.trackingRegistration;
  return {
    ...existing,
    ...(registration
      ? {
          threadId: registration.threadId,
          title: registration.title,
          ownerCatId: registration.ownerCatId ?? existing.ownerCatId,
          userId: registration.userId ?? existing.userId,
          why: registration.why,
          status: existing.status === 'done' ? 'todo' : existing.status,
        }
      : {}),
    automationState: input.automationState,
    ...(input.why !== undefined ? { why: input.why } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    updatedAt: Date.now(),
  };
}
