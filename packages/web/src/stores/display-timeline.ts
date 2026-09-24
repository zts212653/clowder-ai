import type { ChatMessage } from './chat-types';
import { compareMessageTimelineOrder, getOrderedMessageTimeline } from './message-timeline';

/**
 * A viewport may keep its last committed order while message contents continue
 * to update. New IDs appear immediately; existing IDs never move until a sort
 * round commits. The canonical comparator remains the only ordering rule.
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

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/**
 * Find changed records by immutable-object identity, not writer-maintained dirty
 * flags. Unchanged records retain their sorted relative order; changed records
 * alone are reinserted with the shared comparator. Array shifts remain O(n).
 */
export function commitTimelineOrderRound(
  previousMessages: readonly ChatMessage[],
  previousOrderedIds: readonly string[],
  messages: readonly ChatMessage[],
): string[] {
  const previousById = new Map(previousMessages.map((message) => [message.id, message]));
  const currentById = new Map(messages.map((message) => [message.id, message]));
  if (
    previousById.size !== previousMessages.length ||
    currentById.size !== messages.length ||
    previousOrderedIds.length !== previousById.size ||
    new Set(previousOrderedIds).size !== previousById.size ||
    previousOrderedIds.some((id) => !previousById.has(id))
  ) {
    return getOrderedMessageTimeline(messages).map((message) => message.id);
  }

  const changed = messages.filter((message) => {
    const previous = previousById.get(message.id);
    return !previous || (previous !== message && compareMessageTimelineOrder(previous, message) !== 0);
  });
  if (changed.length > messages.length / 2) {
    return getOrderedMessageTimeline(messages).map((message) => message.id);
  }

  const changedIds = new Set(changed.map((message) => message.id));
  const result = previousOrderedIds.filter((id) => currentById.has(id) && !changedIds.has(id));
  changed.sort(compareMessageTimelineOrder);
  for (const message of changed) {
    let low = 0;
    let high = result.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const otherId = result[middle];
      const other = otherId === undefined ? undefined : currentById.get(otherId);
      if (other && compareMessageTimelineOrder(other, message) <= 0) low = middle + 1;
      else high = middle;
    }
    result.splice(low, 0, message.id);
  }

  return sameIds(result, previousOrderedIds) ? (previousOrderedIds as string[]) : result;
}
