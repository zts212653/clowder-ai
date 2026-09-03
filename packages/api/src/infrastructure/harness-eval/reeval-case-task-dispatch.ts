import { type CatId, createCatId, type TaskItem } from '@cat-cafe/shared';
import {
  type ActionSuccessorFence,
  buildActionSuccessorFence,
} from '../../domains/ball-custody/ActionSuccessorAdmissionService.js';
import type { ActionSuccessorLease } from '../../domains/ball-custody/action-successor-state-machine.js';
import type { IMessageStore, StoredMessage } from '../../domains/cats/services/stores/ports/MessageStore.js';

export type ReevalCaseTaskDispatchKind = 'responsibility' | 'reevaluation';
export type ReevalCaseTaskDispatchBlockReason =
  | 'carrier_persist_failed'
  | 'carrier_delivery_failed'
  | 'carrier_not_enqueued';

export type ReevalCaseTaskDispatchResult =
  | { outcome: 'enqueued'; messageId: string }
  | {
      outcome: 'blocked';
      reasonCode: ReevalCaseTaskDispatchBlockReason;
      messageId?: string;
    };

export interface ReevalCaseTaskDispatchInput {
  kind: ReevalCaseTaskDispatchKind;
  caseId: string;
  verdictId: string;
  sourceThreadId: string;
  callerCatId: string;
  task: TaskItem;
  lease: ActionSuccessorLease;
}

export interface ReevalCaseTaskDispatchPort {
  dispatch(input: ReevalCaseTaskDispatchInput): Promise<ReevalCaseTaskDispatchResult>;
}

type ExecutableTask = TaskItem & { ownerCatId: CatId; userId: string };

export interface ReevalCaseTaskDeliveryInput {
  message: StoredMessage;
  task: ExecutableTask;
  lease: ActionSuccessorLease;
  sourceThreadId: string;
  callerCatId: CatId;
}

export interface ReevalCaseTaskQueueInput {
  targetCatId: CatId;
  content: string;
  userId: string;
  threadId: string;
  triggerMessage: StoredMessage;
  callerCatId: CatId;
  actionSuccessorFence: ActionSuccessorFence;
}

interface ReevalCaseTaskDispatchLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

interface ReevalCaseTaskDispatcherOptions {
  messageStore: Pick<IMessageStore, 'append'>;
  deliver(input: ReevalCaseTaskDeliveryInput): Promise<{ outcome: 'enqueued' | 'unavailable' }>;
  log: ReevalCaseTaskDispatchLogger;
  now?: () => number;
}

function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} must be non-empty`);
}

export function createReevalCaseTaskQueueDelivery(
  enqueue: (input: ReevalCaseTaskQueueInput) => Promise<{ accepted: boolean }>,
): (input: ReevalCaseTaskDeliveryInput) => Promise<{ outcome: 'enqueued' | 'unavailable' }> {
  return async ({ message, task, lease, callerCatId }) => {
    const result = await enqueue({
      targetCatId: task.ownerCatId,
      content: message.content,
      userId: task.userId,
      threadId: task.threadId,
      triggerMessage: message,
      callerCatId,
      actionSuccessorFence: buildActionSuccessorFence(lease, lease.dispatchId),
    });
    return { outcome: result.accepted ? 'enqueued' : 'unavailable' };
  };
}

function requireExecutableCustody(input: ReevalCaseTaskDispatchInput): ExecutableTask {
  const { task, lease } = input;
  requireNonEmpty(input.caseId, 'caseId');
  requireNonEmpty(input.verdictId, 'verdictId');
  requireNonEmpty(input.sourceThreadId, 'sourceThreadId');
  requireNonEmpty(input.callerCatId, 'callerCatId');
  requireNonEmpty(lease.dispatchId, 'lease.dispatchId');
  if (!task.ownerCatId || !task.userId) {
    throw new Error('stable-case task carrier requires named owner and user custody');
  }
  if (
    task.status !== 'doing' ||
    lease.status !== 'active' ||
    lease.subjectRef !== `subject:task:${task.id}` ||
    lease.actionFamily !== 'implement' ||
    lease.successorSlot !== 'implementer' ||
    lease.holderCatIds.length !== 1 ||
    lease.holderCatIds[0] !== task.ownerCatId ||
    lease.holderThreadId !== task.threadId ||
    lease.tenantScope !== task.userId ||
    lease.terminalPredicate?.kind !== 'task_done'
  ) {
    throw new Error('stable-case task carrier requires matching active task custody');
  }
  return task as ExecutableTask;
}

function carrierContent(input: ReevalCaseTaskDispatchInput): string {
  const instruction =
    input.kind === 'responsibility'
      ? 'Execute the owner repair in this feature thread. Keep the task open until the repair reaches verified terminal truth.'
      : 'Run the trusted re-evaluation when due. Close or continue this same stable case, and mark the task done only after the canonical result is recorded.';
  return [
    '## F266 stable-case responsibility',
    '',
    `Task: ${input.task.id} — ${input.task.title}`,
    `Stable case: ${input.caseId}`,
    `Active verdict cycle: ${input.verdictId}`,
    `Why: ${input.task.why}`,
    '',
    instruction,
  ].join('\n');
}

export class ReevalCaseTaskDispatcher implements ReevalCaseTaskDispatchPort {
  private readonly now: () => number;

  constructor(private readonly options: ReevalCaseTaskDispatcherOptions) {
    this.now = options.now ?? Date.now;
  }

  async dispatch(input: ReevalCaseTaskDispatchInput): Promise<ReevalCaseTaskDispatchResult> {
    const task = requireExecutableCustody(input);
    const callerCatId = createCatId(input.callerCatId);
    let message: StoredMessage;
    try {
      message = await this.options.messageStore.append({
        userId: task.userId,
        catId: callerCatId,
        content: carrierContent(input),
        mentions: [task.ownerCatId],
        origin: 'callback',
        timestamp: this.now(),
        threadId: task.threadId,
        deliveryStatus: 'queued',
        idempotencyKey: `f266-task-carrier:${input.task.id}:${input.lease.generation}`,
        extra: {
          isExplicitPost: true,
          crossPost: {
            sourceThreadId: input.sourceThreadId,
            effectClass: 'assign_work',
          },
          targetCats: [task.ownerCatId],
        },
      });
    } catch (error) {
      this.options.log.warn(
        {
          err: error,
          reasonCode: 'carrier_persist_failed',
          kind: input.kind,
          caseId: input.caseId,
          verdictId: input.verdictId,
          taskId: input.task.id,
          leaseId: input.lease.leaseId,
          leaseGeneration: input.lease.generation,
        },
        'F266 stable-case task carrier persistence failed; lifecycle remains retryable',
      );
      return { outcome: 'blocked', reasonCode: 'carrier_persist_failed' };
    }
    let delivery: Awaited<ReturnType<ReevalCaseTaskDispatcherOptions['deliver']>>;
    try {
      delivery = await this.options.deliver({
        message,
        task,
        lease: input.lease,
        sourceThreadId: input.sourceThreadId,
        callerCatId,
      });
    } catch (error) {
      this.options.log.warn(
        {
          err: error,
          reasonCode: 'carrier_delivery_failed',
          kind: input.kind,
          caseId: input.caseId,
          verdictId: input.verdictId,
          taskId: input.task.id,
          leaseId: input.lease.leaseId,
          leaseGeneration: input.lease.generation,
          messageId: message.id,
        },
        'F266 stable-case task carrier delivery failed; lifecycle remains retryable',
      );
      return { outcome: 'blocked', reasonCode: 'carrier_delivery_failed', messageId: message.id };
    }
    if (delivery.outcome !== 'enqueued') {
      return { outcome: 'blocked', reasonCode: 'carrier_not_enqueued', messageId: message.id };
    }
    return { outcome: 'enqueued', messageId: message.id };
  }
}
