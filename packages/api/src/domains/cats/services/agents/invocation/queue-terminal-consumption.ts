import type { QueueTerminalConsumptionWitness } from '@cat-cafe/shared';

function isQueueTerminalConsumptionWitness(value: unknown): value is QueueTerminalConsumptionWitness {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind === 'terminal_silent' &&
    candidate.projectionState === 'covered_empty' &&
    candidate.wake === 'coordination_terminal'
  ) {
    return true;
  }
  if (
    candidate.kind === 'dispatch_handled_continuation' &&
    typeof candidate.sourceMessageId === 'string' &&
    candidate.sourceMessageId.length > 0 &&
    typeof candidate.dispositionEventId === 'string' &&
    candidate.dispositionEventId.length > 0 &&
    typeof candidate.dispositionAt === 'number' &&
    Number.isFinite(candidate.dispositionAt) &&
    candidate.dispositionAt >= 0
  ) {
    return true;
  }
  if (candidate.kind === 'source_response') {
    const outputMessageIds = candidate.outputMessageIds;
    return (
      Array.isArray(outputMessageIds) &&
      outputMessageIds.length > 0 &&
      outputMessageIds.every((messageId) => typeof messageId === 'string' && messageId.length > 0) &&
      new Set(outputMessageIds).size === outputMessageIds.length
    );
  }
  return (
    candidate.kind === 'managed_hold_continued' &&
    typeof candidate.sourceMessageId === 'string' &&
    candidate.sourceMessageId.length > 0 &&
    typeof candidate.taskId === 'string' &&
    candidate.taskId.length > 0 &&
    (candidate.transition === 'reheld' ||
      candidate.transition === 'event_wait' ||
      candidate.transition === 'transferred')
  );
}

export type QueueTerminalConsumptionCollection =
  | QueueTerminalConsumptionWitness
  | readonly QueueTerminalConsumptionWitness[];

export function normalizeQueueTerminalConsumptions(value: unknown): readonly QueueTerminalConsumptionWitness[] {
  const candidates = Array.isArray(value) ? value : value ? [value] : [];
  const result: QueueTerminalConsumptionWitness[] = [];
  for (const candidate of candidates) {
    if (!isQueueTerminalConsumptionWitness(candidate)) continue;
    const key =
      candidate.kind === 'terminal_silent'
        ? candidate.kind
        : candidate.kind === 'source_response'
          ? `${candidate.kind}:${candidate.outputMessageIds.join(',')}`
          : `${candidate.kind}:${candidate.sourceMessageId}`;
    if (
      result.some((existing) => {
        const existingKey =
          existing.kind === 'terminal_silent'
            ? existing.kind
            : existing.kind === 'source_response'
              ? `${existing.kind}:${existing.outputMessageIds.join(',')}`
              : `${existing.kind}:${existing.sourceMessageId}`;
        return existingKey === key;
      })
    ) {
      continue;
    }
    result.push(candidate);
  }
  return result;
}
