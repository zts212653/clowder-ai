import { messageFrom } from './message-from.js';
import type { StoredMessage } from './ports/MessageStore.js';

export type TimelineOrderMessage = Pick<
  StoredMessage,
  | 'from'
  | 'userId'
  | 'catId'
  | 'timestamp'
  | 'deliveredAt'
  | 'timelineOrderAt'
  | 'deliveryStatus'
  | 'origin'
  | 'source'
  | 'sourceParseFailure'
  | 'lifecycle'
  | 'recall'
  | '_tombstone'
>;

export function isDeliveredMessage(message: TimelineOrderMessage): boolean {
  return (
    !message.deliveryStatus ||
    message.deliveryStatus === 'delivered' ||
    (message.deliveryStatus === 'canceled' && message.lifecycle?.kind === 'response')
  );
}

export function isRealCatSpeech(message: TimelineOrderMessage): boolean {
  return messageFrom(message).kind === 'agent' && message.origin !== 'briefing';
}

export function isQueuedCatTimelineMessage(message: TimelineOrderMessage): boolean {
  return message.deliveryStatus === 'queued' && isRealCatSpeech(message);
}

/** Explicit administrative reads may inspect queued owner work. This predicate
 * never publishes the row into the ordinary History timeline. */
export function isQueuedOwnerWork(message: TimelineOrderMessage): boolean {
  const from = messageFrom(message);
  return (
    message.deliveryStatus === 'queued' &&
    message.origin !== 'briefing' &&
    (from.kind === 'user' || from.kind === 'external' || from.kind === 'plugin')
  );
}

export function isOwnerVisibleRecalledUserMessage(message: TimelineOrderMessage): boolean {
  return (
    message.deliveryStatus === 'canceled' &&
    messageFrom(message).kind === 'user' &&
    message._tombstone === true &&
    message.recall?.exposure === 'seen'
  );
}
