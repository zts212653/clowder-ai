import type { TaskItem } from '@cat-cafe/shared';
import type { TypedWaitContinuationIdentity, TypedWaitReference } from './TypedWaitRegistration.js';

export function isLivePluginWait(
  task: TaskItem,
  identity: TypedWaitContinuationIdentity,
  now: number,
  reference?: TypedWaitReference,
): boolean {
  const state = task.pluginWait;
  const registration = state?.registration;
  const active = state?.await;
  return (
    !!state &&
    !!registration &&
    !!active &&
    task.status !== 'done' &&
    task.userId === state.userId &&
    state.userId === identity.userId &&
    task.ownerCatId === state.catId &&
    state.catId === identity.catId &&
    task.threadId === state.threadId &&
    state.threadId === identity.threadId &&
    registration.invocationId === identity.invocationId &&
    registration.source.sourceMessageId === identity.sourceMessageId &&
    registration.source.holdTaskId === identity.holdTaskId &&
    registration.registeredAt <= now &&
    active.generation === state.generation &&
    state.waitOutcome?.generation !== state.generation &&
    (active.expiresAt === undefined || active.expiresAt > now) &&
    (!reference || (reference.taskId === task.id && reference.generation === state.generation))
  );
}
