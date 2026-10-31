import { type CatId, entrustedWorkV1Schema, type TaskItem, type TaskKind } from '@cat-cafe/shared';
import {
  parseTypedWaitRegistration,
  TYPED_WAIT_REGISTRATION_FIELD,
  type TypedWaitRegistrationSnapshot,
} from '../../../../ball-custody/TypedWaitRegistration.js';

/** Hydrate the task and its co-located typed wait receipt from one atomic read. */
export function hydrateWaitRegistration(data: Record<string, string>): TypedWaitRegistrationSnapshot | null {
  return data.id
    ? { task: hydrateTask(data), receipt: parseTypedWaitRegistration(data[TYPED_WAIT_REGISTRATION_FIELD]) }
    : null;
}

export function serializeTask(task: TaskItem): Record<string, string> {
  const out: Record<string, string> = {
    id: task.id,
    kind: task.kind ?? 'work',
    threadId: task.threadId,
    subjectKey: task.subjectKey ?? '',
    title: task.title,
    ownerCatId: task.ownerCatId ?? '',
    ownerRevision: task.ownerRevision === undefined ? '' : String(task.ownerRevision),
    ownerChangedAt: task.ownerChangedAt === undefined ? '' : String(task.ownerChangedAt),
    lastAppliedHandoffMessageRef: task.lastAppliedHandoffMessageRef ?? '',
    executionRef: task.executionRef ? JSON.stringify(task.executionRef) : '',
    status: task.status,
    why: task.why,
    createdBy: task.createdBy,
    createdAt: String(task.createdAt),
    updatedAt: String(task.updatedAt),
    userId: task.userId ?? '',
    sourceMessageId: task.sourceMessageId ?? '',
    sourceSummaryId: task.sourceSummaryId ?? '',
    probe: task.probe ? JSON.stringify(task.probe) : '',
    resolveMode: task.resolveMode ?? '',
  };
  if (task.pluginWait) out.pluginWait = JSON.stringify(task.pluginWait);
  if (task.automationState) out.automationState = JSON.stringify(task.automationState);
  if (task.deploymentWait) out.deploymentWait = JSON.stringify(task.deploymentWait);
  if (task.relatedFeatureId) out.relatedFeatureId = task.relatedFeatureId;
  if (task.detectedFeatureIds?.length) out.detectedFeatureIds = JSON.stringify(task.detectedFeatureIds);
  if (task.dispatchGate) out.dispatchGate = JSON.stringify(task.dispatchGate);
  if (task.entrustedWork) out.entrustedWork = JSON.stringify(entrustedWorkV1Schema.parse(task.entrustedWork));
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
    ...(data.ownerRevision ? { ownerRevision: Number(data.ownerRevision) } : {}),
    ...(data.ownerChangedAt ? { ownerChangedAt: Number(data.ownerChangedAt) } : {}),
    ...(data.lastAppliedHandoffMessageRef ? { lastAppliedHandoffMessageRef: data.lastAppliedHandoffMessageRef } : {}),
    status: (data.status ?? 'todo') as TaskItem['status'],
    why: data.why ?? '',
    createdBy: (data.createdBy ?? 'user') as TaskItem['createdBy'],
    createdAt: parseInt(data.createdAt ?? '0', 10),
    updatedAt: parseInt(data.updatedAt ?? '0', 10),
    userId: data.userId || undefined,
    ...(data.sourceMessageId ? { sourceMessageId: data.sourceMessageId } : {}),
    ...(data.sourceSummaryId ? { sourceSummaryId: data.sourceSummaryId } : {}),
    resolveMode: data.resolveMode ? (data.resolveMode as TaskItem['resolveMode']) : undefined,
  };
  hydrated = parseJsonField(hydrated, 'pluginWait', data.pluginWait);
  // Invalid execution coordinates fail closed rather than making an occupied Task appear idle.
  if (data.executionRef) {
    const ref = JSON.parse(data.executionRef) as TaskItem['executionRef'];
    if (
      !ref ||
      ['invocationId', 'parentInvocationId', 'catId', 'threadId'].some(
        (key) => typeof ref[key as keyof typeof ref] !== 'string' || !ref[key as keyof typeof ref],
      )
    )
      throw new Error(`Invalid executionRef for Task ${data.id}`);
    if (ref.sourceMessageId !== null && (typeof ref.sourceMessageId !== 'string' || !ref.sourceMessageId))
      throw new Error(`Invalid execution source for Task ${data.id}`);
    hydrated = { ...hydrated, executionRef: ref };
  }
  if (
    hydrated.ownerRevision !== undefined &&
    (!Number.isSafeInteger(hydrated.ownerRevision) || hydrated.ownerRevision < 0)
  )
    throw new Error(`Invalid ownerRevision for Task ${data.id}`);
  hydrated = parseJsonField(hydrated, 'automationState', data.automationState);
  hydrated = parseJsonField(hydrated, 'deploymentWait', data.deploymentWait);
  hydrated = parseJsonField(hydrated, 'probe', data.probe);
  if (data.relatedFeatureId) hydrated = { ...hydrated, relatedFeatureId: data.relatedFeatureId };
  hydrated = parseJsonField(hydrated, 'detectedFeatureIds', data.detectedFeatureIds);
  hydrated = parseJsonField(hydrated, 'dispatchGate', data.dispatchGate);
  return parseEntrustedWorkField(hydrated, data);
}

function parseEntrustedWorkField(task: TaskItem, data: Record<string, string>): TaskItem {
  if (!data.entrustedWork) return task;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.entrustedWork);
  } catch {
    throw new Error(`Invalid entrustedWork JSON for Task ${data.id ?? '<unknown>'}`);
  }
  const entrustedWork = entrustedWorkV1Schema.safeParse(parsed);
  if (!entrustedWork.success) {
    throw new Error(`Invalid entrustedWork contract for Task ${data.id ?? '<unknown>'}`);
  }
  return { ...task, entrustedWork: entrustedWork.data };
}

function parseJsonField<K extends keyof TaskItem>(task: TaskItem, key: K, encoded?: string): TaskItem {
  if (!encoded) return task;
  try {
    return { ...task, [key]: JSON.parse(encoded) };
  } catch {
    return task;
  }
}
