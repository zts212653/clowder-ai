export interface MessageTimelinePoint {
  id?: string;
  type?: string;
  catId?: string | null;
  origin?: string;
  isStreaming?: boolean;
  timestamp: number;
  deliveredAt?: number;
  timelineOrderAt?: number;
  lifecycle?: {
    kind?: string;
    status?: string;
    completedAt?: number;
    latestInputTimelineOrderAt?: number;
  };
}

/** A terminal response is authoritative even if a stale stream flag survives. */
export function isMessageTimelineActive(message: MessageTimelinePoint): boolean {
  if (message.lifecycle?.kind === 'response') return message.lifecycle.status === 'processing';
  return message.isStreaming === true;
}

/** Presentation clock: activity/completion time, bounded after every admitted input for response causality. */
export function getMessageTimelineOrderTime(message: MessageTimelinePoint): number {
  const liveOrDeliveryTime = message.timelineOrderAt ?? message.deliveredAt ?? message.timestamp;
  const presentationTime = isMessageTimelineActive(message)
    ? liveOrDeliveryTime
    : (message.lifecycle?.completedAt ?? liveOrDeliveryTime);
  const latestInputTime =
    message.lifecycle?.kind === 'response' ? message.lifecycle.latestInputTimelineOrderAt : undefined;
  return latestInputTime === undefined ? presentationTime : Math.max(presentationTime, latestInputTime + 1);
}

/** Storage cursor clock: keep browser pagination on the API/Redis timeline score. */
export function getMessageTimelineCursorTime(message: MessageTimelinePoint): number {
  return message.timelineOrderAt ?? message.deliveredAt ?? message.timestamp;
}

/** One deterministic ordering rule for every presentation-timeline view. */
export function compareMessageTimelineOrder(left: MessageTimelinePoint, right: MessageTimelinePoint): number {
  const delta = getMessageTimelineOrderTime(left) - getMessageTimelineOrderTime(right);
  if (delta !== 0) return delta;
  return (left.id ?? '').localeCompare(right.id ?? '');
}

/** Storage/page ordering stays independent from the presentation timeline. */
export function compareMessageTimelineCursor(left: MessageTimelinePoint, right: MessageTimelinePoint): number {
  const delta = getMessageTimelineCursorTime(left) - getMessageTimelineCursorTime(right);
  if (delta !== 0) return delta;
  return (left.id ?? '').localeCompare(right.id ?? '');
}

const orderedTimelineCache = new WeakMap<readonly MessageTimelinePoint[], readonly MessageTimelinePoint[]>();

export function isMessageTimelineOrdered(messages: readonly MessageTimelinePoint[]): boolean {
  for (let index = 1; index < messages.length; index++) {
    const previous = messages[index - 1];
    const current = messages[index];
    if (previous && current && compareMessageTimelineOrder(previous, current) > 0) return false;
  }
  return true;
}

/**
 * Derive the canonical presentation view without making every store writer
 * responsible for maintaining array order. The input reference is immutable
 * store state, so a WeakMap gives Zustand readers stable references until that
 * state actually changes.
 */
export function getOrderedMessageTimeline<T extends MessageTimelinePoint>(messages: readonly T[]): T[] {
  const cached = orderedTimelineCache.get(messages);
  if (cached) return cached as T[];

  const result = isMessageTimelineOrdered(messages)
    ? (messages as T[])
    : messages.toSorted(compareMessageTimelineOrder);
  orderedTimelineCache.set(messages, result);
  return result;
}

export function findLatestMessageByTimeline<T extends MessageTimelinePoint>(
  messages: readonly T[],
  predicate: (message: T) => boolean = () => true,
): T | undefined {
  let latest: T | undefined;
  for (const message of messages) {
    if (!predicate(message)) continue;
    if (!latest || compareMessageTimelineOrder(latest, message) < 0) latest = message;
  }
  return latest;
}

export function findLatestMessageIndexByTimeline<T extends MessageTimelinePoint>(
  messages: readonly T[],
  predicate: (message: T) => boolean,
): number {
  let latestIndex = -1;
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (!message) continue;
    if (!predicate(message)) continue;
    const latest = latestIndex >= 0 ? messages[latestIndex] : undefined;
    if (!latest || compareMessageTimelineOrder(latest, message) < 0) latestIndex = index;
  }
  return latestIndex;
}

export function findEarliestMessageByCursor<T extends MessageTimelinePoint>(messages: readonly T[]): T | undefined {
  let earliest: T | undefined;
  for (const message of messages) {
    if (!earliest || compareMessageTimelineCursor(message, earliest) < 0) earliest = message;
  }
  return earliest;
}
