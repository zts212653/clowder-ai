import {
  hasExactLifecycleProcessingDispatch,
  type LifecycleActiveRun,
  type MessageFrom,
  type TurnExecutionRecord,
} from '@cat-cafe/shared';
import { messageFrom } from '../../stores/message-from.js';
import type { IMessageStore } from '../../stores/ports/MessageStore.js';
import type { ITurnExecutionStore } from '../../stores/ports/TurnExecutionStore.js';

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

/** F337: how a member's latest turn in this thread ended, when it did not succeed. */
export interface ThreadRecentStop {
  readonly catId: string;
  readonly status: 'canceled' | 'interrupted' | 'failed';
  readonly terminalReason?: string;
  readonly endedAt: number;
}

export interface ThreadExecutionSituation {
  readonly kind: 'thread_execution_situation.v1';
  /** False means at least one runtime witness could not be joined to exact lifecycle evidence. */
  readonly complete: boolean;
  readonly activeRuns: readonly ThreadExecutionSituationRun[];
  /** F337: absent when not read (or unreadable); never inferred from chat. */
  readonly recentStops?: readonly ThreadRecentStop[];
  /** F337: false when the read was cut by its page size, so older stops in the window may be missing. */
  readonly recentStopsComplete?: boolean;
}

export interface ThreadRecentStopsRead {
  readonly stops: readonly ThreadRecentStop[];
  readonly complete: boolean;
}

export interface ThreadExecutionSituationSource {
  resolve(threadId: string, userId?: string): Promise<ThreadExecutionSituation>;
}

export const RECENT_STOP_WINDOW_MS = 30 * 60_000;

/**
 * Each member's latest settled turn in the thread, kept only when it stopped without succeeding inside
 * the window. Watchers keep their own lifecycle and are left out.
 */
export function selectRecentStops(records: readonly TurnExecutionRecord[], now: number): ThreadRecentStop[] {
  const latest = new Map<string, TurnExecutionRecord>();
  for (const record of records) {
    if (record.executionKind === 'watcher' || record.endedAt === undefined) continue;
    const seen = latest.get(record.catId);
    if (!seen || (seen.endedAt ?? 0) < record.endedAt) latest.set(record.catId, record);
  }
  return [...latest.values()]
    .filter(
      (record): record is TurnExecutionRecord & { status: ThreadRecentStop['status']; endedAt: number } =>
        (record.status === 'canceled' || record.status === 'interrupted' || record.status === 'failed') &&
        record.endedAt !== undefined &&
        now - record.endedAt <= RECENT_STOP_WINDOW_MS,
    )
    .sort((left, right) => right.endedAt - left.endedAt)
    .map((record) => ({
      catId: record.catId,
      status: record.status,
      ...(record.terminalReason ? { terminalReason: record.terminalReason } : {}),
      endedAt: record.endedAt,
    }));
}

export const RECENT_STOP_PAGE = 100;

/**
 * This thread's newest settled turns (one page). Settlement order is not end-time order — a reply
 * can settle late — so a full page never claims to cover the whole window.
 */
export async function readRecentStops(
  turns: Pick<ITurnExecutionStore, 'listRecentSettled'>,
  scope: { readonly threadId: string; readonly userId: string },
  now: number,
): Promise<ThreadRecentStopsRead> {
  const records = await turns.listRecentSettled({ ...scope, limit: RECENT_STOP_PAGE });
  return { stops: selectRecentStops(records, now), complete: records.length < RECENT_STOP_PAGE };
}

export function createThreadExecutionSituationSource(input: {
  readonly messageStore: Pick<IMessageStore, 'getById'>;
  readonly listActiveRuns: (threadId: string) => readonly LifecycleActiveRun[];
  /** F337: recent non-successful endings of this thread's turns, newest first. */
  readonly listRecentStops?: (scope: { threadId: string; userId: string }) => Promise<ThreadRecentStopsRead>;
}): ThreadExecutionSituationSource {
  /**
   * `runningCatIds` comes from every live run, including private-only input the public projection
   * leaves out: a member already working again is not described as stopped.
   */
  const withRecentStops = async (
    situation: ThreadExecutionSituation,
    runningCatIds: ReadonlySet<string>,
    threadId: string,
    userId: string | undefined,
  ): Promise<ThreadExecutionSituation> => {
    if (!userId || !input.listRecentStops) return situation;
    try {
      const read = await input.listRecentStops({ threadId, userId });
      return {
        ...situation,
        recentStops: read.stops.filter((stop) => !runningCatIds.has(stop.catId)),
        recentStopsComplete: read.complete,
      };
    } catch {
      return situation;
    }
  };
  return {
    async resolve(threadId, userId) {
      let activeRuns: readonly LifecycleActiveRun[];
      try {
        activeRuns = input.listActiveRuns(threadId).filter((run) => run.threadId === threadId);
      } catch {
        // Who is running is unknown, so nobody can be said to have stopped either.
        return { kind: 'thread_execution_situation.v1', complete: false, activeRuns: [] };
      }
      const situation = await projectActiveRuns(threadId, activeRuns);
      return withRecentStops(situation, new Set(activeRuns.map((run) => run.targetId)), threadId, userId);
    },
  };

  async function projectActiveRuns(
    threadId: string,
    activeRuns: readonly LifecycleActiveRun[],
  ): Promise<ThreadExecutionSituation> {
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
  }
}
