'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessage } from '@/stores/chat-types';
import { commitTimelineOrderRound, includeNewTimelineMessages } from '@/stores/display-timeline';
import { getOrderedMessageTimeline } from '@/stores/message-timeline';

// Content is never delayed. Only the position of existing cards is batched.
export const TIMELINE_ORDER_ROUND_INTERVAL_MS = 1_000;

interface DisplayOrder {
  threadId: string;
  committedMessages: readonly ChatMessage[];
  orderedIds: readonly string[];
  committedAt: number;
}

function initialOrder(threadId: string, messages: readonly ChatMessage[]): DisplayOrder {
  return {
    threadId,
    committedMessages: messages,
    orderedIds: getOrderedMessageTimeline(messages).map((message) => message.id),
    committedAt: Date.now(),
  };
}

/** One viewport-local ordering loop. Store writers never need to mark dirty rows. */
export function useViewportMessageTimeline(
  threadId: string,
  messages: readonly ChatMessage[],
  beforeRound?: () => void,
): ChatMessage[] {
  const [order, setOrder] = useState(() => initialOrder(threadId, messages));
  const latestMessagesRef = useRef(messages);
  latestMessagesRef.current = messages;
  const beforeRoundRef = useRef(beforeRound);
  beforeRoundRef.current = beforeRound;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef(false);
  const threadRef = useRef(threadId);

  // A route can reuse this component. Never show the previous thread's rows.
  const changedThread = order.threadId !== threadId;
  if (changedThread) {
    threadRef.current = threadId;
    setOrder(initialOrder(threadId, messages));
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: only a committed order releases the next serial round.
  useLayoutEffect(() => {
    inFlightRef.current = false;
  }, [order]);

  useEffect(() => {
    if (changedThread || order.committedMessages === messages || timerRef.current || inFlightRef.current) return;
    const wait = Math.max(0, order.committedAt + TIMELINE_ORDER_ROUND_INTERVAL_MS - Date.now());
    const scheduledThread = threadId;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (threadRef.current !== scheduledThread || inFlightRef.current) return;
      const snapshot = latestMessagesRef.current;
      inFlightRef.current = true;
      beforeRoundRef.current?.();
      setOrder((previous) => ({
        threadId: scheduledThread,
        committedMessages: snapshot,
        orderedIds: commitTimelineOrderRound(previous.committedMessages, previous.orderedIds, snapshot),
        committedAt: Date.now(),
      }));
    }, wait);
  }, [changedThread, messages, order, threadId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a route change must cancel the old thread's pending timer.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    };
  }, [threadId]);

  return useMemo(() => {
    if (changedThread) return getOrderedMessageTimeline(messages);
    const byId = new Map(messages.map((message) => [message.id, message]));
    return includeNewTimelineMessages(order.orderedIds, messages)
      .map((id) => byId.get(id))
      .filter((message): message is ChatMessage => message !== undefined);
  }, [changedThread, messages, order]);
}
