import { isDeepStrictEqual } from 'node:util';
import { type CreateTaskInput, isTrackingKind, type TaskItem } from '@cat-cafe/shared';
import { mergeTaskAutomationState } from './TaskAutomationState.js';
import { reconcileDeploymentWaitTaskMutation } from './TaskDeploymentWaitState.js';
import { reconcilePluginWaitTaskMutation } from './TaskPluginWait.js';
import {
  assertEntrustedWorkGenericUpsertAllowed,
  createTaskSubjectSnapshotConflictError,
  type TaskSubjectUpsertCondition,
} from './TaskStoreContract.js';
import { assertSubjectUpdateOwnership } from './TaskSubjectOwnership.js';

export function assertTaskSubjectSnapshot(
  subjectKey: string,
  actual: TaskItem | null,
  condition: TaskSubjectUpsertCondition,
): void {
  if (!isDeepStrictEqual(actual, condition.expected)) throw createTaskSubjectSnapshotConflictError(subjectKey);
}

/** Shared mutation semantics for both stores, fenced and legacy subject upserts alike. */
export function buildSubjectTaskUpdate(subjectKey: string, existing: TaskItem, input: CreateTaskInput): TaskItem {
  assertSubjectUpdateOwnership(subjectKey, existing, input);
  assertEntrustedWorkGenericUpsertAllowed(existing);
  const updated: TaskItem = {
    ...existing,
    threadId: input.threadId,
    title: input.title,
    ownerCatId: input.ownerCatId ?? existing.ownerCatId,
    status:
      isTrackingKind(existing.kind) && existing.status === 'done' && !existing.pluginWait ? 'todo' : existing.status,
    why: input.why,
    userId: input.userId ?? existing.userId,
    probe: input.probe !== undefined ? input.probe : existing.probe,
    resolveMode: input.resolveMode !== undefined ? input.resolveMode : existing.resolveMode,
    automationState: input.automationState
      ? mergeTaskAutomationState(existing.automationState, input.automationState)
      : existing.automationState,
    updatedAt: Date.now(),
  };
  return reconcilePluginWaitTaskMutation(existing, reconcileDeploymentWaitTaskMutation(existing, updated));
}
