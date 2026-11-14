'use client';

import { useMemo, useState } from 'react';
import type { ChatMessage } from '@/stores/chat-types';
import { includeNewTimelineMessages } from '@/stores/display-timeline';
import { getOrderedMessageTimeline } from '@/stores/message-timeline';
import { sendAttemptViewKey } from '@/stores/send-attempt-projection';

/** Existing cards keep their place; only new/removed IDs change the viewport order. */
export function useViewportMessageTimeline(threadId: string, messages: readonly ChatMessage[]): ChatMessage[] {
  const points = useMemo(
    () =>
      messages.map((message) => (message.clientMessageId ? { ...message, id: sendAttemptViewKey(message) } : message)),
    [messages],
  );
  const [order, setOrder] = useState(() => ({
    threadId,
    ids: getOrderedMessageTimeline(points).map((message) => message.id),
  }));
  const ids = useMemo(
    () =>
      order.threadId === threadId
        ? includeNewTimelineMessages(order.ids, points)
        : getOrderedMessageTimeline(points).map((message) => message.id),
    [points, order, threadId],
  );
  if (
    order.threadId !== threadId ||
    ids.length !== order.ids.length ||
    ids.some((id, index) => id !== order.ids[index])
  ) {
    setOrder({ threadId, ids });
  }
  return useMemo(() => {
    const byId = new Map(messages.map((message) => [sendAttemptViewKey(message), message]));
    return ids.map((id) => byId.get(id)).filter((message): message is ChatMessage => message !== undefined);
  }, [ids, messages]);
}
