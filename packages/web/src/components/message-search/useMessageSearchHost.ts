import type { MessageSearchResponse, MessageSearchResult } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatReadingPort, RegisterChatReadingPort } from '../thread-chat/useThreadChatReadingPort';
import { consumeMessageFindReturn } from './message-find-events';
import {
  type MessageFindContext,
  type MessageFindDestination,
  type MessageFindState,
  parseMessageFindContext,
} from './message-find-state';
import {
  readThroughOwner,
  startFindPageFromForeground,
  startFromForeground,
  targetThread,
} from './message-reading-owner';
import {
  type MessageReadingSession,
  readActiveMessageReadingSession,
  saveMessageReadingSession,
} from './message-reading-session';
import {
  interruptMessageReadingTrip,
  type MessageReadingEffect,
  requestMessageReadingReturn,
  requestMessageReadingTarget,
  settleMessageReadingTrip,
} from './message-reading-trip';
import { useMessageFindEntry } from './useMessageFindEntry';
import { verifyMessageNavigationSource } from './verify-message-navigation-source';

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
  moveTo: (index: number) => void;
  returnToOrigin: () => void;
}

interface PendingReadingOperation {
  sessionId: string;
  effect: MessageReadingEffect;
  running: boolean;
  admitted: boolean;
  controller: AbortController;
}

/** A navigation consumer: route and reading owners retain all authorization, paging and geometry. */
export function useMessageSearchHost({
  threadId,
  pushThreadRoute,
  available = true,
  onOpenDestination,
  beforeFindReturn,
}: {
  threadId: string;
  pushThreadRoute: (threadId: string) => void;
  available?: boolean;
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
        status = await readThroughOwner(port, operation.effect, operation.controller.signal);
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
      const admission = await verifyMessageNavigationSource(
        effect.kind === 'target' ? effect.target : { threadId: effect.origin.threadId },
        operation.controller.signal,
      );
      if (pending.current !== operation || current.current?.id !== operation.sessionId) return;
      if (admission.status !== 'available') {
        pending.current = null;
        publish({ ...current.current, trip: settleMessageReadingTrip(current.current.trip, effect, 'unavailable') });
        if (current.current.find && effect.kind === 'return') consumeMessageFindReturn(current.current.id);
        setNotice(
          admission.status === 'forbidden'
            ? '这条来源目前不可访问，已保留返回位置。'
            : '这条来源暂不可定位，已保留返回位置。',
        );
        return;
      }
      operation.admitted = true;
      if (admission.updated) setNotice('来源已更新，将定位到这条消息的当前版本。');
      const port = reader.current;
      if (port?.threadId === targetThread(effect)) void drive(operation, port);
      else pushThreadRoute(targetThread(effect));
    },
    [drive, publish, pushThreadRoute],
  );

  const request = useCallback(
    (next: MessageReadingSession, effect: MessageReadingEffect) => {
      pending.current?.controller.abort();
      publish(next);
      setNotice(null);
      const operation: PendingReadingOperation = {
        sessionId: next.id,
        effect,
        running: false,
        admitted: false,
        controller: new AbortController(),
      };
      pending.current = operation;
      void admitAndDrive(operation);
    },
    [admitAndDrive, publish],
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
    if (requested) request({ ...active, trip: requested.trip }, requested.effect);
  }, [available, request]);

  const openDestination = useCallback<MessageSearchHost['openDestination']>(
    (destination, state, workspaceOrigin) => {
      if (!availableNow.current || !destinationCallbacks.current.onOpenDestination) return;
      const find = parseMessageFindContext({ destination, state, ...(workspaceOrigin ? { workspaceOrigin } : {}) });
      if (!find) return;
      const started = startFindPageFromForeground(find, reader.current, foregroundThread.current);
      if (!started) {
        setNotice('当前阅读位置或查找状态暂无法保存，请留在对话中再试。');
        return;
      }
      pending.current?.controller.abort();
      pending.current = null;
      activeDurable.current = started.persisted;
      publish(started.session);
      setNotice(null);
      setOpen(false);
      destinationCallbacks.current.onOpenDestination(started.session);
    },
    [publish],
  );

  const navigateResult = useCallback(
    (result: MessageSearchResult, response: MessageSearchResponse) => {
      if (!availableNow.current) return;
      const index = response.results.findIndex(
        (candidate) => candidate.threadId === result.threadId && candidate.messageId === result.messageId,
      );
      if (index < 0) {
        setNotice('这条来源不属于当前检索结果，暂不可跳转。');
        return;
      }
      let active = current.current;
      if (!active || active.trip.searchId !== response.searchId || active.trip.status === 'completed') {
        const started = startFromForeground(response, reader.current, foregroundThread.current);
        if (!started) {
          setNotice('当前阅读位置暂不可保存，请在对话中重新尝试。');
          return;
        }
        active = started.session;
        activeDurable.current = started.persisted;
        setPersisted(started.persisted && started.session.originPersisted);
      }
      const indexInCollection = active.trip.targets.findIndex(
        (target) => target.threadId === result.threadId && target.messageId === result.messageId,
      );
      const requested = requestMessageReadingTarget(active.trip, indexInCollection);
      if (!requested) return;
      setOpen(false);
      request({ ...active, trip: requested.trip }, requested.effect);
    },
    [available, request],
  );

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
    available,
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
      setFindState({
        query: response.query,
        scope: response.meta.scope,
        sort: response.meta.sort,
        scrollTop: 0,
        status: 'ready',
        response,
      });
      setFindSeed((seed) => seed + 1);
      setNotice(null);
      setOpen(true);
    },
  });
  useEffect(() => {
    const operation = pending.current;
    const active = current.current;
    if (!operation || !active || targetThread(operation.effect) === threadId) return;
    operation.controller.abort();
    pending.current = null;
    publish({ ...active, trip: interruptMessageReadingTrip(active.trip) });
  }, [publish, threadId]);
  useEffect(() => {
    if (available) return;
    setOpen(false);
    const active = current.current;
    if (!pending.current || !active) return;
    pending.current.controller.abort();
    pending.current = null;
    publish({ ...active, trip: interruptMessageReadingTrip(active.trip) });
  }, [available, publish]);

  const openSearch = useCallback(() => {
    if (!availableNow.current) return;
    entryFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setFindState(undefined);
    setOpen(true);
  }, [available]);
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
    moveTo,
    returnToOrigin,
  };
}
