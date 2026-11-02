import type { MessageSearchResponse, MessageSearchResult } from '@cat-cafe/shared';
import { readActiveMessageReadingSession } from './message-reading-session';

export const MESSAGE_FIND_RETURN_EVENT = 'cat-cafe:message-find-return';
export const MESSAGE_FIND_OPEN_EVENT = 'cat-cafe:message-find-open';

/** Consume only a terminal attempt, so StrictMode/unmount cannot lose an unfulfilled intent. */
export function consumeMessageFindReturn(sessionId: string): void {
  const url = new URL(window.location.href);
  if (url.searchParams.get('findReturn') !== sessionId) return;
  url.searchParams.delete('findReturn');
  window.history.replaceState(window.history.state, '', url);
}

export function requestMessageFindOpen(
  threadId: string,
  response: MessageSearchResponse,
  target?: MessageSearchResult,
): boolean {
  const event = new CustomEvent(MESSAGE_FIND_OPEN_EVENT, { cancelable: true, detail: { threadId, response, target } });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

export function requestMessageFindReturn(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(MESSAGE_FIND_RETURN_EVENT, { detail: sessionId }));
}

export function messageFindReturnHref(sessionId: string | null | undefined, threadId?: string | null): string | null {
  const session = readActiveMessageReadingSession();
  if (!sessionId || !session?.find || session.id !== sessionId || session.trip.status === 'completed') return null;
  if (threadId && session.trip.origin.threadId !== threadId) return null;
  return `/thread/${encodeURIComponent(session.trip.origin.threadId)}?findReturn=${encodeURIComponent(session.id)}`;
}
