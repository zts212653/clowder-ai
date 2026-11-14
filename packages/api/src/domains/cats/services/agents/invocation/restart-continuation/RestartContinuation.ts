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
 *
 * F337 reuses the same delivery for a turn a machine sleep cut off (`host_sleep`), sent once the
 * lid is open again. Both kinds share one connector so the loop guard covers them together.
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

export const SLEEP_CONTINUATION_CONTENT =
  '刚才电脑睡着了（合盖或者自动睡眠），你上一轮还没做完就被打断了。看一下这个线程的聊天记录和你的记忆，' +
  '接着把没做完的事做完；如果已经做完或者不用再做了，简单说一声就好。';

/** Why the turn was cut off; each kind has its own wording and delivery key. */
export type ContinuationKind = 'process_restart' | 'host_sleep';

const CONTINUATION_KINDS: Record<
  ContinuationKind,
  { readonly content: string; readonly keyPrefix: string; readonly label: string; readonly icon: string }
> = {
  process_restart: {
    content: RESTART_CONTINUATION_CONTENT,
    keyPrefix: 'restart-continuation',
    label: '重启接续',
    icon: '🔁',
  },
  host_sleep: { content: SLEEP_CONTINUATION_CONTENT, keyPrefix: 'sleep-continuation', label: '睡眠接续', icon: '💤' },
};

export interface RestartContinuationDeps {
  /** `hasMemberTurnStartedAfter` is exact: a later turn of this member here supersedes the wake. */
  readonly turns: Pick<ITurnExecutionStore, 'get' | 'hasMemberTurnStartedAfter'>;
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
   * keeps taking the runtime down must not be woken into the same crash again. `superseded`: the cat
   * already has a newer turn in that thread — it ran again, finished, or was stopped by a person, and
   * that newer fact wins over this older automatic wake.
   */
  readonly skipped: Array<ContinuationRef & { readonly reason: 'queued_work' | 'interrupted_again' | 'superseded' }>;
  readonly failed: Array<ContinuationRef & { readonly error: string }>;
  /** Folded into a newer cut-off turn of the same member in the same thread, in this same call. */
  readonly coalesced: string[];
  /** No such record: there is nothing left to continue. */
  readonly missing: string[];
  /** The record could not be read; nothing was decided for it, so a caller may retry. */
  readonly unreadable: Array<{ readonly interruptedInvocationId: string; readonly error: string }>;
}

/** Ids this call reached a definite outcome for; anything else (failed, unreadable) is still open. */
export function concludedContinuationIds(result: RestartContinuationResult): Set<string> {
  return new Set([
    ...result.delivered.map((entry) => entry.interruptedInvocationId),
    ...result.skipped.map((entry) => entry.interruptedInvocationId),
    ...result.coalesced,
    ...result.missing,
  ]);
}

export async function continueRestartInterruptedCats(
  deps: RestartContinuationDeps,
  interruptedInvocationIds: readonly string[],
): Promise<RestartContinuationResult> {
  return continueInterruptedCats(deps, interruptedInvocationIds, 'process_restart');
}

export async function continueInterruptedCats(
  deps: RestartContinuationDeps,
  interruptedInvocationIds: readonly string[],
  kind: ContinuationKind,
): Promise<RestartContinuationResult> {
  const wording = CONTINUATION_KINDS[kind];
  const read = await latestTurnPerCat(deps, interruptedInvocationIds);
  const result: RestartContinuationResult = {
    delivered: [],
    skipped: [],
    failed: [],
    coalesced: read.coalesced,
    missing: read.missing,
    unreadable: read.unreadable,
  };
  for (const turn of read.latest) {
    const ref = { threadId: turn.threadId, catId: turn.catId, interruptedInvocationId: turn.invocationId };
    try {
      if (await triggeredByContinuation(deps.messages, turn)) {
        result.skipped.push({ ...ref, reason: 'interrupted_again' });
        continue;
      }
      if (await hasNewerTurn(deps.turns, turn)) {
        result.skipped.push({ ...ref, reason: 'superseded' });
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
        content: wording.content,
        idempotencyKey: `${wording.keyPrefix}:${turn.invocationId}`,
        ownerAuthProvenance: 'unknown',
        source: {
          connector: RESTART_CONTINUATION_CONNECTOR,
          label: wording.label,
          icon: wording.icon,
          meta: { interruptedInvocationId: turn.invocationId },
        },
      });
      result.delivered.push({ ...ref, messageId });
    } catch (error) {
      result.failed.push({ ...ref, error: String(error) });
      deps.log.warn({ ...ref, kind, error: String(error) }, '[F048-C] continuation was not delivered');
    }
  }
  return result;
}

/** One continuation per cat per thread: the cat reads the whole thread, not one cut-off turn. */
async function latestTurnPerCat(
  deps: Pick<RestartContinuationDeps, 'turns' | 'log'>,
  invocationIds: readonly string[],
): Promise<{
  latest: TurnExecutionRecord[];
  coalesced: string[];
  missing: string[];
  unreadable: Array<{ interruptedInvocationId: string; error: string }>;
}> {
  const latest = new Map<string, TurnExecutionRecord>();
  const coalesced: string[] = [];
  const missing: string[] = [];
  const unreadable: Array<{ interruptedInvocationId: string; error: string }> = [];
  for (const invocationId of invocationIds) {
    let turn: TurnExecutionRecord | null;
    try {
      turn = await deps.turns.get(invocationId);
    } catch (error) {
      // An unreadable record only costs this one wake now, and stays open for a caller that retries.
      unreadable.push({ interruptedInvocationId: invocationId, error: String(error) });
      deps.log.warn({ invocationId, error: String(error) }, '[F048-C] interrupted turn could not be read');
      continue;
    }
    if (!turn) {
      missing.push(invocationId);
      continue;
    }
    const key = JSON.stringify([turn.userId, turn.threadId, turn.catId]);
    const seen = latest.get(key);
    if (!seen) {
      latest.set(key, turn);
    } else if (turn.startedAt > seen.startedAt) {
      coalesced.push(seen.invocationId);
      latest.set(key, turn);
    } else {
      coalesced.push(turn.invocationId);
    }
  }
  return { latest: [...latest.values()], coalesced, missing, unreadable };
}

/** True when this message is a restart or sleep continuation (they share one connector). */
export function isContinuationMessage(
  message: { readonly source?: { readonly connector?: string } } | null | undefined,
) {
  return message?.source?.connector === RESTART_CONTINUATION_CONNECTOR;
}

async function triggeredByContinuation(
  messages: RestartContinuationDeps['messages'],
  turn: TurnExecutionRecord,
): Promise<boolean> {
  const triggerMessageId = turn.causal?.triggerMessageId;
  if (!triggerMessageId) return false;
  return isContinuationMessage(await messages.getById(triggerMessageId));
}

/** Read failures propagate: the caller records the delivery as failed and may retry, never guesses. */
async function hasNewerTurn(turns: RestartContinuationDeps['turns'], turn: TurnExecutionRecord): Promise<boolean> {
  return turns.hasMemberTurnStartedAfter({
    userId: turn.userId,
    threadId: turn.threadId,
    catId: turn.catId,
    startedAfter: turn.startedAt,
  });
}

function hasPendingWork(queue: RestartContinuationDeps['queue'], threadId: string, catId: string): boolean {
  return (
    queue.listPendingAcrossUsers(threadId).some((entry) => entry.targets.includes(catId)) ||
    queue.findProcessingByCat(threadId, catId) !== null
  );
}
