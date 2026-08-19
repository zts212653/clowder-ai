import type { CatId, TaskItem, TaskKind } from '@cat-cafe/shared';

export function serializeTask(task: TaskItem): Record<string, string> {
  const out: Record<string, string> = {
    id: task.id,
    kind: task.kind ?? 'work',
    threadId: task.threadId,
    subjectKey: task.subjectKey ?? '',
    title: task.title,
    ownerCatId: task.ownerCatId ?? '',
    status: task.status,
    why: task.why,
    createdBy: task.createdBy,
    createdAt: String(task.createdAt),
    updatedAt: String(task.updatedAt),
    userId: task.userId ?? '',
    probe: task.probe ? JSON.stringify(task.probe) : '',
    resolveMode: task.resolveMode ?? '',
  };
  if (task.automationState) out.automationState = JSON.stringify(task.automationState);
  if (task.relatedFeatureId) out.relatedFeatureId = task.relatedFeatureId;
  if (task.detectedFeatureIds?.length) out.detectedFeatureIds = JSON.stringify(task.detectedFeatureIds);
  if (task.dispatchGate) out.dispatchGate = JSON.stringify(task.dispatchGate);
  return out;
}

export function hydrateTask(data: Record<string, string>): TaskItem {
  let hydrated: TaskItem = {
    id: data.id ?? '',
    kind: (data.kind ?? 'work') as TaskKind,
    threadId: data.threadId ?? '',
    subjectKey: data.subjectKey || null,
    title: data.title ?? '',
    ownerCatId: (data.ownerCatId || null) as CatId | null,
    status: (data.status ?? 'todo') as TaskItem['status'],
    why: data.why ?? '',
    createdBy: (data.createdBy ?? 'user') as TaskItem['createdBy'],
    createdAt: parseInt(data.createdAt ?? '0', 10),
    updatedAt: parseInt(data.updatedAt ?? '0', 10),
    userId: data.userId || undefined,
    resolveMode: data.resolveMode ? (data.resolveMode as TaskItem['resolveMode']) : undefined,
  };
  hydrated = parseJsonField(hydrated, 'automationState', data.automationState);
  hydrated = parseJsonField(hydrated, 'probe', data.probe);
  if (data.relatedFeatureId) hydrated = { ...hydrated, relatedFeatureId: data.relatedFeatureId };
  hydrated = parseJsonField(hydrated, 'detectedFeatureIds', data.detectedFeatureIds);
  hydrated = parseJsonField(hydrated, 'dispatchGate', data.dispatchGate);
  return hydrated;
}

function parseJsonField<K extends keyof TaskItem>(task: TaskItem, key: K, encoded?: string): TaskItem {
  if (!encoded) return task;
  try {
    return { ...task, [key]: JSON.parse(encoded) };
  } catch {
    return task;
  }
}
