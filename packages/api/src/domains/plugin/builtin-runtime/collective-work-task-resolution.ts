import type { ConnectorInboxItem } from '@cat-cafe/collective-connector';
import {
  type CollectiveWorkProjection,
  collectiveSourceIdentitySchema,
  collectiveWorkAssignmentMatches,
} from '@cat-cafe/shared';
import type { IMessageStore, StoredMessage } from '../../cats/services/stores/ports/MessageStore.js';
import type { ITaskStore } from '../../cats/services/stores/ports/TaskStore.js';

export async function resolveAssignedWorkTask(
  options: {
    readonly messages: Pick<IMessageStore, 'getById'>;
    readonly tasks: ITaskStore;
  },
  input: {
    readonly ownerUserId: string;
    readonly inbox: readonly ConnectorInboxItem[];
    readonly work: CollectiveWorkProjection;
  },
  error: (kind: 'source' | 'task') => Error,
) {
  const assignment = input.work.assignment;
  if (!assignment || !input.work.assignmentEventId) throw error('source');
  const sources = input.inbox.filter((item) => assignmentInboxMatches(item, input.work, assignment));
  if (sources.length !== 1 || sources[0]?.routeReceipt?.kind !== 'thread_message') throw error('source');
  const source = await options.messages.getById(sources[0].routeReceipt.messageId);
  if (!sourceMatchesWork(source, input.ownerUserId, input.work, assignment)) throw error('source');
  const sourceRef = `message:${source.id}`;
  const tasks = (await options.tasks.listByKind('work')).filter(
    (task) =>
      task.userId === input.ownerUserId &&
      task.ownerCatId === assignment.catId &&
      task.status !== 'done' &&
      task.entrustedWork?.closure.state === 'open' &&
      task.entrustedWork.admission.sourceRefs.length === 1 &&
      task.entrustedWork.admission.sourceRefs[0] === sourceRef,
  );
  const task = tasks[0];
  const contract = task?.entrustedWork;
  if (tasks.length !== 1 || !task || !contract) throw error('task');
  return { task, revision: contract.revision };
}

function assignmentInboxMatches(
  item: ConnectorInboxItem,
  work: CollectiveWorkProjection,
  assignment: NonNullable<CollectiveWorkProjection['assignment']>,
) {
  const recipient = item.event.recipient;
  return (
    item.event.eventId === work.assignmentEventId &&
    item.event.serviceInstanceId === work.serviceInstanceId &&
    item.event.collectiveId === work.collectiveId &&
    item.event.workRequest === 'entrust' &&
    item.disposition === 'routed' &&
    item.routeReceipt?.kind === 'thread_message' &&
    recipient?.kind === 'agent' &&
    recipient.connectionId === assignment.connectionId &&
    recipient.humanId === assignment.humanId &&
    recipient.agentId === assignment.catId &&
    recipient.participationRevision === assignment.participationRevision
  );
}

function sourceMatchesWork(
  source: StoredMessage | null,
  ownerUserId: string,
  work: CollectiveWorkProjection,
  assignment: NonNullable<CollectiveWorkProjection['assignment']>,
): source is StoredMessage {
  if (
    !source ||
    source.userId !== ownerUserId ||
    source.catId !== null ||
    source.deletedAt ||
    source.recall ||
    source._tombstone ||
    source.source?.meta?.workRequest !== 'entrust'
  )
    return false;
  const identity = collectiveSourceIdentitySchema.safeParse(source.source?.meta?.participation);
  return (
    identity.success &&
    assignment === work.assignment &&
    collectiveWorkAssignmentMatches(identity.data, work, source.source?.meta?.workAcceptanceNotice)
  );
}
