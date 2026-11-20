import type { TaskItem } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { IProposalStore } from '../cats/services/stores/ports/ProposalStore.js';
import type { ITaskStore } from '../cats/services/stores/ports/TaskStore.js';
import type { IThreadStore, Thread } from '../cats/services/stores/ports/ThreadStore.js';
import type { TaskApprovedDelegateProvider } from './action-subject-delegate-contract.js';
import { approvedGenericTaskContinuation } from './approved-generic-task-proposal.js';
import { matchesContinuationChild } from './approved-task-continuation.js';
import { OrdinaryTaskHandoffError, type OrdinaryTaskHandoffRequest } from './OrdinaryTaskHandoffContract.js';
import { hasOutstandingDeploymentWait, retainedDeploymentWaitAllowsHandoff } from './ordinary-task-deployment-wait.js';

type AuthorityDeps = {
  tasks: Pick<ITaskStore, 'getWaitRegistration'>;
  messages: Pick<IMessageStore, 'getById'>;
  threads: Pick<IThreadStore, 'get'>;
  delegates?: TaskApprovedDelegateProvider;
  proposals?: Pick<IProposalStore, 'get'>;
};

export async function currentTaskDelegates(task: TaskItem, provider?: TaskApprovedDelegateProvider) {
  return task.ownerCatId && task.userId && provider
    ? provider.getForTask(
        task.id,
        task.threadId,
        task.ownerCatId,
        task.userId,
        undefined,
        task.title,
        task.ownerRevision ?? 0,
      )
    : [];
}

async function assertApprovedIssuerCurrent(
  deps: AuthorityDeps,
  task: TaskItem,
  request: OrdinaryTaskHandoffRequest,
  target: Thread,
  carrier?: StoredMessage,
) {
  if (!('approval' in request.issuer)) return;
  const approval = request.issuer.approval;
  const proposal = await deps.proposals?.get(approval.proposalId);
  const receipt =
    proposal && approvedGenericTaskContinuation(proposal, { ...task, ownerRevision: task.ownerRevision ?? 0 });
  const origin = proposal?.sourceMessageId ? await deps.messages.getById(proposal.sourceMessageId) : null;
  if (
    !proposal ||
    !receipt ||
    receipt.receiptId !== approval.receiptId ||
    receipt.approval?.ownerRevision !== request.expected.ownerRevision ||
    receipt.approval.previousHandoffMessageRef !== request.expected.lastAppliedHandoffMessageRef ||
    request.issuer.catId !== task.ownerCatId ||
    request.issuer.threadId !== task.threadId ||
    request.stopPrevious ||
    proposal.preferredCats[0] !== request.targetCatId ||
    !matchesContinuationChild(proposal, target) ||
    target.approvedBy !== receipt.userId ||
    !Number.isFinite(target.approvedAt) ||
    (carrier &&
      (carrier.extra?.crossPost?.sourceMessageId !== proposal.sourceMessageId ||
        carrier.extra?.crossPost?.sourceInvocationId !== proposal.sourceInvocationId)) ||
    !origin ||
    origin.userId !== task.userId ||
    origin.threadId !== task.threadId ||
    origin.deletedAt ||
    origin.recall ||
    origin._tombstone
  )
    throw new OrdinaryTaskHandoffError('task_approval_authority_mismatch');
}

export async function authorizeTaskHandoff(
  deps: AuthorityDeps,
  task: TaskItem,
  request: OrdinaryTaskHandoffRequest,
  carrier?: StoredMessage,
): Promise<void> {
  if (task.userId !== request.issuer.userId) throw new OrdinaryTaskHandoffError('foreign_task');
  const [home, source, target] = await Promise.all([
    deps.threads.get(task.threadId),
    deps.threads.get(request.issuer.threadId),
    deps.threads.get(request.targetThreadId),
  ]);
  if (
    !home ||
    !source ||
    !target ||
    home.deletedAt ||
    source.deletedAt ||
    target.deletedAt ||
    home.createdBy !== task.userId ||
    source.createdBy !== task.userId ||
    target.createdBy !== task.userId
  )
    throw new OrdinaryTaskHandoffError('task_thread_authority_mismatch');

  await assertApprovedIssuerCurrent(deps, task, request, target, carrier);
  // Keep the predecessor stable after application, including replay/provider admission.
  const previousId = request.expected.lastAppliedHandoffMessageRef?.slice('message:'.length);
  const previous = previousId ? await deps.messages.getById(previousId) : null;
  const previousRequest = previous?.extra?.taskHandoff;
  const assignedDelegate =
    previousRequest &&
    previousRequest.taskId === task.id &&
    previousRequest.ownerCatId === task.ownerCatId &&
    previousRequest.targetCatId === request.issuer.catId &&
    previousRequest.targetThreadId === request.issuer.threadId &&
    !previous?.deletedAt &&
    !previous?.recall &&
    !previous?._tombstone;
  const owner = request.issuer.catId === task.ownerCatId && request.issuer.threadId === task.threadId;
  const originalSource = task.sourceMessageId ? await deps.messages.getById(task.sourceMessageId) : null;
  if (
    task.sourceMessageId &&
    (!originalSource ||
      originalSource.deletedAt ||
      originalSource.recall ||
      originalSource._tombstone ||
      originalSource.userId !== task.userId)
  )
    throw new OrdinaryTaskHandoffError('task_authorization_source_unavailable');
  if (task.pluginWait?.await) throw new OrdinaryTaskHandoffError('task_wait_active');
  const collaborator =
    request.issuer.threadId === task.threadId &&
    !originalSource?.deletedAt &&
    originalSource?.userId === task.userId &&
    originalSource.threadId === task.threadId &&
    (originalSource.from?.kind === 'user' ||
      (originalSource.from?.kind === 'agent' && originalSource.from.catId === task.createdBy)) &&
    originalSource.mentions.some((cat) => cat === request.issuer.catId);
  const originalCoordinator = task.createdBy === request.issuer.catId;
  if (!owner && !collaborator && !originalCoordinator && !assignedDelegate)
    throw new OrdinaryTaskHandoffError('task_issuer_has_no_standing');
  const delegates =
    request.targetThreadId !== task.threadId || source.projectPath !== home.projectPath
      ? await currentTaskDelegates(task, deps.delegates)
      : [];
  const isCurrentApprovedChild = (anchor: OrdinaryTaskHandoffRequest['approvedAnchor'], threadId: string) =>
    anchor?.threadId === threadId &&
    delegates.some(
      (d) => d.catId === anchor.catId && d.threadId === anchor.threadId && d.evidenceRef === anchor.evidenceRef,
    );
  // Project differences require the exact live proposal/continuation proof for
  // each child. Same-user or creator standing alone never grants this exception.
  if (
    (source.projectPath !== home.projectPath &&
      (!assignedDelegate || !isCurrentApprovedChild(previousRequest?.approvedAnchor, source.id))) ||
    (target.projectPath !== home.projectPath && !isCurrentApprovedChild(request.approvedAnchor, target.id))
  )
    throw new OrdinaryTaskHandoffError('task_thread_authority_mismatch');
  const ownsQueuedDeploymentOutcome =
    task.deploymentWait?.waitOutcome?.delivery === 'delivered' && task.deploymentWait.transportAttempt !== undefined;
  if (
    (hasOutstandingDeploymentWait(task) || ownsQueuedDeploymentOutcome) &&
    (request.targetThreadId === task.threadId ||
      request.ownerCatId !== task.ownerCatId ||
      request.approvedAnchor?.catId !== request.targetCatId ||
      !isCurrentApprovedChild(request.approvedAnchor, request.targetThreadId) ||
      !(await retainedDeploymentWaitAllowsHandoff(task, deps.tasks, deps.messages)))
  )
    throw new OrdinaryTaskHandoffError('task_wait_active');
  if (request.targetThreadId === task.threadId) {
    if (request.ownerCatId !== request.targetCatId) throw new OrdinaryTaskHandoffError('task_target_mismatch');
    return;
  }
  // The canonical Task remains at home. Exact approved targets govern initial child admission.
  const anchor = request.approvedAnchor;
  if (!anchor || request.ownerCatId !== task.ownerCatId || !isCurrentApprovedChild(anchor, request.targetThreadId))
    throw new OrdinaryTaskHandoffError('task_approved_contract_unavailable');
  if (anchor.catId === request.targetCatId) return;
  // A later same-child successor inherits only an anchor already used by this exact Task assignment.
  if (
    !previousRequest ||
    previous?.deletedAt ||
    previous?.recall ||
    previous?._tombstone ||
    previousRequest.targetThreadId !== request.targetThreadId ||
    previousRequest.approvedAnchor?.catId !== anchor.catId ||
    previousRequest.approvedAnchor?.threadId !== anchor.threadId ||
    previousRequest.approvedAnchor?.evidenceRef !== anchor.evidenceRef
  )
    throw new OrdinaryTaskHandoffError('task_delegate_anchor_missing');
}

export function assertTaskHandoffSource(message: StoredMessage, request: OrdinaryTaskHandoffRequest): void {
  if (
    message.deletedAt ||
    message.recall ||
    message._tombstone ||
    message.deliveryStatus === 'canceled' ||
    message.extra?.taskHandoffInvalid ||
    message.userId !== request.issuer.userId ||
    message.threadId !== request.targetThreadId ||
    message.from?.kind !== 'agent' ||
    message.from.catId !== request.issuer.catId ||
    message.mentions.length !== 1 ||
    message.mentions[0] !== request.targetCatId ||
    ('approval' in request.issuer
      ? message.extra?.crossPost?.sourceThreadId !== request.issuer.threadId
      : message.origin !== 'callback')
  )
    throw new OrdinaryTaskHandoffError('task_handoff_source_mismatch');
}
