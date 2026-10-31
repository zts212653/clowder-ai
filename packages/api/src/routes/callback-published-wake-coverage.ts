import type { InvocationQueue } from '../domains/cats/services/agents/invocation/InvocationQueue.js';
import type { QueueProcessor } from '../domains/cats/services/agents/invocation/QueueProcessor.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { ITurnExecutionStore } from '../domains/cats/services/stores/ports/TurnExecutionStore.js';

/** Full-read surfaces share the same exact-child check and Queue coverage transaction. */
export async function coverPublishedMessageReads(
  deps: {
    invocationQueue?: InvocationQueue;
    messageStore: IMessageStore;
    turnExecutionStore?: Pick<ITurnExecutionStore, 'get'>;
    queueProcessor?: Partial<Pick<QueueProcessor, 'adoptExposedQueuedEntries'>>;
  },
  input: {
    threadId: string;
    userId: string;
    catId: string;
    invocationId: string;
    parentInvocationId: string;
    messageIds: readonly string[];
  },
): Promise<string[]> {
  if (!deps.invocationQueue || !deps.turnExecutionStore || !deps.queueProcessor?.adoptExposedQueuedEntries) return [];
  const entries = await deps.invocationQueue.projectedWakeCandidates(
    input.threadId,
    input.userId,
    input.catId,
    input.messageIds,
    deps.messageStore,
  );
  if (!entries.length) return [];
  const execution = await deps.turnExecutionStore.get(input.invocationId);
  if (
    !execution ||
    execution.invocationId !== input.invocationId ||
    execution.parentInvocationId !== input.parentInvocationId ||
    execution.threadId !== input.threadId ||
    execution.userId !== input.userId ||
    execution.catId !== input.catId ||
    execution.status !== 'running'
  )
    return [];
  const covered = await deps.queueProcessor.adoptExposedQueuedEntries({ ...input, entries, seenAt: Date.now() });
  if (covered.outcome === 'rejected') {
    if (covered.reason === 'active_run_missing') return [];
    throw new Error(`published_wake_coverage_${covered.reason}`);
  }
  return entries.map((entry) => entry.messageId);
}
