'use client';

import { useMemo, useState } from 'react';
import type { ChatMessage } from '@/stores/chat-types';
import { includeNewTimelineMessages } from '@/stores/display-timeline';
import { getOrderedMessageTimeline } from '@/stores/message-timeline';

/** Existing cards keep their place; only new/removed IDs change the viewport order. */
export function useViewportMessageTimeline(threadId: string, messages: readonly ChatMessage[]): ChatMessage[] {
  const [order, setOrder] = useState(() => ({
    threadId,
    ids: getOrderedMessageTimeline(messages).map((message) => message.id),
  }));
  const ids = useMemo(
    () =>
      order.threadId === threadId
        ? includeNewTimelineMessages(order.ids, messages)
        : getOrderedMessageTimeline(messages).map((message) => message.id),
    [messages, order, threadId],
  );
  if (
    order.threadId !== threadId ||
    ids.length !== order.ids.length ||
    ids.some((id, index) => id !== order.ids[index])
  ) {
    setOrder({ threadId, ids });
  }
  return useMemo(() => {
    const byId = new Map(messages.map((message) => [message.id, message]));
    return ids.map((id) => byId.get(id)).filter((message): message is ChatMessage => message !== undefined);
  }, [ids, messages]);
}
