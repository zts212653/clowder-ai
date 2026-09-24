import { type CatId, createCatId, type TaskItem } from '@cat-cafe/shared';
import {
  type ActionSuccessorFence,
  buildActionSuccessorFence,
} from '../../domains/ball-custody/ActionSuccessorAdmissionService.js';
import type { ActionSuccessorLease } from '../../domains/ball-custody/action-successor-state-machine.js';
import type { AppendMessageInput } from '../../domains/cats/services/stores/ports/MessageStore.js';

export type ReevalCaseTaskDispatchKind = 'responsibility' | 'reevaluation';
/**
 * RFC §5.1 / INV-I1: the carrier is admitted in one transaction, so a dispatch either has a durable
 * Message + Queue row or has nothing at all. `carrier_persist_failed` is the name of that single
 * "nothing was written" state, and it is the only code the projection allows without a
 * `carrierMessageId` (reeval-case.ts custody_dispatch_blocked invariant).
 *
 * `carrier_delivery_failed` and `carrier_not_enqueued` named the two halves of the old two-phase
 * carrier — a persisted queued Message whose Queue row never followed. Atomic admission removes
 * those states, but the closure event log is append-only: both codes stay in the schema so
 * historical events still replay. Nothing produces them any more.
 */
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

/**
 * The carrier envelope plus its custody, handed to admission unpersisted. The producer states the
 * facts; the component that owns atomic Message + Queue admission decides whether they become
 * durable (INV-I2: a producer carries no outbox of its own).
 */
export interface ReevalCaseTaskAdmissionInput {
  message: AppendMessageInput;
  task: ExecutableTask;
  lease: ActionSuccessorLease;
  sourceThreadId: string;
  callerCatId: CatId;
}

export type ReevalCaseTaskAdmissionResult =
  | { outcome: 'admitted'; messageId: string }
  /** Routing refused the owner, or the Queue could not take the row. Nothing was persisted. */
  | { outcome: 'not_admitted' };

export interface ReevalCaseTaskQueueAdmissionRequest {
  message: AppendMessageInput;
  targetCatId: CatId;
  userId: string;
  threadId: string;
  callerCatId: CatId;
  actionSuccessorFence: ActionSuccessorFence;
}

interface ReevalCaseTaskDispatchLogger {
  warn(context: Record<string, unknown>, message: string): void;
}

interface ReevalCaseTaskDispatcherOptions {
  /** Atomic Message + Queue admission. Returning without `admitted` means nothing was written. */
  admit(input: ReevalCaseTaskAdmissionInput): Promise<ReevalCaseTaskAdmissionResult>;
  log: ReevalCaseTaskDispatchLogger;
  now?: () => number;
}

function requireNonEmpty(value: string, field: string): void {
  if (!value.trim()) throw new Error(`${field} must be non-empty`);
}

/** Bind the active lease generation to the carrier, then hand both to atomic admission. */
export function createReevalCaseTaskQueueAdmission(
  admit: (request: ReevalCaseTaskQueueAdmissionRequest) => Promise<ReevalCaseTaskAdmissionResult>,
): (input: ReevalCaseTaskAdmissionInput) => Promise<ReevalCaseTaskAdmissionResult> {
  return async ({ message, task, lease, callerCatId }) =>
    admit({
      message,
      targetCatId: task.ownerCatId,
      userId: task.userId,
      threadId: task.threadId,
      callerCatId,
      actionSuccessorFence: buildActionSuccessorFence(lease, lease.dispatchId),
    });
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
    const message: AppendMessageInput = {
      from: { kind: 'agent', catId: callerCatId },
      userId: task.userId,
      content: carrierContent(input),
      mentions: [task.ownerCatId],
      origin: 'callback',
      timestamp: this.now(),
      threadId: task.threadId,
      deliveryStatus: 'queued',
      // One key for the whole carrier. The old split — this key on the Message and
      // `action:${leaseId}:${generation}` on the Queue row — is what let the two halves
      // disagree about whether a generation had already been dispatched.
      idempotencyKey: `f266-task-carrier:${input.task.id}:${input.lease.generation}`,
      extra: {
        isExplicitPost: true,
        crossPost: {
          sourceThreadId: input.sourceThreadId,
          effectClass: 'assign_work',
        },
        targetCats: [task.ownerCatId],
      },
    };

    let admission: ReevalCaseTaskAdmissionResult;
    try {
      admission = await this.options.admit({
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
          reasonCode: 'carrier_persist_failed',
          kind: input.kind,
          caseId: input.caseId,
          verdictId: input.verdictId,
          taskId: input.task.id,
          leaseId: input.lease.leaseId,
          leaseGeneration: input.lease.generation,
        },
        'F266 stable-case task carrier admission failed; lifecycle remains retryable',
      );
      return { outcome: 'blocked', reasonCode: 'carrier_persist_failed' };
    }
    if (admission.outcome !== 'admitted') {
      this.options.log.warn(
        {
          reasonCode: 'carrier_persist_failed',
          kind: input.kind,
          caseId: input.caseId,
          verdictId: input.verdictId,
          taskId: input.task.id,
          leaseId: input.lease.leaseId,
          leaseGeneration: input.lease.generation,
        },
        'F266 stable-case task carrier was not admitted; lifecycle remains retryable',
      );
      return { outcome: 'blocked', reasonCode: 'carrier_persist_failed' };
    }
    return { outcome: 'enqueued', messageId: admission.messageId };
  }
}
