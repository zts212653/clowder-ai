'use client';

import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { selectThreadLiveness } from '@/hooks/useThreadScopedSelectors';
import type { AppServerLifecycleSnapshot, CatStatusType } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import { getSilentActiveTurnDeadline, isStreamingTipSuppressed } from '../capability-tip-placement';

/**
 * F322 B — §1.16 合同二/合同三: "did THIS reply's turn go quiet?" — the same judgement and the same sentence as the line above
 * the input (`isStreamingTipSuppressed`), but only for the turn this reply belongs to.
 *
 * A cat has one liveness record (its latest run). A reply may use it only when that run is the reply's own turn: the reply's
 * `turnInvocationId`. A legacy reply without one is ambiguous inside an A2A chain and therefore cannot consume cat-level silence.
 * When the cat is already on its next run, or the ids do not match, there is no quiet fact.
 */
export type ReplyQuietFact = { since: number | null } | null;

/** Pure: the quiet fact for a live reply, given what the store holds for its cat. */
export function replyQuietFact(
  status: CatStatusType | undefined,
  lifecycle: AppServerLifecycleSnapshot | undefined,
  now: number,
): ReplyQuietFact {
  if (!isStreamingTipSuppressed(status, lifecycle, now)) return null;
  const known = lifecycle && (lifecycle.stage === 'turn_accepted' || lifecycle.stage === 'active');
  return { since: known ? lifecycle.lastActivityAt : null };
}

const MINUTE_MS = 60_000;

export function useReplyQuiet(params: {
  threadId: string | null;
  catId: string | undefined;
  streamTurnId: string | undefined;
  /** Only a reply that is running can have gone quiet; everything else skips the store read and the clock. */
  active: boolean;
}): ReplyQuietFact {
  const { threadId, catId, streamTurnId, active } = params;
  const own = useChatStore(
    useShallow((state) => {
      if (!active || !catId) return { status: undefined, lifecycle: undefined };
      const liveness = selectThreadLiveness(state, threadId);
      const invocation = liveness.catInvocations[catId];
      const sameRun = Boolean(streamTurnId) && invocation?.turnInvocationId === streamTurnId;
      return sameRun
        ? { status: liveness.catStatuses[catId], lifecycle: invocation?.appServerLifecycle }
        : { status: undefined, lifecycle: undefined };
    }),
  );

  // A re-render trigger only: the fact itself is always read against the clock of the render.
  const [, wake] = useState(0);
  const quietNow = replyQuietFact(own.status, own.lifecycle, Date.now());
  const isQuiet = quietNow !== null;
  // The app-server silence is a deadline, not an event: wake exactly then. Once quiet, tick each minute so "N 分钟" stays true.
  useEffect(() => {
    if (!active) return;
    const tick = () => wake((epoch) => epoch + 1);
    if (isQuiet) {
      const interval = setInterval(tick, MINUTE_MS);
      return () => clearInterval(interval);
    }
    const deadline = getSilentActiveTurnDeadline(own.lifecycle);
    if (deadline === null || deadline <= Date.now()) return;
    const timer = setTimeout(tick, deadline - Date.now() + 1);
    return () => clearTimeout(timer);
  }, [active, own.lifecycle, isQuiet]);

  return active ? quietNow : null;
}
