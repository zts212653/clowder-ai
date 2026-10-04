import type { AssignedWorkAuthorityScope, CollectiveConnector } from '@cat-cafe/collective-connector';
import {
  type CollectiveSourceIdentity,
  collectiveOwnerAdmissionV1Schema,
  collectiveWorkAssignmentMatches,
  createCatId,
  participationSourceIsCurrent,
} from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../domains/cats/services/stores/ports/TaskStore.js';
import { classifyEntrustedWorkSourceTime } from '../domains/growing/EntrustedWorkSourceSignals.js';
import {
  opaqueHostAdmission,
  taskForImmutableAssignment,
} from '../domains/plugin/builtin-runtime/collective-work/collective-work-execution-receipt.js';
import type { CollectiveWorkAuthority } from '../domains/plugin/builtin-runtime/collective-work-authority.js';

/** The strict owner click admits only an existing Service commitment; it cannot manufacture public Work. */
interface ManualCollectiveAdmissionInput {
  connector: CollectiveConnector;
  connectionId: string;
  ownerUserId: string;
  source: StoredMessage;
  identity: CollectiveSourceIdentity;
  requestId: string;
  threadId?: string;
  businessDeadline?: number;
  messages: IMessageStore;
  tasks: ITaskStore;
  authority: CollectiveWorkAuthority;
  resolveThread: (catId: string, preferredThreadId?: string) => Promise<string>;
}

export async function prepareManualCollectiveAdmission(input: ManualCollectiveAdmissionInput) {
  return input.connector.withSynchronizedAssignedWorkAuthority(
    input.connectionId,
    input.identity.eventId,
    async (scope) => {
      validateCurrentAssignment(scope, input.source, input.identity, input.ownerUserId);
      if (input.identity.actor.kind === 'agent') {
        const task = await actualAgentAdmission(scope, input);
        if (!task.entrustedWork) throw unavailable();
        return { result: 'prepared' as const, task, revision: task.entrustedWork.revision };
      }
      return prepareHumanAdmission(scope, input);
    },
  );
}

async function prepareHumanAdmission(scope: AssignedWorkAuthorityScope, input: ManualCollectiveAdmissionInput) {
  const outcome = scope.work.intendedOutcome;
  const relation = classifyEntrustedWorkSourceTime(outcome);
  if (relation === 'ambiguous') return { result: 'needs_clarification' as const, reason: 'ambiguous_source_time' };
  if (relation === 'deadline' && !input.businessDeadline) return { result: 'needs_clarification' as const };
  const existing = (await input.tasks.listByKind('work')).find(
    (task) =>
      task.userId === input.ownerUserId &&
      task.ownerCatId === input.identity.catId &&
      task.entrustedWork?.admission.sourceRefs.length === 1 &&
      task.entrustedWork.admission.sourceRefs[0] === `message:${input.source.id}`,
  );
  if (existing && input.threadId && existing.threadId !== input.threadId) throw unavailable('OWNER_ADMISSION_CONFLICT');
  const threadId = await input.resolveThread(input.identity.catId, existing?.threadId ?? input.threadId);
  const result = await input.authority.admit({
    ownerUserId: input.ownerUserId,
    ownerAuthProvenance: 'strict',
    source: input.source,
    catId: createCatId(input.identity.catId),
    threadId,
    requestId: input.requestId,
    title: scope.work.title.slice(0, 160),
    intendedOutcome: outcome,
    ...(input.businessDeadline
      ? { time: { businessDeadline: { value: input.businessDeadline, sourceRef: `message:${input.source.id}` } } }
      : {}),
    closure: {
      condition: 'A reviewable result answers the entrusted request at its original Collective location',
      expectedSignal: 'collective:accepted-result',
    },
  });
  if (result.result === 'needs_clarification') return result;
  const task = await input.tasks.get(result.subjectRef.slice('task:work:'.length));
  if (!task) throw unavailable();
  return { result: 'prepared' as const, task, revision: result.revision };
}

function validateCurrentAssignment(
  scope: AssignedWorkAuthorityScope,
  source: StoredMessage,
  identity: CollectiveSourceIdentity,
  ownerUserId: string,
) {
  const receipt = scope.inbox.find((item) => item.event.eventId === identity.eventId)?.routeReceipt;
  if (
    scope.connection.authorityStatus !== 'connected' ||
    scope.connection.authorizedHumanId !== scope.work.accountableHumanId ||
    scope.hostRoute?.localOwnerUserId !== ownerUserId ||
    !scope.hostRoute ||
    !participationSourceIsCurrent(
      scope.hostRoute,
      identity.catId,
      identity.location.channelId,
      identity.participationRevision,
    ) ||
    source.source?.meta?.workRequest !== 'entrust' ||
    !collectiveWorkAssignmentMatches(identity, scope.work, source.source?.meta?.workAcceptanceNotice) ||
    (scope.work.executionAuthority?.revision ?? 1) !== 1 ||
    !['committed', 'in_progress'].includes(scope.work.lifecycle) ||
    !['ready', 'in_progress'].includes(scope.work.status) ||
    receipt?.kind !== 'thread_message' ||
    receipt.messageId !== source.id ||
    receipt.threadId !== source.threadId ||
    receipt.catId !== identity.catId
  )
    throw unavailable();
}

async function actualAgentAdmission(scope: AssignedWorkAuthorityScope, input: ManualCollectiveAdmissionInput) {
  const task = await taskForImmutableAssignment(
    input.tasks,
    input.messages,
    input.ownerUserId,
    createCatId(input.identity.catId),
    scope.work,
  );
  const authority = scope.work.executionAuthority ?? scope.work.acceptance;
  const admission = task.entrustedWork?.admission;
  const ref = admission?.basis === 'authorized_source' ? admission.authorityRef : undefined;
  const message = ref?.startsWith('message:') ? await input.messages.getById(ref.slice('message:'.length)) : null;
  const receipt = collectiveOwnerAdmissionV1Schema.safeParse(message?.extra?.collectiveOwnerAdmissionV1);
  if (
    !authority ||
    authority.hostAdmission?.state !== 'admitted' ||
    authority.hostAdmission.receiptRef !== opaqueHostAdmission(input.source, scope.work.workId, task.id) ||
    !message ||
    message.source ||
    message.catId !== null ||
    message.userId !== input.ownerUserId ||
    message.threadId !== task.threadId ||
    message.deletedAt ||
    message.recall ||
    message._tombstone ||
    !receipt.success ||
    receipt.data.sourceRef !== `message:${input.source.id}` ||
    receipt.data.catId !== input.identity.catId ||
    !receipt.data.standingGrant ||
    (input.threadId && input.threadId !== task.threadId)
  )
    throw unavailable();
  return task;
}

function unavailable(code = 'OWNER_ADMISSION_UNAVAILABLE') {
  return Object.assign(
    new Error('Only the exact current committed Collective Work can enter private owner execution'),
    { code },
  );
}
