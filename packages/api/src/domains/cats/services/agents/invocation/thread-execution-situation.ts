import { hasExactLifecycleProcessingDispatch, type LifecycleActiveRun, type MessageFrom } from '@cat-cafe/shared';
import { messageFrom } from '../../stores/message-from.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';

export interface ThreadExecutionSituationSourceMessage {
  readonly messageId: string;
  readonly from: MessageFrom;
}

export interface ThreadExecutionSituationRun {
  readonly phase: 'processing';
  readonly targetId: string;
  readonly invocationId: string;
  readonly responseMessageId: string;
  readonly startedAt: number;
  readonly sources: readonly ThreadExecutionSituationSourceMessage[];
}

export interface ThreadExecutionSituation {
  readonly kind: 'thread_execution_situation.v1';
  /** False means at least one runtime witness could not be joined to exact lifecycle evidence. */
  readonly complete: boolean;
  readonly activeRuns: readonly ThreadExecutionSituationRun[];
}

export interface ThreadExecutionSituationSource {
  resolve(threadId: string): Promise<ThreadExecutionSituation>;
}

export function createThreadExecutionSituationSource(input: {
  readonly messageStore: Pick<IMessageStore, 'getById'>;
  readonly listActiveRuns: (threadId: string) => readonly LifecycleActiveRun[];
}): ThreadExecutionSituationSource {
  return {
    async resolve(threadId) {
      let activeRuns: readonly LifecycleActiveRun[];
      try {
        activeRuns = input.listActiveRuns(threadId).filter((run) => run.threadId === threadId);
      } catch {
        return { kind: 'thread_execution_situation.v1', complete: false, activeRuns: [] };
      }

      let complete = true;
      const projected: ThreadExecutionSituationRun[] = [];
      for (const run of activeRuns) {
        // Private-only work has no public History anchor and therefore no A79
        // situation claim. It remains an internal execution, just as the UI
        // intentionally renders no delivery avatar for it.
        if (run.inputMessageIds.length === 0) continue;
        try {
          const response = await input.messageStore.getById(run.responseMessageId);
          const sourceMessages = await Promise.all(
            run.inputMessageIds.map((messageId) => input.messageStore.getById(messageId)),
          );
          const sources = sourceMessages.flatMap((source) => {
            if (
              !source ||
              source.threadId !== threadId ||
              !hasExactLifecycleProcessingDispatch({
                sourceMessageId: source.id,
                sourceDispatchRefs: source.lifecycle?.dispatchRefs ?? [],
                responseMessageId: run.responseMessageId,
                responseLifecycle: response?.lifecycle,
                activeRuns,
              })
            ) {
              return [];
            }
            return [{ messageId: source.id, from: messageFrom(source) }];
          });
          if (!response || response.threadId !== threadId || sources.length !== run.inputMessageIds.length) {
            complete = false;
            continue;
          }
          projected.push({
            phase: 'processing',
            targetId: run.targetId,
            invocationId: run.invocationId,
            responseMessageId: run.responseMessageId,
            startedAt: run.startedAt,
            sources,
          });
        } catch {
          complete = false;
        }
      }
      projected.sort((left, right) => left.startedAt - right.startedAt || left.targetId.localeCompare(right.targetId));
      return { kind: 'thread_execution_situation.v1', complete, activeRuns: projected };
    },
  };
}
