'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { useAgentMessages } from '@/hooks/useAgentMessages';
import { useChatSocketCallbacks } from '@/hooks/useChatSocketCallbacks';
import { type SocketCallbacks, useSocket } from '@/hooks/useSocket';
import { useChatStore } from '@/stores/chatStore';
import { getUserId } from '@/utils/userId';
import { pushThreadRouteWithHistory } from '../ThreadSidebar/thread-navigation';
import { createThreadChatHistoryAdmission, type ThreadChatHistoryAdmission } from './thread-chat-history-admission';
import { createThreadChatRuntimeRegistry, normalizeThreadIds } from './thread-chat-runtime-registry';

type IndexEventHandler = NonNullable<SocketCallbacks['onIndexEvent']>;

export interface ThreadChatRuntimeRegistration {
  socketConnected: boolean | null;
  resetAgentMessageRefs: () => void;
  registerIndexEventHandler: (handler: IndexEventHandler) => () => void;
}

interface ThreadChatRuntimeContextValue extends ThreadChatRuntimeRegistration {
  replaceConsumerRegistration: (consumerId: string, threadIds: readonly string[]) => void;
  removeConsumerRegistration: (consumerId: string) => void;
}

interface ThreadChatRuntimeProviderProps {
  children?: ReactNode;
  routeThreadId?: string | null;
}

const ThreadChatRuntimeContext = createContext<ThreadChatRuntimeContextValue | null>(null);
const ThreadChatHistoryAdmissionContext = createContext<ThreadChatHistoryAdmission | null>(null);

export function ThreadChatHistoryAdmissionProvider({ children }: { children?: ReactNode }) {
  const admissionRef = useRef<ThreadChatHistoryAdmission | null>(null);
  admissionRef.current ??= createThreadChatHistoryAdmission();
  return (
    <ThreadChatHistoryAdmissionContext.Provider value={admissionRef.current}>
      {children}
    </ThreadChatHistoryAdmissionContext.Provider>
  );
}

export function ThreadChatRuntimeProvider({ children, routeThreadId }: ThreadChatRuntimeProviderProps) {
  const registryRef = useRef(createThreadChatRuntimeRegistry());
  const [, advanceRoomRevision] = useReducer((revision: number) => revision + 1, 0);
  const roomRevisionQueuedRef = useRef(false);
  const runtimeMountedRef = useRef(true);
  const indexEventHandlersRef = useRef(new Map<symbol, IndexEventHandler>());
  const storeThreadId = useChatStore((state) => state.currentThreadId);
  const activeThreadId = routeThreadId || storeThreadId;
  const { handleAgentMessage, resetRefs, resetTimeout, clearDoneTimeout } = useAgentMessages();

  useLayoutEffect(() => {
    runtimeMountedRef.current = true;
    return () => {
      runtimeMountedRef.current = false;
    };
  }, []);

  const navigateToThread = useCallback((threadId: string) => {
    pushThreadRouteWithHistory(threadId, typeof window === 'undefined' ? undefined : window);
  }, []);
  const dispatchIndexEvent = useCallback<IndexEventHandler>((event, data) => {
    for (const handler of [...indexEventHandlersRef.current.values()]) handler(event, data);
  }, []);
  const socketCallbacks = useChatSocketCallbacks({
    threadId: activeThreadId,
    userId: getUserId(),
    handleAgentMessage,
    resetTimeout,
    clearDoneTimeout,
    onNavigateToThread: navigateToThread,
    onIndexEvent: dispatchIndexEvent,
  });
  const foregroundThreadIds = registryRef.current.snapshot();
  const { socketConnected } = useSocket(socketCallbacks, activeThreadId, foregroundThreadIds);

  const scheduleRoomRevision = useCallback(() => {
    if (roomRevisionQueuedRef.current) return;
    roomRevisionQueuedRef.current = true;
    queueMicrotask(() => {
      roomRevisionQueuedRef.current = false;
      if (runtimeMountedRef.current) advanceRoomRevision();
    });
  }, []);
  const replaceConsumerRegistration = useCallback(
    (consumerId: string, threadIds: readonly string[]) => {
      if (registryRef.current.replaceConsumerRegistration(consumerId, threadIds)) scheduleRoomRevision();
    },
    [scheduleRoomRevision],
  );
  const removeConsumerRegistration = useCallback(
    (consumerId: string) => {
      if (registryRef.current.removeConsumerRegistration(consumerId)) scheduleRoomRevision();
    },
    [scheduleRoomRevision],
  );
  const registerIndexEventHandler = useCallback((handler: IndexEventHandler) => {
    const generation = Symbol('thread-chat-index-event-handler');
    indexEventHandlersRef.current.set(generation, handler);
    return () => {
      indexEventHandlersRef.current.delete(generation);
    };
  }, []);

  const contextValue = useMemo<ThreadChatRuntimeContextValue>(
    () => ({
      socketConnected,
      resetAgentMessageRefs: resetRefs,
      registerIndexEventHandler,
      replaceConsumerRegistration,
      removeConsumerRegistration,
    }),
    [socketConnected, resetRefs, registerIndexEventHandler, replaceConsumerRegistration, removeConsumerRegistration],
  );

  return (
    <ThreadChatHistoryAdmissionProvider>
      <ThreadChatRuntimeContext.Provider value={contextValue}>{children}</ThreadChatRuntimeContext.Provider>
    </ThreadChatHistoryAdmissionProvider>
  );
}

export function useThreadChatHistoryAdmission(): ThreadChatHistoryAdmission {
  const admission = useContext(ThreadChatHistoryAdmissionContext);
  if (!admission) throw new Error('useThreadChatHistoryAdmission must be used within ThreadChatRuntimeProvider');
  return admission;
}

export function useThreadChatRuntime(threadIds: readonly string[]): ThreadChatRuntimeRegistration {
  const runtime = useContext(ThreadChatRuntimeContext);
  if (!runtime) throw new Error('useThreadChatRuntime must be used within ThreadChatRuntimeProvider');

  const consumerId = useId();
  const registrationKey = JSON.stringify(normalizeThreadIds(threadIds));
  const {
    socketConnected,
    resetAgentMessageRefs,
    registerIndexEventHandler,
    replaceConsumerRegistration,
    removeConsumerRegistration,
  } = runtime;

  useLayoutEffect(() => {
    replaceConsumerRegistration(consumerId, JSON.parse(registrationKey) as string[]);
  }, [consumerId, registrationKey, replaceConsumerRegistration]);

  useLayoutEffect(
    () => () => {
      removeConsumerRegistration(consumerId);
    },
    [consumerId, removeConsumerRegistration],
  );

  return {
    socketConnected,
    resetAgentMessageRefs,
    registerIndexEventHandler,
  };
}
