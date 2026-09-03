import type { CreateTaskInput, TaskItem } from '@cat-cafe/shared';
import { entrustedWorkV1Schema } from '@cat-cafe/shared';
import { generateSortableId } from './MessageStore.js';
import type { AdmitEntrustedWorkStoreInput } from './TaskStoreContract.js';

export function createGenericTaskItem(input: CreateTaskInput, now = Date.now()): TaskItem {
  return {
    id: generateSortableId(now),
    kind: input.kind ?? 'work',
    threadId: input.threadId,
    subjectKey: input.subjectKey ?? null,
    title: input.title,
    ownerCatId: input.ownerCatId ?? null,
    status: 'todo',
    why: input.why,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
    automationState: input.automationState,
    userId: input.userId,
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
    entrustedWork: entrustedWorkV1Schema.parse(input.entrustedWork),
  };
}
