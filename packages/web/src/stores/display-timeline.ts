import type { ChatMessage } from './chat-types';
import { compareMessageTimelineOrder } from './message-timeline';

/**
 * New IDs appear immediately using the shared start-time comparator; existing
 * cards retain their relative order while their content and receipts update.
 */
export function includeNewTimelineMessages(orderedIds: readonly string[], messages: readonly ChatMessage[]): string[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const result = orderedIds.filter((id) => byId.has(id));
  const present = new Set(result);

  for (const message of messages) {
    if (present.has(message.id)) continue;
    present.add(message.id);
    const insertAt = result.findIndex((id) => {
      const other = byId.get(id);
      return other !== undefined && compareMessageTimelineOrder(message, other) < 0;
    });
    result.splice(insertAt < 0 ? result.length : insertAt, 0, message.id);
  }
  return result;
}
