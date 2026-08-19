import type { QueueMessageReceipt } from '@cat-cafe/shared';
import type { ChatMessage } from '@/stores/chat-types';

export type TurnAbsorptionKind = 'responded' | 'completed_with_turn' | 'actionable' | 'withdrawn_after_exposure';

export interface TurnAbsorptionItem {
  sourceMessageId: string;
  sourceTimestamp: number;
  content: string;
  contentBlocks?: ChatMessage['contentBlocks'];
  kind: TurnAbsorptionKind;
  /** Receipt transport scope; cross-thread completion closes the carrier turn, not its carried work. */
  receiptScope?: QueueMessageReceipt['scope'];
  /** The cat that consumed this source; never the source author identity. */
  handlerCatId: string;
  invocationId: string;
  seenAt: number;
  outcomeAt?: number;
  recalled: boolean;
  /** True only when the canonical source bubble can hide its body without masking actionable work. */
  bodyProjectedHere: boolean;
}

export interface TurnAbsorptionProjection {
  invocationId: string;
  counts: {
    total: number;
    handled: number;
    responded: number;
    completedWithTurn: number;
    actionable: number;
    withdrawnAfterExposureUnhandled: number;
  };
  items: TurnAbsorptionItem[];
  defaultExpanded: boolean;
}

type ReceiptTarget = QueueMessageReceipt['targets'][number];

function projectedExecutionIds(message: ChatMessage): string[] {
  const executionIds: string[] = [];
  if (message.extra?.turnExecution) executionIds.push(message.extra.turnExecution.invocationId);
  if (message.extra?.auxiliaryTurnExecutions) {
    for (const execution of message.extra.auxiliaryTurnExecutions) executionIds.push(execution.invocationId);
  }
  return executionIds;
}

export function terminalSurfaceMessageId(messages: readonly ChatMessage[], invocationId: string): string | undefined {
  for (const candidate of [...messages].reverse()) {
    if (candidate.isStreaming) continue;
    if (projectedExecutionIds(candidate).includes(invocationId)) return candidate.id;
  }
  return undefined;
}

function exactExposedTarget(message: ChatMessage, invocationId: string): ReceiptTarget | undefined {
  const receipt = message.extra?.queueReceipt;
  if (!receipt || receipt.scope === 'primary_trigger' || message.extra?.recall?.exposure === 'none') return undefined;
  return receipt.targets.find((target) => target.invocationId === invocationId && typeof target.seenAt === 'number');
}

function classifyTarget(target: ReceiptTarget): TurnAbsorptionKind {
  const outcome = target.outcome;
  if (outcome && outcome.invocationId === target.invocationId) {
    return outcome.disposition === 'responded' ? 'responded' : 'completed_with_turn';
  }
  // Withdrawal is an exact receipt truth, independent of why custody ended.
  // True recall adds a tombstone fact, while Queue "stop future processing"
  // keeps authored history; both still belong in this same exposed/unhandled
  // denominator bucket.
  if (target.state === 'withdrawn') return 'withdrawn_after_exposure';
  return 'actionable';
}

function hasExactHandledOutcome(target: ReceiptTarget): boolean {
  const outcome = target.outcome;
  if (target.state !== 'handled' || !outcome || outcome.invocationId !== target.invocationId) return false;
  return outcome.disposition === 'responded' || outcome.disposition === 'completed_with_turn';
}

/**
 * A source body moves visually only after every target has reached a terminal
 * state. A handled target must never hide text that another target still needs
 * to act on. Recalled messages are already content-free by store contract.
 */
export function shouldFoldSourceBody(message: ChatMessage): boolean {
  const receipt = message.extra?.queueReceipt;
  if (!receipt || receipt.scope === 'primary_trigger' || message.extra?.recall) return false;
  const hasHandledTarget = receipt.targets.some(hasExactHandledOutcome);
  return (
    hasHandledTarget && receipt.targets.every((target) => target.state === 'handled' || target.state === 'withdrawn')
  );
}

export function foldedSourceInvocationId(message: ChatMessage): string | undefined {
  if (!shouldFoldSourceBody(message)) return undefined;
  return message.extra?.queueReceipt?.targets.find(hasExactHandledOutcome)?.invocationId;
}

export function foldedSourceInvocationIdInTimeline(
  message: ChatMessage,
  messages: readonly ChatMessage[],
): string | undefined {
  const invocationId = foldedSourceInvocationId(message);
  return invocationId && terminalSurfaceMessageId(messages, invocationId) ? invocationId : undefined;
}

function targetOutcomeAt(target: ReceiptTarget): number | undefined {
  const outcome = target.outcome;
  if (target.state === 'handled' && outcome && outcome.invocationId === target.invocationId) {
    return outcome.handledAt;
  }
  if (target.state === 'withdrawn' && typeof target.withdrawnAt === 'number') return target.withdrawnAt;
  return target.seenAt;
}

/**
 * Pure F264 Gap F projection. It consumes the existing receipt lineage only;
 * wording, message text and token positions never become handling evidence.
 */
export function projectTurnAbsorptionSummary(
  messages: readonly ChatMessage[],
  invocationId: string,
): TurnAbsorptionProjection | null {
  const bySourceMessage = new Map<string, TurnAbsorptionItem>();
  for (const message of messages) {
    if (message.type !== 'user' || bySourceMessage.has(message.id)) continue;
    const target = exactExposedTarget(message, invocationId);
    if (!target || !target.invocationId || target.seenAt === undefined) continue;
    const recalled = message.extra?.recall?.exposure === 'seen';
    const bodyProjectedHere = foldedSourceInvocationId(message) === invocationId;
    bySourceMessage.set(message.id, {
      sourceMessageId: message.id,
      sourceTimestamp: message.timestamp,
      content: message.content,
      contentBlocks: message.contentBlocks,
      kind: classifyTarget(target),
      receiptScope: message.extra?.queueReceipt?.scope,
      handlerCatId: target.catId,
      invocationId: target.invocationId,
      seenAt: target.seenAt,
      outcomeAt: targetOutcomeAt(target),
      recalled,
      bodyProjectedHere,
    });
  }

  const items = [...bySourceMessage.values()].sort(
    (left, right) =>
      left.sourceTimestamp - right.sourceTimestamp || left.sourceMessageId.localeCompare(right.sourceMessageId),
  );
  if (items.length === 0) return null;

  const responded = items.filter((item) => item.kind === 'responded').length;
  const completedWithTurn = items.filter((item) => item.kind === 'completed_with_turn').length;
  const actionable = items.filter((item) => item.kind === 'actionable').length;
  const withdrawnAfterExposureUnhandled = items.filter((item) => item.kind === 'withdrawn_after_exposure').length;
  return {
    invocationId,
    counts: {
      total: items.length,
      handled: responded + completedWithTurn,
      responded,
      completedWithTurn,
      actionable,
      withdrawnAfterExposureUnhandled,
    },
    items,
    defaultExpanded: items.length <= 3,
  };
}

/**
 * Fold only into the one canonical footer selected for this source body.
 * A second handled target still gets an exact count/item, but never a second
 * body projection.
 */
export function shouldFoldSourceIntoTurnSummary(message: ChatMessage, invocationId: string): boolean {
  return foldedSourceInvocationId(message) === invocationId;
}
