import { createHash } from 'node:crypto';
import { createCatId, type TaskItem } from '@cat-cafe/shared';
import type { IDispatchProposalStore } from '../domains/approval-hub/stores/ports/IDispatchProposalStore.js';
import { assertTaskHandoffSource, authorizeTaskHandoff } from '../domains/ball-custody/OrdinaryTaskHandoffAuthority.js';
import { OrdinaryTaskHandoffError } from '../domains/ball-custody/OrdinaryTaskHandoffContract.js';
import type { OrdinaryTaskHandoffService } from '../domains/ball-custody/OrdinaryTaskHandoffService.js';
import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { InvocationRecord } from '../domains/cats/services/agents/invocation/InvocationRegistry.js';
import type { IMessageStore, StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import { isOrdinaryImplementTask } from '../domains/cats/services/stores/ports/TaskStoreContract.js';
import { appendA2ASourceWithLedgerAdmission, planA2AFanoutAdmission } from './callback-a2a-trigger.js';
import { preflightNegativeAuthorizationFence } from './callback-negative-authorization-fence.js';

export async function prepareOrdinaryTaskResult(
  service: OrdinaryTaskHandoffService,
  task: TaskItem,
  record: InvocationRecord,
  messageId: string,
) {
  const handoffId = task.lastAppliedHandoffMessageRef?.slice('message:'.length);
  const handoff = handoffId ? await service.deps.messages.getById(handoffId) : null;
  const result = await service.deps.messages.getById(messageId);
  const request = handoff?.extra?.taskHandoff;
  const approval = request && 'approval' in request.issuer ? request.issuer.approval : null;
  if (
    !isOrdinaryImplementTask(task) ||
    !handoff ||
    !request ||
    !approval ||
    !result ||
    request.taskId !== task.id ||
    task.threadId === record.threadId ||
    request.targetThreadId !== record.threadId ||
    request.targetCatId !== record.catId ||
    task.userId !== record.userId ||
    task.ownerCatId !== request.ownerCatId ||
    (task.ownerRevision ?? 0) !== request.expected.ownerRevision ||
    result.threadId !== record.threadId ||
    result.userId !== record.userId ||
    result.from?.kind !== 'agent' ||
    result.from.catId !== record.catId ||
    result.deletedAt ||
    result.recall ||
    result._tombstone ||
    !result.content.trim()
  )
    throw new OrdinaryTaskHandoffError('task_result_authority_mismatch');
  const persisted = task.ordinaryFinalReport;
  if (
    task.status === 'done'
      ? persisted?.messageId !== result.id || persisted.handoffMessageId !== handoff.id
      : task.executionRef?.invocationId !== record.invocationId ||
        task.executionRef.sourceMessageId !== handoff.id ||
        result.extra?.stream?.turnInvocationId !== record.invocationId
  ) {
    throw new OrdinaryTaskHandoffError('task_result_assignment_changed');
  }
  assertTaskHandoffSource(handoff, request);
  await authorizeTaskHandoff(service.deps, task, request, handoff);
  const fence = task.status === 'done' ? undefined : await service.authorityFence(handoff.id, task, request);
  return { messageId: result.id, handoffMessageId: handoff.id, result, fence };
}

export interface OrdinaryTaskResultDeliveryDeps {
  messages: IMessageStore;
  queue: InvocationQueue;
  dispatchProposals?: IDispatchProposalStore;
  log: Parameters<typeof preflightNegativeAuthorizationFence>[0]['log'];
}

/** The original Task records the final source before the existing A2A transport can publish it. */
export async function deliverOrdinaryTaskResult(
  deps: OrdinaryTaskResultDeliveryDeps,
  task: TaskItem,
  record: InvocationRecord,
  result: StoredMessage,
) {
  const report = task.ordinaryFinalReport;
  if (task.status !== 'done' || !report || report.messageId !== result.id || !task.ownerCatId)
    throw new OrdinaryTaskHandoffError('task_result_not_committed');
  const clientMessageId = `ordinary-task-final:${createHash('sha256')
    .update(JSON.stringify([task.id, report.handoffMessageId]))
    .digest('hex')}`;
  const ports = { messageStore: deps.messages, invocationQueue: deps.queue };
  const targetCats = [task.ownerCatId];
  const from = { kind: 'agent' as const, catId: createCatId(record.catId) };
  const previous = await deps.messages.getByIdempotencyKey(record.userId, task.threadId, clientMessageId);
  if (previous) {
    if (
      previous.extra?.crossPost?.sourceMessageId !== result.id ||
      previous.deletedAt ||
      previous.recall ||
      previous._tombstone
    )
      throw new OrdinaryTaskHandoffError('task_result_delivery_conflict');
    return { clientMessageId, messageId: previous.id, replayed: true };
  }
  const denied = await preflightNegativeAuthorizationFence({
    content: '',
    isCrossThread: true,
    senderCatId: from.catId,
    sourceThreadId: record.threadId,
    sourceInvocationId: record.invocationId,
    sourceInvocationCreatedAt: record.createdAt,
    targetThreadId: task.threadId,
    ownerUserId: record.userId,
    explicitTargetCats: targetCats,
    suppressRouting: false,
    dispatchProposalStore: deps.dispatchProposals,
    log: deps.log,
  });
  if (denied) throw new OrdinaryTaskHandoffError('task_result_dispatch_blocked');
  const plan = planA2AFanoutAdmission(ports, {
    userId: record.userId,
    ownerAuthProvenance: record.ownerAuthProvenance,
    content: result.content,
    targetCats,
    threadId: task.threadId,
    createdAt: result.timestamp,
    callerCatId: from.catId,
    isCrossThread: true,
  });
  if (plan.acceptedTargetCats.length !== 1) throw new OrdinaryTaskHandoffError('task_result_dispatch_deferred');
  const delivered = await appendA2ASourceWithLedgerAdmission(
    ports,
    {
      from,
      userId: record.userId,
      threadId: task.threadId,
      content: result.content,
      ...(result.contentBlocks ? { contentBlocks: result.contentBlocks } : {}),
      origin: 'callback',
      mentions: targetCats,
      timestamp: Date.now(),
      idempotencyKey: clientMessageId,
      extra: {
        ...(result.extra?.rich ? { rich: result.extra.rich } : {}),
        crossPost: { sourceThreadId: record.threadId, sourceMessageId: result.id },
      },
    },
    { plan, ownerAuthProvenance: record.ownerAuthProvenance },
  );
  return { clientMessageId, messageId: delivered.message.id, replayed: delivered.preAdmittedReplayed ?? false };
}
