import { type MessageSearchResponse, type MessageSearchResult, messageSearchResponseSchema } from '@cat-cafe/shared';
import { useEffect, useRef } from 'react';
import { MESSAGE_FIND_OPEN_EVENT, MESSAGE_FIND_RETURN_EVENT } from './message-find-events';
import { type MessageReadingSession, readActiveMessageReadingSession } from './message-reading-session';
import { type MessageReadingEffect, requestMessageReadingReturn } from './message-reading-trip';

interface FindEntry {
  threadId: string;
  available: boolean;
  readSession: () => MessageReadingSession | null;
  hasPending: () => boolean;
  navigateResult: (result: MessageSearchResult, response: MessageSearchResponse) => void;
  returnToOrigin: () => void;
  restore: (session: MessageReadingSession, effect: MessageReadingEffect) => void;
  show: (response: MessageSearchResponse) => void;
}

/** UI entry adapters only. The original host still owns navigation and settled receipts. */
export function useMessageFindEntry(options: FindEntry): void {
  const latest = useRef(options);
  latest.current = options;
  useEffect(() => {
    const show = (event: Event) => {
      const entry = latest.current;
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (!entry.available || !detail || typeof detail !== 'object') return;
      const input = detail as Record<string, unknown>;
      if (input.threadId !== entry.threadId) return;
      const parsed = messageSearchResponseSchema.safeParse(input.response);
      if (!parsed.success || JSON.stringify(parsed.data).length > 24000) return;
      if (input.target !== undefined) {
        if (!input.target || typeof input.target !== 'object') return;
        const coordinate = input.target as Record<string, unknown>;
        const target = parsed.data.results.find(
          (row) =>
            row.threadId === coordinate.threadId &&
            row.messageId === coordinate.messageId &&
            row.contentRevision === coordinate.contentRevision,
        );
        if (!target) return;
        event.preventDefault();
        entry.navigateResult(target, parsed.data);
      } else {
        event.preventDefault();
        entry.show(parsed.data);
      }
    };
    const back = (event: Event) => {
      const id: unknown = (event as CustomEvent<unknown>).detail;
      const session = latest.current.readSession();
      if (typeof id === 'string' && session?.find && session.id === id && readActiveMessageReadingSession()?.id === id)
        latest.current.returnToOrigin();
    };
    window.addEventListener(MESSAGE_FIND_OPEN_EVENT, show);
    window.addEventListener(MESSAGE_FIND_RETURN_EVENT, back);
    return () => {
      window.removeEventListener(MESSAGE_FIND_OPEN_EVENT, show);
      window.removeEventListener(MESSAGE_FIND_RETURN_EVENT, back);
    };
  }, []);
  useEffect(() => {
    const entry = latest.current;
    if (!entry.available || entry.hasPending()) return;
    const recovered = entry.readSession();
    if (
      !recovered?.find ||
      recovered.trip.origin.threadId !== entry.threadId ||
      readActiveMessageReadingSession()?.id !== recovered.id ||
      new URL(window.location.href).searchParams.get('findReturn') !== recovered.id
    )
      return;
    const returning = requestMessageReadingReturn(recovered.trip);
    if (returning) entry.restore({ ...recovered, trip: returning.trip }, returning.effect);
  }, [options.threadId, options.available]);
}
