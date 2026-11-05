import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { eventChannelId } from './channel-navigation.js';
import type { CollectiveEventEnvelope } from './client-types.js';
import { useMessageExpression } from './message-expression-context.js';

/** Receipt/polling is never a read. Only a visible message in this person's active channel advances the cursor. */
export function useChannelReadPosition(
  flowRef: RefObject<HTMLDivElement>,
  channelId: string,
  events: readonly CollectiveEventEnvelope[],
  enabled: boolean,
  focusedEventId?: string,
  surface?: { rootRef: RefObject<HTMLDivElement>; key?: string },
) {
  const port = useMessageExpression();
  const [read, setRead] = useState<{ sequence: number; eventId?: string }>();
  const [notice, setNotice] = useState<string>();
  const [armed, setArmed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const restored = useRef(false);
  const requested = useRef(0);
  const readRoot = surface?.rootRef ?? flowRef;
  const surfaceKey = surface?.key;
  const channelEvents = useMemo(
    () => events.filter((event) => eventChannelId(event) === channelId),
    [events, channelId],
  );
  const jump = useCallback(
    (event: CollectiveEventEnvelope | undefined) => {
      if (!event) return;
      const sourceId = event.location?.rootEventId ?? event.replyToEventId ?? event.eventId;
      const source = flowRef.current?.querySelector<HTMLElement>(`[data-event-id="${sourceId}"]`);
      source?.scrollIntoView({ block: 'start' });
    },
    [flowRef],
  );
  useEffect(() => {
    if (!port || !enabled) return;
    let active = true;
    restored.current = false;
    requested.current = 0;
    setArmed(false);
    setRead(undefined);
    void port
      .channelState(channelId)
      .then((value) => {
        if (!active) return;
        requested.current = value.read.sequence;
        setRead(value.read);
        setNotice(undefined);
      })
      .catch((error) => {
        if (active) setNotice(error instanceof Error ? error.message : String(error));
      });
    return () => {
      active = false;
    };
  }, [port, channelId, enabled, attempt]);
  useEffect(() => {
    if (!read || !enabled || restored.current || !flowRef.current || !channelEvents.length) return;
    if (!focusedEventId)
      jump(
        channelEvents.find((event) => event.sequence > read.sequence) ??
          channelEvents.find((event) => event.eventId === read.eventId),
      );
    restored.current = true;
    setArmed(true);
  }, [read, channelEvents, enabled, focusedEventId, flowRef, jump]);
  useEffect(() => {
    const flow = readRoot.current;
    if (!port || !flow || !enabled || !armed || !restored.current) return;
    const visible = new Map<Element, string>();
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const advance = () => {
      if (document.visibilityState !== 'visible') return;
      const seen = new Set(visible.values());
      const last = channelEvents
        .filter((event) => seen.has(event.eventId) && event.sequence > requested.current)
        .at(-1);
      if (!last) return;
      const previous = requested.current;
      requested.current = last.sequence;
      void port
        .markRead(channelId, last.eventId)
        .then((value) => {
          if (active) setRead((current) => (!current || value.sequence > current.sequence ? value : current));
        })
        .catch((error) => {
          if (!active) return;
          if (requested.current === last.sequence) requested.current = previous;
          setNotice(error instanceof Error ? error.message : String(error));
        });
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.eventReadEnd;
          if (!id) continue;
          if (entry.isIntersecting && entry.intersectionRatio >= 1) visible.set(entry.target, id);
          else visible.delete(entry.target);
        }
        if (timer) clearTimeout(timer);
        timer = setTimeout(advance, 400);
      },
      { root: flow, threshold: [0, 1] },
    );
    for (const node of flow.querySelectorAll('[data-event-read-end]')) observer.observe(node);
    document.addEventListener('visibilitychange', advance);
    return () => {
      active = false;
      observer.disconnect();
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', advance);
    };
  }, [port, channelId, channelEvents, enabled, armed, readRoot, surfaceKey]);
  const unread = read ? channelEvents.filter((event) => event.sequence > read.sequence) : [];
  return {
    read,
    unreadCount: unread.length,
    notice,
    jumpToUnread: () => jump(unread[0]),
    retry: () => setAttempt((value) => value + 1),
  };
}
