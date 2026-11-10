/**
 * F048 Phase C: wake the cats a restart cut off.
 *
 * Startup recovery already marks every execution the previous process left running as
 * `process_restart`, whether the restart was planned or a crash. This step sends each interrupted
 * cat one ordinary input in its own thread, the way You used to ask one cat to tell everyone
 * "家里刚炸了，可以继续了". The cat picks up from History and its memory.
 *
 * It only adds an input. It never gates admission or the Queue, and it does not revive the retired
 * callback authority of the interrupted turn: the continuation runs as `unknown`, like a scheduled
 * reminder. A delivery that fails is logged and never blocks startup or the other cats.
 */

import type { CatId, TurnExecutionRecord } from '@cat-cafe/shared';
import type { DeliverOpts } from '../../../../../../infrastructure/scheduler/types.js';
import type { IMessageStore } from '../../../stores/ports/MessageStore.js';
import type { ITurnExecutionStore } from '../../../stores/ports/TurnExecutionStore.js';
import type { QueueEntry } from '../InvocationQueue.js';

export const RESTART_CONTINUATION_CONNECTOR = 'restart-recovery';

export const RESTART_CONTINUATION_CONTENT =
  '刚才 runtime 重启了（也可能是崩了），你上一轮还没做完就被打断了。看一下这个线程的聊天记录和你的记忆，' +
  '接着把没做完的事做完；如果已经做完或者不用再做了，简单说一声就好。';

export interface RestartContinuationDeps {
  readonly turns: Pick<ITurnExecutionStore, 'get'>;
  readonly messages: Pick<IMessageStore, 'getById'>;
  readonly queue: {
    listPendingAcrossUsers(threadId: string): QueueEntry[];
    findProcessingByCat(threadId: string, catId: string): QueueEntry | null;
  };
  /** The scheduler's system delivery: one atomic Message + Queue admission that wakes the target. */
  readonly deliver: (opts: DeliverOpts) => Promise<string>;
  readonly log: { warn(obj: object, msg: string): void };
}

interface ContinuationRef {
  readonly threadId: string;
  readonly catId: CatId;
  readonly interruptedInvocationId: string;
}

export interface RestartContinuationResult {
  readonly delivered: Array<ContinuationRef & { readonly messageId: string }>;
  /**
   * `queued_work`: the Queue already holds input for this cat, so it will run and see its cut-off
   * reply anyway. `interrupted_again`: the cut-off turn was itself a continuation; a cat whose work
   * keeps taking the runtime down must not be woken into the same crash again.
   */
  readonly skipped: Array<ContinuationRef & { readonly reason: 'queued_work' | 'interrupted_again' }>;
  readonly failed: Array<ContinuationRef & { readonly error: string }>;
}

export async function continueRestartInterruptedCats(
  deps: RestartContinuationDeps,
  interruptedInvocationIds: readonly string[],
): Promise<RestartContinuationResult> {
  const result: RestartContinuationResult = { delivered: [], skipped: [], failed: [] };
  for (const turn of await latestTurnPerCat(deps, interruptedInvocationIds)) {
    const ref = { threadId: turn.threadId, catId: turn.catId, interruptedInvocationId: turn.invocationId };
    try {
      if (await triggeredByContinuation(deps.messages, turn)) {
        result.skipped.push({ ...ref, reason: 'interrupted_again' });
        continue;
      }
      if (hasPendingWork(deps.queue, turn.threadId, turn.catId)) {
        result.skipped.push({ ...ref, reason: 'queued_work' });
        continue;
      }
      const messageId = await deps.deliver({
        userId: turn.userId,
        threadId: turn.threadId,
        targetCatId: turn.catId,
        content: RESTART_CONTINUATION_CONTENT,
        idempotencyKey: `restart-continuation:${turn.invocationId}`,
        ownerAuthProvenance: 'unknown',
        source: {
          connector: RESTART_CONTINUATION_CONNECTOR,
          label: '重启接续',
          icon: '🔁',
          meta: { interruptedInvocationId: turn.invocationId },
        },
      });
      result.delivered.push({ ...ref, messageId });
    } catch (error) {
      result.failed.push({ ...ref, error: String(error) });
      deps.log.warn({ ...ref, error: String(error) }, '[F048-C] restart continuation was not delivered');
    }
  }
  return result;
}

/** One continuation per cat per thread: the cat reads the whole thread, not one cut-off turn. */
async function latestTurnPerCat(
  deps: Pick<RestartContinuationDeps, 'turns' | 'log'>,
  invocationIds: readonly string[],
): Promise<TurnExecutionRecord[]> {
  const latest = new Map<string, TurnExecutionRecord>();
  for (const invocationId of invocationIds) {
    let turn: TurnExecutionRecord | null;
    try {
      turn = await deps.turns.get(invocationId);
    } catch (error) {
      // Startup already finished its recovery; an unreadable record only costs this one wake.
      deps.log.warn({ invocationId, error: String(error) }, '[F048-C] interrupted turn could not be read');
      continue;
    }
    if (!turn) continue;
    const key = JSON.stringify([turn.userId, turn.threadId, turn.catId]);
    const seen = latest.get(key);
    if (!seen || turn.startedAt > seen.startedAt) latest.set(key, turn);
  }
  return [...latest.values()];
}

async function triggeredByContinuation(
  messages: RestartContinuationDeps['messages'],
  turn: TurnExecutionRecord,
): Promise<boolean> {
  const triggerMessageId = turn.causal?.triggerMessageId;
  if (!triggerMessageId) return false;
  const trigger = await messages.getById(triggerMessageId);
  return trigger?.source?.connector === RESTART_CONTINUATION_CONNECTOR;
}

function hasPendingWork(queue: RestartContinuationDeps['queue'], threadId: string, catId: string): boolean {
  return (
    queue.listPendingAcrossUsers(threadId).some((entry) => entry.targets.includes(catId)) ||
    queue.findProcessingByCat(threadId, catId) !== null
  );
}
