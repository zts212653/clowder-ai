import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  type CatId,
  type CollectiveWorkProjection,
  type CustodyAuthorityProvenanceV1,
  collectiveOwnerAdmissionV1Schema,
  collectiveSourceIdentitySchema,
  collectiveWorkAssignmentMatches,
  collectiveWorkExecutionMatches,
  type RegisteredCustodyGrantV1,
  type TaskItem,
} from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../../cats/services/stores/ports/TaskStore.js';

export function standingProvenance(
  source: StoredMessage,
  grant: RegisteredCustodyGrantV1,
): CustodyAuthorityProvenanceV1 {
  const sourceRef = `message:${source.id}`;
  return {
    grantRef: grant.grantRef,
    grantRevision: grant.revision,
    producerRef: grant.producerRef,
    grantOwnerRef: grant.grantOwnerRef,
    grantOwnerRevision: grant.grantOwnerRevision,
    sourceRef,
    sourceRevision: source.id,
    matchedScope: sourceRef,
    admissionAuthority: grant.admissionAuthority,
    idempotencySource: grant.idempotencySource,
  };
}

export function opaqueHostAdmission(source: StoredMessage, workId: string, fact: string) {
  return `host-admission:${createHash('sha256')
    .update(JSON.stringify([source.userId, source.id, workId, fact]))
    .digest('hex')}`;
}

/** Undefined means no matching fact. Closed, unavailable and duplicate facts always refuse, never mean absence. */
export async function findTaskForImmutableAssignment(
  tasks: Pick<ITaskStore, 'listByKind'>,
  messages: Pick<IMessageStore, 'getById'>,
  ownerUserId: string,
  catId: CatId,
  work: CollectiveWorkProjection,
) {
  const matches: TaskItem[] = [];
  for (const task of await tasks.listByKind('work')) {
    const refs = task.entrustedWork?.admission.sourceRefs;
    if (
      task.userId !== ownerUserId ||
      task.ownerCatId !== catId ||
      refs?.length !== 1 ||
      !refs[0]?.startsWith('message:')
    )
      continue;
    const source = await messages.getById(refs[0].slice('message:'.length));
    const identity = collectiveSourceIdentitySchema.safeParse(source?.source?.meta?.participation);
    if (
      source &&
      identity.success &&
      collectiveWorkAssignmentMatches(identity.data, work, source.source?.meta?.workAcceptanceNotice)
    )
      matches.push(task);
  }
  if (matches.length === 0) return undefined;
  if (
    matches.length !== 1 ||
    !matches[0]?.entrustedWork ||
    matches[0].status === 'done' ||
    matches[0].entrustedWork.closure.state !== 'open'
  )
    throw executionError('WORK_TASK_UNAVAILABLE', 'Current execution has no unique open Task for its first assignment');
  return matches[0];
}

export async function taskForImmutableAssignment(...input: Parameters<typeof findTaskForImmutableAssignment>) {
  const task = await findTaskForImmutableAssignment(...input);
  if (!task) throw executionError('WORK_TASK_UNAVAILABLE', 'Current execution has no Task for its first assignment');
  return task;
}

/** Writes a new execution receipt without changing the Task's immutable first admission. */
export async function issueWorkExecutionReceipt(input: {
  source: StoredMessage;
  catId: CatId;
  work: CollectiveWorkProjection;
  grant: RegisteredCustodyGrantV1;
  tasks: ITaskStore;
  messages: Pick<IMessageStore, 'getById' | 'appendIdempotent'>;
}) {
  const { source, catId, work } = input;
  const identity = collectiveSourceIdentitySchema.safeParse(source.source?.meta?.participation);
  if (
    !identity.success ||
    !collectiveWorkExecutionMatches(identity.data, work, source.source?.meta?.workExecutionNotice) ||
    work.lifecycle !== 'in_progress' ||
    !work.executionAuthority ||
    !work.assignmentEventId
  )
    throw executionError('WORK_EXECUTION_NOT_CURRENT', 'Current Service execution notice does not cover this Work');
  const task = await taskForImmutableAssignment(input.tasks, input.messages, source.userId, catId, work);
  const contract = task.entrustedWork;
  if (!contract) throw executionError('WORK_TASK_UNAVAILABLE', 'Task has no entrusted Work contract');
  const receipt = collectiveOwnerAdmissionV1Schema.parse({
    v: 1,
    sourceRef: `message:${source.id}`,
    catId,
    ownerAuthProvenance: 'strict',
    standingGrant: standingProvenance(source, input.grant),
    execution: {
      taskId: task.id,
      workId: work.workId,
      assignmentEventId: work.assignmentEventId,
      revision: work.executionAuthority.revision,
    },
  });
  const stored = await input.messages.appendIdempotent({
    userId: source.userId,
    threadId: task.threadId,
    catId: null,
    mentions: [],
    timestamp: Date.now(),
    content: `Continue admitted Work ${work.workId}, execution ${work.executionAuthority.revision}`,
    extra: { collectiveOwnerAdmissionV1: receipt },
    idempotencyKey: `collective-work-execution:${task.id}:${work.executionAuthority.revision}`,
  });
  if (!isDeepStrictEqual(stored.message.extra?.collectiveOwnerAdmissionV1, receipt))
    throw executionError('OWNER_ADMISSION_CONFLICT', 'This execution revision already has a different Host receipt');
  return {
    result: 'admitted' as const,
    subjectRef: `task:work:${task.id}`,
    revision: contract.revision,
    executionRevision: work.executionAuthority.revision,
    executionRef: `message:${stored.message.id}`,
    resultRevision: work.executionAuthority.resultRevision,
  };
}

export function executionError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

export function requireCurrentWorkExecution(work: CollectiveWorkProjection | undefined, executing: boolean) {
  if (!work) return;
  if (!['committed', 'in_progress', 'result_ready'].includes(work.lifecycle))
    throw executionError(
      'WORK_EXECUTION_NOT_CURRENT',
      'The current Service Work is terminal or no longer assigned for execution',
    );
  const authority = work.executionAuthority ?? work.acceptance;
  if (executing && authority && authority.hostAdmission?.state !== 'admitted')
    throw executionError('OWNER_ADMISSION_UNAVAILABLE', 'The accepted Work has no actual Host admission receipt');
}

/** The caller supplies a fresh Service Work while holding its own Connector fence. */
export async function executionPointerForTask(
  task: TaskItem,
  work: CollectiveWorkProjection,
  messages: Pick<IMessageStore, 'getById' | 'getByIdempotencyKey'>,
) {
  if (!task.userId) throw executionError('OWNER_ADMISSION_UNAVAILABLE', 'Task has no authenticated owner');
  const revision = work.executionAuthority?.revision ?? 1;
  if (revision === 1) return { executionRevision: 1, sourceRef: task.entrustedWork?.admission.sourceRefs[0] };
  const receipt = await messages.getByIdempotencyKey(
    task.userId,
    task.threadId,
    `collective-work-execution:${task.id}:${revision}`,
  );
  const parsed = collectiveOwnerAdmissionV1Schema.safeParse(receipt?.extra?.collectiveOwnerAdmissionV1);
  const pointer = parsed.success ? parsed.data.execution : undefined;
  if (
    !receipt ||
    receipt.source ||
    receipt.catId !== null ||
    receipt.userId !== task.userId ||
    receipt.threadId !== task.threadId ||
    receipt.deletedAt ||
    receipt.recall ||
    receipt._tombstone ||
    !parsed.success ||
    !pointer ||
    parsed.data.catId !== task.ownerCatId ||
    pointer.taskId !== task.id ||
    pointer.workId !== work.workId ||
    pointer.assignmentEventId !== work.assignmentEventId ||
    pointer.revision !== revision
  )
    throw executionError('OWNER_ADMISSION_UNAVAILABLE', 'Current execution has no exact protected Task receipt');
  const source = await messages.getById(parsed.data.sourceRef.slice('message:'.length));
  const identity = collectiveSourceIdentitySchema.safeParse(source?.source?.meta?.participation);
  if (
    !source ||
    source.deletedAt ||
    source.recall ||
    source._tombstone ||
    !identity.success ||
    !collectiveWorkExecutionMatches(identity.data, work, source.source?.meta?.workExecutionNotice) ||
    work.executionAuthority?.hostAdmission?.receiptRef !== opaqueHostAdmission(source, work.workId, task.id)
  )
    throw executionError('WORK_EXECUTION_NOT_CURRENT', 'Current execution receipt changed');
  return { executionRevision: revision, executionRef: `message:${receipt.id}`, sourceRef: parsed.data.sourceRef };
}

export function ownerReceiptGrant(message: StoredMessage): RegisteredCustodyGrantV1 {
  const receipt = collectiveOwnerAdmissionV1Schema.parse(message.extra?.collectiveOwnerAdmissionV1);
  return {
    grantRef: `message:${message.id}`,
    revision: 1,
    producerRef: 'host:collective-owner-admission',
    grantOwnerRef: `user:${message.userId}`,
    grantOwnerRevision: message.id,
    allowedSourceScope: [receipt.sourceRef],
    admissionAuthority: 'task_admit_or_resume',
    validity: { state: 'current', expiresAt: null },
    idempotencySource: 'source_ref_and_revision',
  };
}

export async function sourceForWorkTask(messages: Pick<IMessageStore, 'getById'>, task: TaskItem, sourceRef?: string) {
  const refs = sourceRef ? [sourceRef] : task.entrustedWork?.admission.sourceRefs;
  if (refs?.length !== 1 || !refs[0]?.startsWith('message:'))
    throw executionError('RETURN_UNAVAILABLE', 'Work has no unique result source');
  const source = await messages.getById(refs[0].slice('message:'.length));
  if (!source || source.deletedAt || source.recall || source._tombstone)
    throw executionError('RETURN_UNAVAILABLE', 'Work source is unavailable');
  return source;
}
