import type { TurnExecutionRecord } from '@cat-cafe/shared';
import { readQueueTargetExecution } from '../../../cats/services/agents/invocation/queue-ledger/QueueTargetExecutionView.js';
import type { IMessageStore, StoredMessage } from '../../../cats/services/stores/ports/MessageStore.js';
import {
  matchesTurnExecutionSource,
  type TurnExecutionSourceReadPort,
} from '../../../cats/services/stores/ports/TurnExecutionStore.js';

/** Private source identity stays in internal execution causality, never in a public response. */
export async function readModificationSourceExecution(
  messages: Pick<IMessageStore, 'getById'>,
  turns: TurnExecutionSourceReadPort | undefined,
  source: StoredMessage,
  targetId: string,
  invocationId?: string,
): Promise<TurnExecutionRecord | undefined> {
  if (!turns || source.lifecycle?.kind !== 'input' || source.recall || source.deletedAt || source._tombstone) return;
  const query = { userId: source.userId, threadId: source.threadId, catId: targetId, messageId: source.id };
  if (source.visibility === 'whisper') {
    if (!source.whisperTo?.includes(targetId as (typeof source.whisperTo)[number])) return;
    if (invocationId) {
      const child = await turns.get(invocationId);
      return child && child.invocationId === invocationId && matchesTurnExecutionSource(child, query)
        ? child
        : undefined;
    }
    const matches =
      (await turns.listBySource?.(query))?.filter((child) => matchesTurnExecutionSource(child, query)) ?? [];
    return matches.length === 1 ? matches[0] : undefined;
  }
  const execution = await readQueueTargetExecution(messages, undefined, source, targetId);
  if (execution?.kind !== 'response' || (invocationId && invocationId !== execution.response.invocationId)) return;
  const child = await turns.get(execution.response.invocationId);
  return child && child.invocationId === execution.response.invocationId && matchesTurnExecutionSource(child, query)
    ? child
    : undefined;
}
