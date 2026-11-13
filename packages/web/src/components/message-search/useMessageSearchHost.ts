import type { MessageSearchResponse, MessageSearchResult } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { releaseChatReadingRef } from '@/utils/chat-scroll-memory';
import type { ChatReadingPort, RegisterChatReadingPort } from '../thread-chat/useThreadChatReadingPort';
import { consumeMessageFindReturn } from './message-find-events';
import type { MessageFindContext, MessageFindDestination, MessageFindState } from './message-find-state';
import {
  admitReadingEffect,
  createPendingOperation,
  type PendingReadingOperation,
  prepareNavigateResult,
  prepareOpenDestination,
  readThroughOwner,
  startJumpTargetFromForeground,
  targetThread,
  toInitialFindState,
} from './message-reading-owner';
import {
  type MessageReadingSession,
  readActiveMessageReadingSession,
  saveMessageReadingSession,
} from './message-reading-session';
import {
  dismissMessageReadingTrip,
  interruptMessageReadingTrip,
  type MessageReadingEffect,
  requestMessageReadingReturn,
  requestMessageReadingTarget,
  settleMessageReadingTrip,
} from './message-reading-trip';
import { useMessageFindEntry } from './useMessageFindEntry';

export interface MessageSearchHost {
  open: boolean;
  session: MessageReadingSession | null;
  persisted: boolean;
  notice: string | null;
  findState: MessageFindState | undefined;
  findSeed: number;
  openSearch: () => void;
  openDestination: (
    destination: MessageFindDestination,
    state: MessageFindState,
    workspaceOrigin?: MessageFindContext['workspaceOrigin'],
  ) => void;
  closeSearch: () => void;
  registerReadingPort: RegisterChatReadingPort;
  navigateResult: (result: MessageSearchResult, response: MessageSearchResponse) => void;
  jumpInThread: (messageId: string, options?: { refresh?: boolean }) => boolean;
  moveTo: (index: number) => void;
  returnToOrigin: () => void;
  /** End a return bar the reader no longer needs, without moving the reader. */
  dismissReturn: () => void;
}

/** A navigation consumer: route and reading owners retain all authorization, paging and geometry. */
export function useMessageSearchHost({
  threadId,
  pushThreadRoute,
  available = true,
  searchAvailable = available,
  onOpenDestination,
  beforeFindReturn,
}: {
  threadId: string;
  pushThreadRoute: (threadId: string) => void;
  available?: boolean;
  searchAvailable?: boolean;
  onOpenDestination?: (session: MessageReadingSession) => void;
  beforeFindReturn?: (session: MessageReadingSession) => void;
}): MessageSearchHost {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState<MessageReadingSession | null>(null);
  const [persisted, setPersisted] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [findState, setFindState] = useState<MessageFindState>();
  const [findSeed, setFindSeed] = useState(0);
  const destinationCallbacks = useRef({ onOpenDestination, beforeFindReturn });
  destinationCallbacks.current = { onOpenDestination, beforeFindReturn };
  const current = useRef<MessageReadingSession | null>(null);
  const foregroundThread = useRef(threadId);
  foregroundThread.current = threadId;
  const reader = useRef<ChatReadingPort | null>(null);
  const pending = useRef<PendingReadingOperation | null>(null);
  const entryFocus = useRef<HTMLElement | null>(null);
  const activeDurable = useRef(true);
  const availableNow = useRef(available);
  availableNow.current = available;
  const searchAvailableNow = useRef(searchAvailable);
  searchAvailableNow.current = searchAvailable;

  const publish = useCallback((next: MessageReadingSession) => {
    current.current = next;
    setSession(next);
    setPersisted(saveMessageReadingSession(next) && activeDurable.current && next.originPersisted);
  }, []);

  const drive = useCallback(
    async (operation: PendingReadingOperation, port: ChatReadingPort) => {
      if (
        pending.current !== operation ||
        !operation.admitted ||
        operation.running ||
        port.threadId !== targetThread(operation.effect)
      )
        return;
      operation.running = true;
      let status: 'settled' | 'unavailable' | 'interrupted';
      try {
        status = await readThroughOwner(port, operation.effect, operation.controller.signal, {
          refresh: operation.refresh,
        });
      } catch {
        status = 'unavailable';
      }
      if (pending.current !== operation || current.current?.id !== operation.sessionId) return;
      if (reader.current?.ownerId !== port.ownerId || reader.current?.threadId !== port.threadId)
        status = 'interrupted';
      pending.current = null;
      const next = {
        ...current.current,
        trip: settleMessageReadingTrip(current.current.trip, operation.effect, status),
      };
      publish(next);
      if (next.find && operation.effect.kind === 'return') consumeMessageFindReturn(next.id);
      if (status === 'settled' && operation.effect.kind === 'return') {
        port.releaseReadingRef(operation.effect.origin.readingRef);
        if (next.find) {
          setFindState(next.find.state);
          setFindSeed((seed) => seed + 1);
          setOpen(true);
        }
      }
    },
    [publish],
  );

  const registerReadingPort = useCallback<RegisterChatReadingPort>(
    (port) => {
      if (!availableNow.current) return () => {};
      if (port.threadId !== foregroundThread.current) return () => {};
      reader.current = port;
      if (pending.current) void drive(pending.current, port);
      return () => {
        if (reader.current === port) reader.current = null;
      };
    },
    [available, drive],
  );

  const admitAndDrive = useCallback(
    async (operation: PendingReadingOperation) => {
      const { effect } = operation;
      const admission = await admitReadingEffect(effect, operation.controller.signal);
      if (pending.current !== operation || current.current?.id !== operation.sessionId) return;
      if (!admission.admitted) {
        pending.current = null;
        publish({ ...current.current, trip: settleMessageReadingTrip(current.current.trip, effect, 'unavailable') });
        if (current.current.find && effect.kind === 'return') consumeMessageFindReturn(current.current.id);
        setNotice(admission.notice);
        return;
      }
      operation.admitted = true;
      if (admission.notice) setNotice(admission.notice);
      const port = reader.current;
      if (port?.threadId === targetThread(effect)) void drive(operation, port);
      else pushThreadRoute(targetThread(effect));
    },
    [drive, publish, pushThreadRoute],
  );

  const request = useCallback(
    (next: MessageReadingSession, effect: MessageReadingEffect, options?: { direct?: boolean; refresh?: boolean }) => {
      pending.current?.controller.abort();
      publish(next);
      setNotice(null);
      const operation = createPendingOperation(next.id, effect, options);
      pending.current = operation;
      if (operation.direct) {
        const port = reader.current;
        if (port?.threadId === targetThread(effect)) void drive(operation, port);
      } else {
        void admitAndDrive(operation);
      }
    },
    [admitAndDrive, drive, publish],
  );

  const moveTo = useCallback(
    (index: number) => {
      if (!availableNow.current) return;
      const active = current.current;
      if (!active) return;
      const requested = requestMessageReadingTarget(active.trip, index);
      if (requested) request({ ...active, trip: requested.trip }, requested.effect);
    },
    [available, request],
  );

  const returnToOrigin = useCallback(() => {
    const active = current.current;
    if (!active) return;
    if (!availableNow.current && !active.find) return;
    if (active.find) destinationCallbacks.current.beforeFindReturn?.(active);
    const requested = requestMessageReadingReturn(active.trip);
    if (requested)
      request(
        { ...active, trip: requested.trip },
        requested.effect,
        active.source === 'jump' ? { direct: true, refresh: false } : undefined,
      );
  }, [available, request]);

  const dismissReturn = useCallback(() => {
    const active = current.current;
    if (!active || active.trip.status === 'completed') return;
    pending.current?.controller.abort();
    pending.current = null;
    releaseChatReadingRef(active.trip.origin.readingRef, active.trip.origin.threadId);
    publish({ ...active, trip: dismissMessageReadingTrip(active.trip) });
  }, [publish]);

  const jumpInThread = useCallback<MessageSearchHost['jumpInThread']>(
    (messageId, options) => {
      if (!availableNow.current) return false;
      const started = startJumpTargetFromForeground(messageId, reader.current, foregroundThread.current);
      if (!started) return false;
      activeDurable.current = started.persisted;
      setPersisted(started.persisted && started.session.originPersisted);
      setOpen(false);
      request(started.session, started.effect, { direct: true, refresh: Boolean(options?.refresh) });
      return true;
    },
    [request],
  );

  const openDestination = useCallback<MessageSearchHost['openDestination']>(
    (destination, state, workspaceOrigin) => {
      if (!searchAvailableNow.current || !destinationCallbacks.current.onOpenDestination) return;
      const prepared = prepareOpenDestination(
        destination,
        state,
        workspaceOrigin,
        reader.current,
        foregroundThread.current,
      );
      if (!prepared) return;
      if (!prepared.ok) {
        setNotice(prepared.notice);
        return;
      }
      pending.current?.controller.abort();
      pending.current = null;
      activeDurable.current = prepared.persisted;
      publish(prepared.session);
      setNotice(null);
      setOpen(false);
      destinationCallbacks.current.onOpenDestination(prepared.session);
    },
    [publish],
  );

  const navigateResult = useCallback(
    (result: MessageSearchResult, response: MessageSearchResponse) => {
      if (!searchAvailableNow.current) return;
      const prepared = prepareNavigateResult(
        result,
        response,
        current.current,
        reader.current,
        foregroundThread.current,
      );
      if (!prepared.ok) {
        if (prepared.notice) setNotice(prepared.notice);
        return;
      }
      if (prepared.startedPersisted !== undefined) {
        activeDurable.current = prepared.startedPersisted;
        setPersisted(prepared.startedPersisted && prepared.session.originPersisted);
      }
      setOpen(false);
      request(prepared.session, prepared.effect);
    },
    [request],
  );

  const cancelPending = useCallback(() => {
    const active = current.current;
    if (!pending.current || !active) return;
    pending.current.controller.abort();
    pending.current = null;
    publish({ ...active, trip: interruptMessageReadingTrip(active.trip) });
  }, [publish]);

  useEffect(() => {
    const recovered = readActiveMessageReadingSession();
    if (recovered) {
      current.current = recovered;
      setSession(recovered);
      setPersisted(recovered.originPersisted);
    }
    return () => {
      pending.current?.controller.abort();
      pending.current = null;
    };
  }, []);
  useMessageFindEntry({
    threadId,
    available: searchAvailable,
    readSession: () => current.current,
    hasPending: () => pending.current !== null,
    navigateResult,
    returnToOrigin,
    restore: (recovered, effect) => {
      destinationCallbacks.current.beforeFindReturn?.(recovered);
      request(recovered, effect);
    },
    show: (response) => {
      entryFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setFindState(toInitialFindState(response));
      setFindSeed((seed) => seed + 1);
      setNotice(null);
      setOpen(true);
    },
  });
  useEffect(() => {
    if (pending.current && targetThread(pending.current.effect) !== threadId) cancelPending();
  }, [cancelPending, threadId]);
  useEffect(() => {
    if (!searchAvailable) setOpen(false);
    if (!available) cancelPending();
  }, [available, cancelPending, searchAvailable]);

  const openSearch = useCallback(() => {
    if (!searchAvailableNow.current) return;
    entryFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFindState(undefined);
    setOpen(true);
  }, []);
  const closeSearch = useCallback(() => {
    setOpen(false);
    entryFocus.current?.focus({ preventScroll: true });
  }, []);
  return {
    open,
    session,
    persisted,
    notice,
    findState,
    findSeed,
    openSearch,
    openDestination,
    closeSearch,
    registerReadingPort,
    navigateResult,
    jumpInThread,
    moveTo,
    returnToOrigin,
    dismissReturn,
  };
}
