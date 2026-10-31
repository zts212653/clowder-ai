import type {
  EntrustedWorkHumanDecisionV1,
  EntrustedWorkHumanTerminalReceiptV1,
  EntrustedWorkTaskExecutionStopV1,
  EntrustedWorkTaskExecutionV1,
  EntrustedWorkTerminalClosureV1,
  TaskItem,
} from '@cat-cafe/shared';
import {
  entrustedWorkHumanTerminalReceiptV1Schema,
  entrustedWorkTaskExecutionStopV1Schema,
  entrustedWorkTaskExecutionV1Schema,
} from '@cat-cafe/shared';
import type { AppendMessageInput, StoredMessage } from '../cats/services/stores/ports/MessageStore.js';

export interface HumanDecisionCoordinates {
  readonly actorRef: string;
  readonly authorityRef: string;
  readonly decisionRef: string;
  readonly idempotencyKey: string;
}

export interface PersistedHumanDecision {
  readonly decidedAt: number;
  readonly execution: EntrustedWorkTaskExecutionV1;
}

export function humanDecisionCoordinates(taskId: string, userId: string, decisionId: string): HumanDecisionCoordinates {
  return {
    actorRef: `user:${userId}`,
    authorityRef: `task:item:${taskId}#human-terminal:${decisionId}`,
    decisionRef: `task:work:${taskId}#human-decision:${decisionId}`,
    idempotencyKey: `entrusted-work-human-terminal:${taskId}:${decisionId}`,
  };
}

export function buildHumanTerminalClosure(input: {
  readonly task: TaskItem;
  readonly decision: EntrustedWorkHumanDecisionV1;
  readonly coordinates: HumanDecisionCoordinates;
  readonly decidedAt: number;
  readonly execution: EntrustedWorkTaskExecutionV1;
}): EntrustedWorkTerminalClosureV1 {
  const open = input.task.entrustedWork?.closure;
  if (!open || open.state !== 'open') throw new Error('human terminal closure requires open entrusted work');
  return input.decision.decision.state === 'satisfied'
    ? {
        condition: open.condition,
        expectedSignal: open.expectedSignal,
        state: 'satisfied',
        evidenceRefs: [input.coordinates.decisionRef],
        confirmation: {
          kind: 'human',
          actorRef: input.coordinates.actorRef,
          authorityRef: input.coordinates.authorityRef,
          decisionRef: input.coordinates.decisionRef,
          confirmedAt: input.decidedAt,
          taskExecution: input.execution,
        },
      }
    : {
        condition: open.condition,
        expectedSignal: open.expectedSignal,
        state: 'cancelled',
        evidenceRefs: [input.coordinates.decisionRef],
        disposition: {
          kind: 'cancelled',
          actorKind: 'human',
          actorRef: input.coordinates.actorRef,
          authorityRef: input.coordinates.authorityRef,
          dispositionRef: input.coordinates.decisionRef,
          disposedAt: input.decidedAt,
          reason: input.decision.decision.reason,
          taskExecution: input.execution,
        },
      };
}

export function satisfiedDecisionStop(): EntrustedWorkTaskExecutionStopV1 {
  return entrustedWorkTaskExecutionStopV1Schema.parse({
    state: 'not_requested',
    reasonCode: 'satisfied_decision',
    executionRefs: [],
  });
}

export function buildHumanTerminalReceipt(input: {
  readonly task: TaskItem;
  readonly decision: EntrustedWorkHumanDecisionV1;
  readonly coordinates: HumanDecisionCoordinates;
  readonly persisted: PersistedHumanDecision;
  readonly stop: EntrustedWorkTaskExecutionStopV1;
  readonly recordedAt: number;
}): EntrustedWorkHumanTerminalReceiptV1 {
  return entrustedWorkHumanTerminalReceiptV1Schema.parse({
    v: 1,
    kind: 'entrusted_work_human_terminal',
    originalThreadId: input.task.threadId,
    ownerUserId: input.task.userId,
    task: {
      taskId: input.task.id,
      subjectRef: `task:work:${input.task.id}`,
      ownerRef: `task:item:${input.task.id}`,
      previousRevision: input.decision.expectedRevision,
      revision: input.task.entrustedWork?.revision,
    },
    decision: {
      decisionId: input.decision.decisionId,
      state: input.decision.decision.state,
      actorRef: input.coordinates.actorRef,
      authorityRef: input.coordinates.authorityRef,
      decisionRef: input.coordinates.decisionRef,
      decidedAt: input.persisted.decidedAt,
      ...(input.decision.decision.state === 'cancelled' ? { reason: input.decision.decision.reason } : {}),
    },
    execution: { before: input.persisted.execution, stop: input.stop },
    recordedAt: input.recordedAt,
  });
}

export function humanTerminalReceiptMessage(
  receipt: EntrustedWorkHumanTerminalReceiptV1,
  coordinates: HumanDecisionCoordinates,
): AppendMessageInput {
  return {
    threadId: receipt.originalThreadId,
    userId: receipt.ownerUserId,
    from: { kind: 'user', userId: receipt.ownerUserId },
    content: receipt.decision.state === 'satisfied' ? '我确认这件已经完成。' : '我不再继续这件。',
    mentions: [],
    timestamp: receipt.recordedAt,
    idempotencyKey: coordinates.idempotencyKey,
    extra: { entrustedWorkHumanTerminalReceiptV1: receipt },
  };
}

export function matchPersistedHumanDecision(
  task: TaskItem,
  input: EntrustedWorkHumanDecisionV1,
  coordinates: HumanDecisionCoordinates,
): PersistedHumanDecision | null {
  const work = task.entrustedWork;
  if (!work || work.revision !== input.expectedRevision + 1) return null;
  const closure = work.closure;
  if (input.decision.state === 'satisfied') {
    if (
      closure.state !== 'satisfied' ||
      closure.confirmation?.kind !== 'human' ||
      closure.confirmation.actorRef !== coordinates.actorRef ||
      closure.confirmation.authorityRef !== coordinates.authorityRef ||
      closure.confirmation.decisionRef !== coordinates.decisionRef ||
      !closure.evidenceRefs.includes(coordinates.decisionRef) ||
      closure.confirmation.taskExecution.state !== 'idle' ||
      closure.confirmation.taskExecution.taskRef.revision !== input.expectedRevision
    ) {
      return null;
    }
    return {
      decidedAt: closure.confirmation.confirmedAt,
      execution: entrustedWorkTaskExecutionV1Schema.parse(closure.confirmation.taskExecution),
    };
  }
  if (
    closure.state !== 'cancelled' ||
    closure.disposition.actorKind !== 'human' ||
    closure.disposition.actorRef !== coordinates.actorRef ||
    closure.disposition.authorityRef !== coordinates.authorityRef ||
    closure.disposition.dispositionRef !== coordinates.decisionRef ||
    closure.disposition.reason !== input.decision.reason ||
    !closure.disposition.taskExecution ||
    !closure.evidenceRefs.includes(coordinates.decisionRef) ||
    closure.disposition.taskExecution.taskRef.revision !== input.expectedRevision
  ) {
    return null;
  }
  return {
    decidedAt: closure.disposition.disposedAt,
    execution: entrustedWorkTaskExecutionV1Schema.parse(closure.disposition.taskExecution),
  };
}

export function parseMatchingHumanTerminalReceipt(
  message: StoredMessage,
  task: TaskItem,
  coordinates: HumanDecisionCoordinates,
): EntrustedWorkHumanTerminalReceiptV1 | null {
  const parsed = entrustedWorkHumanTerminalReceiptV1Schema.safeParse(
    message.extra?.entrustedWorkHumanTerminalReceiptV1,
  );
  if (
    !parsed.success ||
    parsed.data.task.taskId !== task.id ||
    parsed.data.task.revision !== task.entrustedWork?.revision ||
    parsed.data.ownerUserId !== task.userId ||
    parsed.data.originalThreadId !== task.threadId ||
    parsed.data.decision.decisionRef !== coordinates.decisionRef ||
    !receiptMatchesTaskClosure(parsed.data, task)
  ) {
    return null;
  }
  return parsed.data;
}

function receiptMatchesTaskClosure(receipt: EntrustedWorkHumanTerminalReceiptV1, task: TaskItem): boolean {
  const closure = task.entrustedWork?.closure;
  if (!closure || closure.state === 'open' || closure.state === 'abandoned') return false;
  const storedExecution =
    closure.state === 'satisfied' ? closure.confirmation?.taskExecution : closure.disposition.taskExecution;
  const decisionMatches =
    closure.state === 'satisfied'
      ? receipt.decision.state === 'satisfied' &&
        closure.confirmation?.decisionRef === receipt.decision.decisionRef &&
        closure.confirmation.actorRef === receipt.decision.actorRef &&
        closure.confirmation.authorityRef === receipt.decision.authorityRef &&
        closure.confirmation.confirmedAt === receipt.decision.decidedAt
      : receipt.decision.state === 'cancelled' &&
        closure.disposition.dispositionRef === receipt.decision.decisionRef &&
        closure.disposition.actorRef === receipt.decision.actorRef &&
        closure.disposition.authorityRef === receipt.decision.authorityRef &&
        closure.disposition.disposedAt === receipt.decision.decidedAt &&
        closure.disposition.reason === receipt.decision.reason;
  return (
    decisionMatches &&
    storedExecution !== undefined &&
    JSON.stringify(storedExecution) === JSON.stringify(receipt.execution.before)
  );
}
