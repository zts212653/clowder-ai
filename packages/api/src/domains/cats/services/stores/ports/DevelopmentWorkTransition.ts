import { createHash } from 'node:crypto';
import {
  createCatId,
  type DevelopmentScopeV1,
  developmentScopeV1Schema,
  type EntrustedWorkV1,
  entrustedWorkV1Schema,
  type TaskItem,
} from '@cat-cafe/shared';
import { createEntrustedTaskItem } from './TaskItemFactory.js';

export interface DevelopmentWorkActor {
  readonly userId: string;
  readonly threadId: string;
  readonly catId: string;
}
export interface DevelopmentWorkTransition {
  readonly action: 'admit' | 'resume' | 'adopt' | 'bind';
  readonly actor: DevelopmentWorkActor;
  readonly scope: DevelopmentScopeV1;
  readonly sourceRef: string;
  readonly sourceRevision: string;
  readonly idempotencyKey: string;
  readonly taskId?: string;
  readonly expectedRevision?: number;
  readonly expectedSnapshot?: string;
  readonly title?: string;
  readonly why?: string;
  readonly contract?: EntrustedWorkV1;
  readonly parentTaskRef?: string;
  readonly predecessorTaskRef?: string;
  readonly time?: EntrustedWorkV1['time'];
}
export interface DevelopmentWorkReceipt {
  readonly requestDigest: string;
  readonly sourceRef: string;
  readonly sourceRevision: string;
  readonly result: 'admitted' | 'resumed' | 'adopted' | 'bound';
  readonly taskId: string;
  readonly revision: number;
  readonly receiptRef: string;
}
export interface DevelopmentSourceQuery {
  readonly actor: DevelopmentWorkActor;
  readonly taskId: string;
  readonly sourceRef: string;
  readonly sourceRevision: string;
}
/** Private receipt verification, never a cross-owner receipt projection. */
export function hasDevelopmentSourceReceipt(
  task: TaskItem | null,
  receipts: Iterable<DevelopmentWorkReceipt>,
  query: DevelopmentSourceQuery,
): boolean {
  if (
    !task ||
    task.userId !== query.actor.userId ||
    task.threadId !== query.actor.threadId ||
    task.ownerCatId !== query.actor.catId ||
    !task.entrustedWork
  )
    return false;
  const revision = task.entrustedWork.revision;
  return [...receipts].some(
    (receipt) =>
      receipt.taskId === task.id &&
      receipt.sourceRef === query.sourceRef &&
      receipt.sourceRevision === query.sourceRevision &&
      receipt.revision <= revision,
  );
}
export type DevelopmentWorkResult =
  | { readonly result: DevelopmentWorkReceipt['result']; readonly task: TaskItem; readonly receiptRef: string }
  | { readonly result: 'resume_required'; readonly task: TaskItem }
  | {
      readonly result:
        | 'scope_unavailable_here'
        | 'scope_closed'
        | 'scope_conflict'
        | 'revision_conflict'
        | 'not_found'
        | 'forbidden'
        | 'invalid_transition'
        | 'idempotency_conflict';
    };
export type PreparedDevelopmentWork =
  | DevelopmentWorkResult
  | { readonly result: 'write'; readonly task: TaskItem; readonly receipt: DevelopmentWorkReceipt };

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
}
export function developmentDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}
export function developmentTaskSnapshot(task: TaskItem): string {
  return `sha256:${developmentDigest(task)}`;
}
export function developmentScopeKey(userId: string, scope: DevelopmentScopeV1): string {
  return developmentDigest([userId, scope.featureRef, scope.phaseKey, scope.workUnitRef]);
}
export function developmentActionKey(input: DevelopmentWorkTransition): string {
  return developmentDigest([input.actor.userId, input.actor.threadId, input.actor.catId, input.idempotencyKey]);
}
function actionDigest(input: DevelopmentWorkTransition): string {
  const normalized = {
    ...input,
    actor: { userId: input.actor.userId, threadId: input.actor.threadId, catId: input.actor.catId },
  };
  if (!input.contract) return developmentDigest(normalized);
  const { admittedAt: _admittedAt, ...admission } = input.contract.admission;
  return developmentDigest({ ...normalized, contract: { ...input.contract, admission } });
}
export function matchesDevelopmentScope(task: TaskItem, userId: string, scope: DevelopmentScopeV1): boolean {
  return (
    task.userId === userId &&
    !!task.entrustedWork?.developmentScope &&
    developmentScopeKey(userId, task.entrustedWork.developmentScope) === developmentScopeKey(userId, scope)
  );
}
export function developmentWorkIsOpen(task: TaskItem): boolean {
  return task.status !== 'done' && (!task.entrustedWork || task.entrustedWork.closure.state === 'open');
}

type Rejection = Exclude<DevelopmentWorkResult, { readonly task: TaskItem }>;

function scopeAccess(
  input: DevelopmentWorkTransition,
  scoped: readonly TaskItem[],
  existing: TaskItem | null,
): Rejection | null {
  if (scoped.some((task) => task.threadId !== input.actor.threadId)) return { result: 'scope_unavailable_here' };
  if (scoped.some((task) => task.ownerCatId !== input.actor.catId)) return { result: 'forbidden' };
  if (scoped.some((task) => !developmentWorkIsOpen(task))) return { result: 'scope_closed' };
  if (!existing) return null;
  if (
    existing.userId !== input.actor.userId ||
    existing.threadId !== input.actor.threadId ||
    existing.ownerCatId !== input.actor.catId
  )
    return { result: 'forbidden' };
  return developmentWorkIsOpen(existing) ? null : { result: 'scope_closed' };
}

function validLineage(
  input: DevelopmentWorkTransition,
  existing: TaskItem | null,
  lineage: readonly TaskItem[],
): boolean {
  if (input.action === 'resume' && (input.parentTaskRef || input.predecessorTaskRef)) return false;
  return (
    [
      [input.parentTaskRef, false],
      [input.predecessorTaskRef, true],
    ] as const
  ).every(([ref, terminal]) => {
    if (!ref) return true;
    const linked = lineage.find((task) => `task:work:${task.id}` === ref);
    return (
      !!linked &&
      linked.id !== existing?.id &&
      linked.kind === 'work' &&
      linked.userId === input.actor.userId &&
      linked.threadId === input.actor.threadId &&
      developmentWorkIsOpen(linked) !== terminal
    );
  });
}

function validateExistingAction(input: DevelopmentWorkTransition, existing: TaskItem | null): Rejection | null {
  if (input.action === 'admit') return existing ? { result: 'invalid_transition' } : null;
  if (!existing) return { result: 'not_found' };
  if (existing.kind !== 'work') return { result: 'invalid_transition' };
  const current = existing.entrustedWork;
  if (current && current.revision !== input.expectedRevision) return { result: 'revision_conflict' };
  if (input.action === 'adopt' && developmentTaskSnapshot(existing) !== input.expectedSnapshot)
    return { result: 'revision_conflict' };
  switch (input.action) {
    case 'resume':
      return current?.developmentScope && matchesDevelopmentScope(existing, input.actor.userId, input.scope)
        ? null
        : { result: 'invalid_transition' };
    case 'bind':
      return current && !current.developmentScope ? null : { result: 'invalid_transition' };
    case 'adopt':
      return current || existing.subjectKey?.startsWith('entrusted:') ? { result: 'invalid_transition' } : null;
  }
}

function prepareAggregate(
  input: DevelopmentWorkTransition,
  existing: TaskItem | null,
  scope: DevelopmentScopeV1,
  now: number,
): TaskItem | null {
  const current = existing?.entrustedWork;
  const initial = current ?? input.contract;
  if (!initial || initial.closure.state !== 'open') return null;
  // Preserve original admission/scope; each new source lives in its action receipt.
  const work = entrustedWorkV1Schema.parse({
    ...initial,
    time: { ...initial.time, ...input.time },
    developmentScope: current?.developmentScope ?? scope,
    revision: current ? current.revision + 1 : 1,
    ...(input.parentTaskRef ? { parentTaskRef: input.parentTaskRef } : {}),
    ...(input.predecessorTaskRef ? { predecessorTaskRef: input.predecessorTaskRef } : {}),
  });
  const subjectKey = `entrusted:development:${developmentActionKey(input)}`;
  if (existing)
    return { ...existing, entrustedWork: work, updatedAt: now, subjectKey: existing.subjectKey ?? subjectKey };
  return createEntrustedTaskItem(
    {
      subjectKey,
      entrustedWork: work,
      task: {
        threadId: input.actor.threadId,
        userId: input.actor.userId,
        createdBy: createCatId(input.actor.catId),
        ownerCatId: createCatId(input.actor.catId),
        title: input.title ?? work.intendedOutcome.slice(0, 200),
        why: input.why ?? '',
      },
    },
    now,
  );
}

/** Shared decision kernel; both stores commit the prepared aggregate and receipt atomically. */
export function prepareDevelopmentWorkTransition(
  input: DevelopmentWorkTransition,
  scoped: readonly TaskItem[],
  existing: TaskItem | null,
  receipt: DevelopmentWorkReceipt | null,
  lineage: readonly TaskItem[] = [],
  now = Date.now(),
): PreparedDevelopmentWork {
  const scope = developmentScopeV1Schema.parse(input.scope);
  const access = scopeAccess(input, scoped, existing);
  if (access) return access;
  if (receipt) {
    if (receipt.requestDigest !== actionDigest(input)) return { result: 'idempotency_conflict' };
    const task = existing ?? scoped.find((item) => item.id === receipt.taskId);
    return task ? { result: receipt.result, task, receiptRef: receipt.receiptRef } : { result: 'not_found' };
  }
  if (!validLineage(input, existing, lineage)) return { result: 'invalid_transition' };
  const collision = scoped.find((task) => task.id !== existing?.id);
  if (collision)
    return input.action === 'admit' ? { result: 'resume_required', task: collision } : { result: 'scope_conflict' };
  if (input.action === 'admit' && scoped[0]) return { result: 'resume_required', task: scoped[0] };
  const invalid = validateExistingAction(input, existing);
  if (invalid) return invalid;
  const task = prepareAggregate(input, existing, scope, now);
  if (!task?.entrustedWork) return { result: 'invalid_transition' };
  const result = ({ admit: 'admitted', resume: 'resumed', adopt: 'adopted', bind: 'bound' } as const)[input.action];
  return {
    result: 'write',
    task,
    receipt: {
      result,
      taskId: task.id,
      revision: task.entrustedWork.revision,
      requestDigest: actionDigest(input),
      sourceRef: input.sourceRef,
      sourceRevision: input.sourceRevision,
      receiptRef: `task:receipt:development:${task.id}:${developmentActionKey(input)}`,
    },
  };
}
