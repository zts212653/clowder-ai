import type { TaskItem } from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../cats/services/stores/ports/ThreadStore.js';
import type { TaskApprovedDelegateProvider } from './action-subject-delegate-contract.js';
import { OrdinaryTaskHandoffError, type OrdinaryTaskHandoffRequest } from './OrdinaryTaskHandoffContract.js';

type AuthorityDeps = {
  messages: Pick<IMessageStore, 'getById'>;
  threads: Pick<IThreadStore, 'get'>;
  delegates?: TaskApprovedDelegateProvider;
};

export async function currentTaskDelegates(task: TaskItem, provider?: TaskApprovedDelegateProvider) {
  return task.ownerCatId && task.userId && provider
    ? provider.getForTask(task.id, task.threadId, task.ownerCatId, task.userId, undefined, task.title)
    : [];
}

export async function authorizeTaskHandoff(
  deps: AuthorityDeps,
  task: TaskItem,
  request: OrdinaryTaskHandoffRequest,
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
    target.createdBy !== task.userId ||
    source.projectPath !== home.projectPath ||
    target.projectPath !== home.projectPath
  )
    throw new OrdinaryTaskHandoffError('task_thread_authority_mismatch');

  const previousId = task.lastAppliedHandoffMessageRef?.slice('message:'.length);
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
  if (task.pluginWait?.await || task.deploymentWait?.await) throw new OrdinaryTaskHandoffError('task_wait_active');
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
  if (request.targetThreadId === task.threadId) {
    if (request.ownerCatId !== request.targetCatId) throw new OrdinaryTaskHandoffError('task_target_mismatch');
    return;
  }
  // The canonical Task remains at home. Exact approved targets govern initial child admission.
  const delegates = await currentTaskDelegates(task, deps.delegates);
  const anchor = request.approvedAnchor;
  if (
    !anchor ||
    request.ownerCatId !== task.ownerCatId ||
    anchor.threadId !== request.targetThreadId ||
    !delegates.some(
      (d) => d.catId === anchor.catId && d.threadId === anchor.threadId && d.evidenceRef === anchor.evidenceRef,
    )
  )
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
    message.origin !== 'callback'
  )
    throw new OrdinaryTaskHandoffError('task_handoff_source_mismatch');
}
