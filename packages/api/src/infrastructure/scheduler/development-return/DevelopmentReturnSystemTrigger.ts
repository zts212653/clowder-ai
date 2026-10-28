import type { TaskItem } from '@cat-cafe/shared';
import type { DevelopmentWorkActor } from '../../../domains/cats/services/stores/ports/DevelopmentWorkTransition.js';
import type { StoredMessage } from '../../../domains/cats/services/stores/ports/MessageStore.js';
import { isCurrentDevelopmentReturnReport } from './DevelopmentReturnReportSource.js';
import type { DevelopmentReturnDeps } from './DevelopmentReturnService.js';

type Deps = Pick<DevelopmentReturnDeps, 'tasks' | 'messages' | 'definitions'>;

function metaString(meta: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = meta[key];
  return typeof value === 'string' ? value : null;
}

/**
 * A development-return message is a system-produced trigger, never human
 * authority. Trust it only when its complete delivery envelope still points to
 * the exact terminal predecessor named by the current Task.
 */
export async function resolveTerminalDevelopmentReturnTrigger(
  deps: Deps,
  actor: DevelopmentWorkActor,
  task: TaskItem,
  trigger: StoredMessage,
): Promise<Record<string, unknown> | null> {
  const source = trigger.source;
  const meta = source?.meta;
  if (
    source?.connector !== 'development-return' ||
    !meta ||
    trigger.sourceParseFailure ||
    trigger.catId !== null ||
    trigger.from?.kind !== 'external' ||
    trigger.from.connectorId !== 'development-return' ||
    trigger.userId !== actor.userId ||
    trigger.threadId !== actor.threadId
  ) {
    return null;
  }
  const registrationId = metaString(meta, 'registrationId');
  if (!registrationId) return null;
  const predecessorReturn = deps.definitions.getPrivateExecutionReturn(registrationId);
  if (
    !predecessorReturn ||
    predecessorReturn.registrationId !== registrationId ||
    predecessorReturn.status !== 'delivered' ||
    predecessorReturn.reason !== 'terminal_report' ||
    !predecessorReturn.report ||
    predecessorReturn.deliveryRevision === undefined ||
    predecessorReturn.wakeMessageId !== trigger.id ||
    predecessorReturn.ownerUserId !== actor.userId ||
    predecessorReturn.ownerThreadId !== actor.threadId ||
    predecessorReturn.ownerCatId !== actor.catId ||
    task.entrustedWork?.predecessorTaskRef !== predecessorReturn.taskRef ||
    metaString(meta, 'taskRef') !== predecessorReturn.taskRef ||
    metaString(meta, 'observedRevision') !== String(predecessorReturn.observedRevision) ||
    metaString(meta, 'currentRevision') !== String(predecessorReturn.deliveryRevision) ||
    metaString(meta, 'reason') !== predecessorReturn.reason
  ) {
    return null;
  }
  const [predecessorTask, predecessorReport] = await Promise.all([
    deps.tasks.get(predecessorReturn.taskRef.slice('task:work:'.length)),
    deps.messages.getById(predecessorReturn.report.sourceMessageId),
  ]);
  if (
    !predecessorTask ||
    predecessorTask.kind !== 'work' ||
    predecessorTask.status !== 'done' ||
    predecessorTask.userId !== actor.userId ||
    predecessorTask.threadId !== actor.threadId ||
    predecessorTask.ownerCatId !== actor.catId ||
    predecessorTask.entrustedWork?.closure.state !== 'satisfied' ||
    predecessorTask.entrustedWork.revision < predecessorReturn.deliveryRevision ||
    !isCurrentDevelopmentReturnReport(predecessorReport, predecessorReturn)
  ) {
    return null;
  }
  return {
    connector: source.connector,
    connectorMeta: {
      registrationId,
      taskRef: metaString(meta, 'taskRef'),
      observedRevision: metaString(meta, 'observedRevision'),
      currentRevision: metaString(meta, 'currentRevision'),
      reason: metaString(meta, 'reason'),
    },
    predecessorReturn,
    predecessorReportSource: {
      id: predecessorReport.id,
      userId: predecessorReport.userId,
      threadId: predecessorReport.threadId,
      catId: predecessorReport.catId,
      sourceMessageRevision: predecessorReturn.report.sourceMessageRevision,
    },
    predecessorTask: {
      id: predecessorTask.id,
      userId: predecessorTask.userId,
      threadId: predecessorTask.threadId,
      ownerCatId: predecessorTask.ownerCatId,
      status: predecessorTask.status,
      revision: predecessorTask.entrustedWork.revision,
      closure: predecessorTask.entrustedWork.closure,
    },
  };
}
