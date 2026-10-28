import type { CreateTaskInput, TaskItem } from '@cat-cafe/shared';
import { entrustedWorkV1Schema } from '@cat-cafe/shared';
import { generateSortableId } from './MessageStore.js';
import type { AdmitEntrustedWorkStoreInput } from './TaskStoreContract.js';

export function createGenericTaskItem(input: CreateTaskInput, now = Date.now()): TaskItem {
  if (
    input.initialExecutionRef &&
    ((input.kind && input.kind !== 'work') ||
      input.subjectKey != null ||
      input.ownerCatId !== input.initialExecutionRef.catId ||
      input.threadId !== input.initialExecutionRef.threadId ||
      (input.sourceMessageId ?? null) !== input.initialExecutionRef.sourceMessageId)
  )
    throw new Error('Initial Task execution does not match its authenticated creator');
  return {
    id: generateSortableId(now),
    kind: input.kind ?? 'work',
    threadId: input.threadId,
    subjectKey: input.subjectKey ?? null,
    ...((input.kind ?? 'work') === 'work' && input.subjectKey == null ? { ownerRevision: 0 } : {}),
    title: input.title,
    ownerCatId: input.ownerCatId ?? null,
    ...(input.initialExecutionRef ? { executionRef: input.initialExecutionRef } : {}),
    status: 'todo',
    why: input.why,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    automationState: input.automationState,
    userId: input.userId,
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    ...(input.sourceSummaryId ? { sourceSummaryId: input.sourceSummaryId } : {}),
    probe: input.probe,
    resolveMode: input.resolveMode,
    ...(input.relatedFeatureId ? { relatedFeatureId: input.relatedFeatureId } : {}),
    ...(input.detectedFeatureIds?.length ? { detectedFeatureIds: input.detectedFeatureIds } : {}),
    ...(input.dispatchGate ? { dispatchGate: input.dispatchGate } : {}),
  };
}

export function createEntrustedTaskItem(input: AdmitEntrustedWorkStoreInput, now = Date.now()): TaskItem {
  return {
    id: generateSortableId(now),
    kind: 'work',
    threadId: input.task.threadId,
    subjectKey: input.subjectKey,
    title: input.task.title,
    ownerCatId: input.task.ownerCatId ?? null,
    status: 'todo',
    why: input.task.why,
    createdBy: input.task.createdBy,
    createdAt: now,
    updatedAt: now,
    userId: input.task.userId,
    entrustedWork: entrustedWorkV1Schema.parse({ ...input.entrustedWork, executionAuthorityRevision: 1 }),
  };
}
