'use client';

import { useCallback, useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import {
  bootstrapDebugFromStorage,
  ensureWindowDebugApi,
  isDebugEnabled,
  recordDebugEvent,
} from '@/debug/invocationEventDebug';
import { useBrakeStore } from '@/stores/brakeStore';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { API_URL, apiFetch } from '@/utils/api-client';
import { getUserId } from '@/utils/userId';
import { reconnectGame } from './useGameReconnect';
import {
  type BackgroundAgentMessage,
  clearBackgroundStreamRefForActiveEvent,
  handleBackgroundAgentMessage,
} from './useSocket-background';
import { loadJoinedRoomsFromSession, saveJoinedRoomsToSession } from './useSocket-persistence';
import { handleVoiceChunk, handleVoiceStreamEnd, handleVoiceStreamStart } from './useVoiceStream';

interface AgentMessage {
  type: string;
  catId: string;
  threadId?: string;
  content?: string;
  sessionId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  error?: string;
  isFinal?: boolean;
  metadata?: { provider: string; model: string; sessionId?: string; usage?: import('../stores/chat-types').TokenUsage };
  /** Message origin: stream = CLI stdout (thinking), callback = MCP post_message (speech) */
  origin?: 'stream' | 'callback';
  /** F121: ID of the message this message is replying to */
  replyTo?: string;
  /** F121: Hydrated preview of the replied-to message */
  replyPreview?: { senderCatId: string | null; content: string; deleted?: true };
  /** F108: Invocation ID — distinguishes messages from concurrent invocations */
  invocationId?: string;
  timestamp: number;
}

interface ConnectorMessageEvent {
  threadId: string;
  message: {
    id: string;
    type: 'connector';
    content: string;
    source?: import('../stores/chat-types').ConnectorSourceData;
    extra?: Record<string, unknown>;
    timestamp: number;
  };
}

interface SocketIoTransportLike {
  name?: string;
  ws?: WebSocket;
}

interface SocketIoEngineLike {
  transport?: SocketIoTransportLike;
  on: (event: string, listener: (...args: unknown[]) => void) => void;
}

type DebugWebSocket = WebSocket & { __catCafeCloseLoggerAttached?: boolean };

export interface SocketCallbacks {
  onMessage: (msg: AgentMessage) => void;
  onThreadUpdated?: (data: { threadId: string; title?: string; participants?: string[] }) => void;
  onIntentMode?: (data: { threadId: string; mode: string; targetCats: string[] }) => void;
  onTaskCreated?: (task: Record<string, unknown>) => void;
  onTaskUpdated?: (task: Record<string, unknown>) => void;
  onHeartbeat?: (data: { threadId: string; timestamp: number }) => void;
  onMessageDeleted?: (data: { messageId: string; threadId: string; deletedBy: string }) => void;
  onMessageRestored?: (data: { messageId: string; threadId: string }) => void;
  onThreadBranched?: (data: { sourceThreadId: string; newThreadId: string; fromMessageId: string }) => void;
  onAuthorizationRequest?: (data: {
    requestId: string;
    catId: string;
    threadId: string;
    action: string;
    reason: string;
    context?: string;
    createdAt: number;
  }) => void;
  onAuthorizationResponse?: (data: { requestId: string; status: string; scope?: string; reason?: string }) => void;
  /** F101: Game state update */
  onGameStateUpdate?: (data: { gameId: string; view: unknown; timestamp: number }) => void;
  /** F101 Phase D: Independent game thread created */
  onGameThreadCreated?: (data: {
    gameThreadId: string;
    gameTitle: string;
    initiatorUserId: string;
    timestamp: number;
  }) => void;
  /** #80 fix-C: Clear the done-timeout guard (called when background thread completes) */
  clearDoneTimeout?: (threadId?: string) => void;
  /** F39: Queue updated */
  onQueueUpdated?: (data: {
    threadId: string;
    queue: import('../stores/chat-types').QueueEntry[];
    action: string;
  }) => void;
  /** F39: Queue paused */
  onQueuePaused?: (data: {
    threadId: string;
    reason: 'canceled' | 'failed';
    queue: import('../stores/chat-types').QueueEntry[];
  }) => void;
  /** F152 Phase B: Memory bootstrap index events */
  onIndexEvent?: (event: string, data: Record<string, unknown>) => void;
}

const RECONNECT_RECONCILE_DELAY_MS = 2000;

/** Generation counter: each reconnect increments, stale callbacks discard themselves. */
let reconcileGeneration = 0;

/**
 * After socket reconnect, bidirectionally reconcile invocation state with server.
 * Socket disconnect can lose done(isFinal) events (UI stuck in "replying") or
 * cause local state to drift from server truth. Fetches the queue endpoint and:
 * - Server has active cats → re-hydrate local slots to match (fixes ID mismatches)
 * - Server has no active cats → clear stale local invocation state
 */
function reconcileInvocationStateOnReconnect(activeThreadId: string | null): void {
  const generation = ++reconcileGeneration;
  const state = useChatStore.getState();

  // Collect threads to reconcile: always check the active thread (server might
  // still be processing even if local cleared state during disconnect), plus
  // any background threads that think they have active invocations.
  const threadsToCheck: string[] = [];
  if (activeThreadId) {
    threadsToCheck.push(activeThreadId);
  }
  for (const [threadId, ts] of Object.entries(state.threadStates ?? {})) {
    if (ts.hasActiveInvocation && threadId !== activeThreadId) {
      threadsToCheck.push(threadId);
    }
  }
  if (threadsToCheck.length === 0) return;

  // Small delay: let any buffered socket events arrive first
  setTimeout(async () => {
    // Discard if a newer reconnect has started its own reconciliation
    if (generation !== reconcileGeneration) return;
    for (const threadId of threadsToCheck) {
      if (generation !== reconcileGeneration) return;
      try {
        const res = await apiFetch(`/api/threads/${threadId}/queue`);
        if (generation !== reconcileGeneration) return; // stale after await
        if (!res.ok) continue;
        const data = (await res.json()) as {
          activeInvocations?: Array<{ catId: string; startedAt: number }>;
        };
        if (generation !== reconcileGeneration) return; // stale after await
        const store = useChatStore.getState();
        const serverSlots = data.activeInvocations && data.activeInvocations.length > 0 ? data.activeInvocations : null;
        const isActiveThread = store.currentThreadId === threadId;

        if (serverSlots) {
          // Server still processing — re-hydrate local slots to match server truth.
          // Stale hydrated/mismatched invocationIds get replaced so done(isFinal)
          // cleanup works correctly when the response finishes.
          const serverActiveCats = serverSlots.map((s) => s.catId);
          store.clearThreadActiveInvocation(threadId);
          store.replaceThreadTargetCats(threadId, serverActiveCats);
          for (const slot of serverSlots) {
            store.updateThreadCatStatus(threadId, slot.catId, 'streaming');
            const syntheticId = `hydrated-${threadId}-${slot.catId}`;
            if (isActiveThread) {
              store.addActiveInvocation(syntheticId, slot.catId, 'execute', slot.startedAt);
            } else {
              store.addThreadActiveInvocation(threadId, syntheticId, slot.catId, 'execute', slot.startedAt);
            }
          }
          console.log('[ws] Reconnect reconciliation: re-hydrated active slots from server', {
            threadId,
            cats: serverActiveCats,
          });
          continue;
        }

        if (isActiveThread && store.hasActiveInvocation) {
          // Reconnect reconciliation is stale-state repair, not a real completion event.
          // Use the non-stamping clear so idle-thread recency is not artificially bumped.
          store.clearThreadActiveInvocation(threadId);
          store.setLoading(false);
          store.setIntentMode(null);
          store.clearCatStatuses();
          for (const msg of store.messages) {
            if (msg.type === 'assistant' && msg.isStreaming) {
              store.setStreaming(msg.id, false);
            }
          }
          // Reconnect catch-up (#276): server finished during disconnect,
          // done(isFinal) was lost → fetch missed messages so user doesn't need F5
          store.requestStreamCatchUp(threadId);
          console.log('[ws] Reconnect reconciliation: cleared stale active-thread invocation state', { threadId });
        } else if (!isActiveThread) {
          const ts = store.getThreadState(threadId);
          if (ts.hasActiveInvocation) {
            store.clearThreadActiveInvocation(threadId);
            store.setThreadLoading(threadId, false);
            for (const msg of ts.messages) {
              if (msg.type === 'assistant' && msg.isStreaming) {
                store.setThreadMessageStreaming(threadId, msg.id, false);
              }
            }
            console.log('[ws] Reconnect reconciliation: cleared stale background-thread invocation state', {
              threadId,
            });
          }
        }
      } catch {
        // Non-critical — don't break reconnect flow
      }
    }
  }, RECONNECT_RECONCILE_DELAY_MS);
}

export function useSocket(callbacks: SocketCallbacks, threadId?: string) {
  const socketRef = useRef<Socket | null>(null);
  const joinedRoomsRef = useRef<Set<string>>(new Set());
  const bgStreamRefsRef = useRef<Map<string, { id: string; threadId: string; catId: string }>>(new Map());
  const bgReplacedInvocationsRef = useRef<Map<string, string>>(new Map());
  const bgFinalizedRefsRef = useRef<Map<string, string>>(new Map());
  const bgSeqRef = useRef(0);
  const userIdRef = useRef(getUserId());
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  // Use ref to avoid socket disconnect/reconnect on every callbacks change.
  // Without this, thread switches cause socketCallbacks to rebuild (useMemo dep on threadId),
  // which triggers useEffect cleanup → socket disconnect → reconnect. During this gap,
  // events from the old thread can leak into the new thread's state.
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  const persistJoinedRooms = useCallback(() => {
    saveJoinedRoomsToSession(userIdRef.current, joinedRoomsRef.current);
  }, []);

  useEffect(() => {
    userIdRef.current = getUserId();
    joinedRoomsRef.current = loadJoinedRoomsFromSession(userIdRef.current);
    if (threadIdRef.current) {
      joinedRoomsRef.current.add(`thread:${threadIdRef.current}`);
    }
    persistJoinedRooms();
    bootstrapDebugFromStorage();
    ensureWindowDebugApi();

    const recordInvocationEvent = (event: Parameters<typeof recordDebugEvent>[0]) => {
      if (!isDebugEnabled()) return;
      const store = useChatStore.getState();
      const traceThreadId = event.threadId;
      const threadState = traceThreadId ? store.getThreadState(traceThreadId) : null;
      recordDebugEvent({
        ...event,
        timestamp: event.timestamp ?? Date.now(),
        routeThreadId: event.routeThreadId ?? threadIdRef.current,
        storeThreadId: event.storeThreadId ?? store.currentThreadId,
        queuePaused: event.queuePaused ?? threadState?.queuePaused,
        hasActiveInvocation: event.hasActiveInvocation ?? threadState?.hasActiveInvocation,
      });
    };

    const socket = io(API_URL, {
      transports: ['websocket', 'polling'],
      auth: { userId: userIdRef.current },
    });

    const getTransportName = () => {
      const engine = socket.io.engine as unknown as SocketIoEngineLike | undefined;
      return engine?.transport?.name ?? 'unknown';
    };

    const attachNativeCloseLogger = () => {
      const engine = socket.io.engine as unknown as SocketIoEngineLike | undefined;
      const transport = engine?.transport;
      if (!transport || transport.name !== 'websocket' || !transport.ws) return;
      const ws = transport.ws as DebugWebSocket;
      if (ws.__catCafeCloseLoggerAttached) return;
      ws.__catCafeCloseLoggerAttached = true;
      ws.addEventListener('close', (event) => {
        console.warn('[ws] Native close', {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });
      });
    };

    socket.on('connect', () => {
      console.log('[ws] Connected', {
        socketId: socket.id,
        transport: getTransportName(),
        threadId: threadIdRef.current ?? null,
        rooms: [...joinedRoomsRef.current],
      });
      attachNativeCloseLogger();

      // Rejoin all tracked rooms on reconnect
      const rejoinedRooms: string[] = [];
      for (const room of joinedRoomsRef.current) {
        socket.emit('join_room', room);
        rejoinedRooms.push(room);
      }
      // Ensure active thread room is joined
      const tid = threadIdRef.current;
      if (tid) {
        const room = `thread:${tid}`;
        if (!joinedRoomsRef.current.has(room)) {
          socket.emit('join_room', room);
          joinedRoomsRef.current.add(room);
          rejoinedRooms.push(room);
        }
      }
      persistJoinedRooms();
      console.log('[ws] Rejoined rooms', {
        count: rejoinedRooms.length,
        rooms: rejoinedRooms,
      });
      recordInvocationEvent({
        event: 'connect',
        threadId: tid ?? undefined,
        action: getTransportName(),
      });
      recordInvocationEvent({
        event: 'rejoin_rooms',
        threadId: tid ?? undefined,
        queueLength: rejoinedRooms.length,
      });

      // F101: Recover game state on reconnect
      if (tid) {
        reconnectGame(tid).catch(() => {});
      }

      // Reconnect reconciliation: verify invocation state against server truth.
      // Socket disconnect can lose done(isFinal) events, leaving stale "replying" UI.
      // Delay slightly so any buffered events arrive first.
      reconcileInvocationStateOnReconnect(tid ?? null);
    });

    socket.on('agent_message', (msg: AgentMessage) => {
      const routeThread = threadIdRef.current;
      const storeThread = useChatStore.getState().currentThreadId;

      // Active thread requires BOTH route-level and store-level agreement.
      // This blocks a switch-window race where route already points to thread-B
      // but flat store still belongs to thread-A.
      const isActiveThreadMessage = Boolean(
        msg.threadId && routeThread && storeThread && msg.threadId === routeThread && msg.threadId === storeThread,
      );
      // If either pointer is temporarily unavailable during thread switch,
      // route thread-tagged events to background to avoid mutating stale flat state.
      recordInvocationEvent({
        event: msg.type === 'done' ? 'done' : 'agent_message',
        threadId: msg.threadId,
        action: msg.type,
        isFinal: msg.isFinal === true,
      });

      // Defensive fallback for malformed legacy payloads (threadId missing).
      if (!msg.threadId) {
        callbacksRef.current.onMessage(msg);
        clearBackgroundStreamRefForActiveEvent(msg, bgStreamRefsRef.current);
        return;
      }

      // Active thread → full processing via onMessage (streaming, tool events, etc.)
      if (isActiveThreadMessage) {
        callbacksRef.current.onMessage(msg);
        clearBackgroundStreamRefForActiveEvent(msg, bgStreamRefsRef.current);
        return;
      }

      // Background thread → delegated handler
      handleBackgroundAgentMessage(msg as BackgroundAgentMessage, {
        store: useChatStore.getState(),
        bgStreamRefs: bgStreamRefsRef.current,
        finalizedBgRefs: bgFinalizedRefsRef.current,
        replacedInvocations: bgReplacedInvocationsRef.current,
        nextBgSeq: () => bgSeqRef.current++,
        addToast: (toast) => useToastStore.getState().addToast(toast),
        clearDoneTimeout: callbacksRef.current.clearDoneTimeout,
      });
    });

    socket.on('thread_updated', (data: { threadId: string; title?: string; participants?: string[] }) => {
      callbacksRef.current.onThreadUpdated?.(data);
    });

    socket.on(
      'intent_mode',
      (data: { threadId: string; mode: string; targetCats: string[]; invocationId?: string }) => {
        const routeThread = threadIdRef.current;
        const storeThread = useChatStore.getState().currentThreadId;
        recordInvocationEvent({
          event: 'intent_mode',
          threadId: data.threadId,
          mode: data.mode,
        });

        // Dual-pointer guard: both route and store must agree for active-thread processing.
        // Mirrors agent_message pattern — blocks switch-window race where route already
        // points to thread-B but flat store still belongs to thread-A.
        const isActiveThread = Boolean(
          data.threadId && routeThread && storeThread && data.threadId === routeThread && data.threadId === storeThread,
        );

        if (isActiveThread) {
          callbacksRef.current.onIntentMode?.(data);
          // F108: Register invocation slot for ALL targetCats (not just the first)
          if (data.invocationId) {
            const cats = data.targetCats ?? [];
            for (let i = 0; i < cats.length; i++) {
              const invId = i === 0 ? data.invocationId : `${data.invocationId}-${cats[i]}`;
              // #963 fix: preempt stale slot for same cat before registering.
              // Side-dispatch callbacks send their own intent_mode, orphaning the
              // parent's slot (parentInvId-catId). Remove it to match backend
              // tracker.start() preemption behavior.
              const cur = useChatStore.getState().activeInvocations;
              for (const [key, info] of Object.entries(cur)) {
                if (info.catId === cats[i] && key !== invId) {
                  useChatStore.getState().removeActiveInvocation(key);
                }
              }
              useChatStore.getState().addActiveInvocation(invId, cats[i]!, data.mode);
            }
          }
          return;
        }

        // Background thread (split-pane) or switch-window: write directly to thread-scoped state
        if (data.threadId) {
          const store = useChatStore.getState();
          store.setThreadLoading(data.threadId, true);
          // F108: slot-aware — register ALL targetCats (not just the first)
          if (data.invocationId) {
            const cats = data.targetCats ?? [];
            for (let i = 0; i < cats.length; i++) {
              const invId = i === 0 ? data.invocationId : `${data.invocationId}-${cats[i]}`;
              // #963 fix: preempt stale slot (same as active-thread path above)
              const threadState = store.getThreadState(data.threadId);
              for (const [key, info] of Object.entries(threadState.activeInvocations)) {
                if (info.catId === cats[i] && key !== invId) {
                  store.removeThreadActiveInvocation(data.threadId, key);
                }
              }
              store.addThreadActiveInvocation(data.threadId, invId, cats[i]!, data.mode);
            }
          } else {
            store.setThreadHasActiveInvocation(data.threadId, true);
          }
          store.setThreadIntentMode(data.threadId, data.mode as 'execute' | 'ideate');
          store.setThreadTargetCats(data.threadId, data.targetCats ?? []);
        }
      },
    );

    socket.on('task_created', (task: Record<string, unknown>) => {
      callbacksRef.current.onTaskCreated?.(task);
    });

    socket.on('task_updated', (task: Record<string, unknown>) => {
      callbacksRef.current.onTaskUpdated?.(task);
    });

    // thread_summary listener removed (clowder-ai#343): summaries no longer injected into chat flow.

    socket.on('heartbeat', (data: { threadId: string; timestamp: number }) => {
      callbacksRef.current.onHeartbeat?.(data);
    });

    socket.on('message_deleted', (data: { messageId: string; threadId: string; deletedBy: string }) => {
      callbacksRef.current.onMessageDeleted?.(data);
    });
    socket.on('message_hard_deleted', (data: { messageId: string; threadId: string; deletedBy: string }) => {
      callbacksRef.current.onMessageDeleted?.(data);
    });
    socket.on('message_restored', (data: { messageId: string; threadId: string }) => {
      callbacksRef.current.onMessageRestored?.(data);
    });
    socket.on('thread_branched', (data: { sourceThreadId: string; newThreadId: string; fromMessageId: string }) => {
      callbacksRef.current.onThreadBranched?.(data);
    });

    socket.on('authorization:request', (data: Record<string, unknown>) => {
      const currentThread = threadIdRef.current;
      if (data.threadId && currentThread && data.threadId !== currentThread) return;
      callbacksRef.current.onAuthorizationRequest?.(
        data as Parameters<NonNullable<SocketCallbacks['onAuthorizationRequest']>>[0],
      );
    });
    socket.on('authorization:response', (data: Record<string, unknown>) => {
      callbacksRef.current.onAuthorizationResponse?.(
        data as Parameters<NonNullable<SocketCallbacks['onAuthorizationResponse']>>[0],
      );
    });

    const normalizeQueueForDebug = (queue: unknown): unknown[] => (Array.isArray(queue) ? queue : []);
    const getQueueStatusesForDebug = (queue: unknown) =>
      normalizeQueueForDebug(queue).map((entry) => {
        if (!entry || typeof entry !== 'object') return 'unknown';
        const status = (entry as { status?: unknown }).status;
        return typeof status === 'string' ? status : 'unknown';
      });

    // F39: Queue events — always write via store (no dual-pointer guard needed, queue is thread-scoped)
    socket.on('queue_updated', (data: { threadId: string; queue: unknown[]; action: string }) => {
      const store = useChatStore.getState();
      store.setQueue(data.threadId, data.queue as import('../stores/chat-types').QueueEntry[]);
      // Queue processor started executing an entry: restore active invocation marker
      // so ChatInput can show "正在回复中" and Stop/queue controls after thread switches/F5.
      if (data.action === 'processing') {
        store.setThreadHasActiveInvocation(data.threadId, true);
      }
      // P1 fix: 'processing' means continue/auto-dequeue resumed the queue — clear paused state
      if (data.action === 'processing' || data.action === 'cleared') {
        store.setQueuePaused(data.threadId, false);
      }
      if (isDebugEnabled()) {
        const stateAfterUpdate = store.getThreadState(data.threadId);
        recordInvocationEvent({
          event: 'queue_updated',
          threadId: data.threadId,
          action: data.action,
          queueLength: normalizeQueueForDebug(data.queue).length,
          queueStatuses: getQueueStatusesForDebug(data.queue),
          hasActiveInvocation: data.action === 'processing' ? true : stateAfterUpdate?.hasActiveInvocation,
          queuePaused:
            data.action === 'processing' || data.action === 'cleared' ? false : stateAfterUpdate?.queuePaused,
        });
      }
    });
    // F098-D + F117: Messages delivered — update deliveredAt + insert user bubbles for queue sends
    socket.on(
      'messages_delivered',
      (data: {
        threadId: string;
        messageIds: string[];
        deliveredAt: number;
        messages?: Array<{
          id: string;
          content: string;
          catId: string | null;
          timestamp: number;
          mentions: readonly string[];
          userId: string;
          contentBlocks?: readonly unknown[];
        }>;
      }) => {
        useChatStore.getState().markMessagesDelivered(data.threadId, data.messageIds, data.deliveredAt, data.messages);
      },
    );

    socket.on('queue_paused', (data: { threadId: string; reason: 'canceled' | 'failed'; queue: unknown[] }) => {
      const store = useChatStore.getState();
      store.setQueue(data.threadId, data.queue as import('../stores/chat-types').QueueEntry[]);
      store.setQueuePaused(data.threadId, true, data.reason);
      if (isDebugEnabled()) {
        recordInvocationEvent({
          event: 'queue_paused',
          threadId: data.threadId,
          reason: data.reason,
          queueLength: normalizeQueueForDebug(data.queue).length,
          queueStatuses: getQueueStatusesForDebug(data.queue),
        });
      }
    });
    socket.on('queue_full_warning', (data: { threadId: string; source: 'user' | 'connector'; queue: unknown[] }) => {
      const store = useChatStore.getState();
      store.setQueue(data.threadId, data.queue as import('../stores/chat-types').QueueEntry[]);
      store.setQueueFull(data.threadId, data.source);
      useToastStore.getState().addToast({
        type: 'info',
        title: '队列已满',
        message: '消息队列已达上限，请管理队列后再发送',
        threadId: data.threadId,
        duration: 5000,
      });
    });

    socket.on('connector_message', (data: ConnectorMessageEvent) => {
      if (!data?.threadId || !data?.message?.id) return;
      const store = useChatStore.getState();
      store.addMessageToThread(data.threadId, {
        id: data.message.id,
        type: 'connector',
        content: data.message.content ?? '',
        ...(data.message.source ? { source: data.message.source } : {}),
        ...(data.message.extra ? { extra: data.message.extra } : {}),
        timestamp: data.message.timestamp ?? Date.now(),
      });
    });

    // F085 Phase 4: Hyperfocus brake trigger from backend activity tracking
    socket.on(
      'brake:trigger',
      (data: { level: 1 | 2 | 3; activeMinutes: number; nightMode: boolean; timestamp: number }) => {
        useBrakeStore.getState().show(data);
      },
    );

    // F101: Game state updates (per-seat scoped views)
    socket.on('game:state_update', (data: { gameId: string; view: unknown; timestamp: number }) => {
      callbacksRef.current.onGameStateUpdate?.(data);
    });

    // F101 Phase I: Narrator narrative messages (e.g. "🐺 狼人请睁眼")
    socket.on(
      'game:narrative',
      (data: { threadId: string; message: { id: string; type: string; content: string; timestamp: number } }) => {
        if (!data?.threadId || !data?.message?.id) return;
        useChatStore.getState().addMessageToThread(data.threadId, {
          id: data.message.id,
          type: 'system',
          content: data.message.content,
          timestamp: data.message.timestamp,
        });
      },
    );

    // F101 Phase D: Independent game thread created
    socket.on(
      'game:thread_created',
      (data: { gameThreadId: string; gameTitle: string; initiatorUserId: string; timestamp: number }) => {
        callbacksRef.current.onGameThreadCreated?.(data);
      },
    );

    // F152 Phase B: Memory bootstrap progress events
    socket.on('index:progress', (data: Record<string, unknown>) => {
      callbacksRef.current.onIndexEvent?.('index:progress', data);
    });
    socket.on('index:complete', (data: Record<string, unknown>) => {
      callbacksRef.current.onIndexEvent?.('index:complete', data);
    });
    socket.on('index:failed', (data: Record<string, unknown>) => {
      callbacksRef.current.onIndexEvent?.('index:failed', data);
    });

    // F111 Phase B + F112 Phase A: Real-time voice stream events
    socket.on('voice_stream_start', handleVoiceStreamStart);
    socket.on('voice_chunk', handleVoiceChunk);
    socket.on('voice_stream_end', handleVoiceStreamEnd);

    socket.on('connect_error', (error: Error & { description?: unknown; context?: unknown }) => {
      console.error('[ws] connect_error', {
        message: error.message,
        name: error.name,
        transport: getTransportName(),
        description: error.description ?? null,
        context: error.context ?? null,
      });
    });

    socket.on('disconnect', (...args: unknown[]) => {
      const [reason, details] = args;
      console.warn('[ws] Disconnected', {
        reason: typeof reason === 'string' ? reason : String(reason),
        transport: getTransportName(),
        details: details ?? null,
      });
      recordInvocationEvent({
        event: 'disconnect',
        threadId: threadIdRef.current,
        reason: typeof reason === 'string' ? reason : String(reason),
      });
    });

    const engine = socket.io.engine as unknown as SocketIoEngineLike | undefined;
    engine?.on('upgrade', () => {
      attachNativeCloseLogger();
      console.log('[ws] Transport upgraded', { transport: getTransportName() });
    });
    engine?.on('close', (...args: unknown[]) => {
      const [reason] = args;
      console.warn('[ws] Engine close', {
        reason: typeof reason === 'string' ? reason : String(reason),
        transport: getTransportName(),
      });
      recordInvocationEvent({
        event: 'engine_close',
        threadId: threadIdRef.current,
        reason: typeof reason === 'string' ? reason : String(reason),
      });
    });

    socketRef.current = socket;

    return () => {
      socket.disconnect();
      joinedRoomsRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- callbacks accessed via callbacksRef
  }, [persistJoinedRooms]);

  /** Join a single room (additive — does not leave other rooms) */
  const joinRoom = useCallback(
    (roomThreadId: string) => {
      const socket = socketRef.current;
      if (!socket) return;
      const room = `thread:${roomThreadId}`;
      if (joinedRoomsRef.current.has(room)) return;
      socket.emit('join_room', room);
      joinedRoomsRef.current.add(room);
      persistJoinedRooms();
    },
    [persistJoinedRooms],
  );

  /** Leave a single room */
  const leaveRoom = useCallback(
    (roomThreadId: string) => {
      const socket = socketRef.current;
      if (!socket) return;
      const room = `thread:${roomThreadId}`;
      if (!joinedRoomsRef.current.has(room)) return;
      socket.emit('leave_room', room);
      joinedRoomsRef.current.delete(room);
      persistJoinedRooms();
    },
    [persistJoinedRooms],
  );

  /** Sync joined rooms to exactly the given set of thread IDs */
  const syncRooms = useCallback(
    (threadIds: string[]) => {
      const socket = socketRef.current;
      if (!socket) return;

      const targetRooms = new Set(threadIds.map((id) => `thread:${id}`));

      // Leave rooms no longer needed
      for (const room of joinedRoomsRef.current) {
        if (!targetRooms.has(room)) {
          socket.emit('leave_room', room);
          joinedRoomsRef.current.delete(room);
        }
      }

      // Join new rooms
      for (const room of targetRooms) {
        if (!joinedRoomsRef.current.has(room)) {
          socket.emit('join_room', room);
          joinedRoomsRef.current.add(room);
        }
      }
      persistJoinedRooms();
    },
    [persistJoinedRooms],
  );

  // Automatically ensure active thread room is joined when threadId changes
  useEffect(() => {
    if (threadId) {
      joinRoom(threadId);
    }
  }, [threadId, joinRoom]);

  const cancelInvocation = useCallback((tid: string) => {
    socketRef.current?.emit('cancel_invocation', { threadId: tid });
  }, []);

  return { socketRef, joinRoom, leaveRoom, syncRooms, cancelInvocation };
}
