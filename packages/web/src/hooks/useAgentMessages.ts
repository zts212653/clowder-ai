'use client';

import type { ReplyPreview } from '@cat-cafe/shared';
import { useCallback, useEffect, useRef } from 'react';
import { recordDebugEvent } from '@/debug/invocationEventDebug';
import { useChatStore } from '@/stores/chatStore';
import { compactToolResultDetail } from '@/utils/toolPreview';

/** Timeout for done(isFinal) - 5 minutes */
const DONE_TIMEOUT_MS = 5 * 60 * 1000;
/** Monotonic counter for collision-safe callback bubble IDs */
let cbSeq = 0;
const DEBUG_SKIP_FILE_CHANGE_UI = process.env.NEXT_PUBLIC_DEBUG_SKIP_FILE_CHANGE_UI === '1';

interface AgentMsg {
  type: string;
  catId: string;
  content?: string;
  error?: string;
  isFinal?: boolean;
  metadata?: { provider: string; model: string; sessionId?: string; usage?: import('../stores/chat-types').TokenUsage };
  /** Tool name (for 'tool_use' events from backend) */
  toolName?: string;
  /** Tool input params (for 'tool_use' events from backend) */
  toolInput?: Record<string, unknown>;
  /** Message origin: stream = CLI stdout (thinking), callback = MCP post_message (speech) */
  origin?: 'stream' | 'callback';
  /** Backend stored-message ID (set for callback post-message, used for rich_block correlation) */
  messageId?: string;
  /** F67: Whether this message @mentions the co-creator */
  mentionsUser?: boolean;
  /** F52: Cross-thread origin metadata */
  extra?: { crossPost?: { sourceThreadId: string; sourceInvocationId?: string } };
  /** F121: Reply-to message ID */
  replyTo?: string;
  /** F121: Server-hydrated reply preview */
  replyPreview?: ReplyPreview;
  /** F108: Invocation ID — distinguishes messages from concurrent invocations */
  invocationId?: string;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}

function safeJsonPreview(value: unknown, maxLength: number): string {
  try {
    const raw = JSON.stringify(value);
    return truncate(raw, maxLength);
  } catch {
    return '[unserializable input]';
  }
}

function findLatestActiveInvocationIdForCat(
  activeInvocations: Record<string, { catId: string; mode: string }> | undefined,
  catId: string,
): string | undefined {
  if (!activeInvocations) return undefined;
  const entries = Object.entries(activeInvocations);
  for (let i = entries.length - 1; i >= 0; i--) {
    const [invocationId, info] = entries[i]!;
    if (info.catId === catId) return invocationId;
  }
  return undefined;
}

/**
 * Hook for handling agent message streaming (parallel-aware).
 * Tracks active streams via Map<catId, ref> for simultaneous multi-cat output.
 *
 * Returns:
 * - handleAgentMessage: socket event handler
 * - handleStop: cancel handler for stop button
 * - resetRefs: cleanup for thread switching
 */
export function useAgentMessages() {
  const {
    addMessage,
    appendToMessage,
    appendToolEvent,
    appendRichBlock,
    replaceMessageId,
    patchMessage,
    removeMessage,
    setStreaming,
    setLoading,
    setHasActiveInvocation,
    removeActiveInvocation,
    addActiveInvocation,
    clearAllActiveInvocations,
    setIntentMode,
    setCatStatus,
    clearCatStatuses,
    setCatInvocation,
    setMessageUsage,
    setMessageMetadata,
    setMessageThinking,
    setMessageStreamInvocation,
    requestStreamCatchUp,
    replaceThreadTargetCats,
  } = useChatStore();

  /** Map<catId, { id: messageId, catId }> — one entry per active stream */
  const activeRefs = useRef<Map<string, { id: string; catId: string }>>(new Map());
  /** Track callback-replaced invocations so delayed stream chunks do not recreate ghost bubbles. */
  const replacedInvocationsRef = useRef<Map<string, string>>(new Map());

  /** #586 follow-up: Track just-finalized stream bubble per cat. Set on done when
   *  activeRefs entry existed, consumed by callback replacement or next invocation start.
   *  Prevents the greedy scan from matching arbitrary historical messages. */
  const finalizedStreamRef = useRef<Map<string, string>>(new Map());

  /** Bug C P2: Track whether stream data was received per cat (avoids false catch-up on callback-only flows) */
  const sawStreamDataRef = useRef<Set<string>>(new Set());

  /** F118 AC-C3: Pending timeout diagnostics keyed by catId to prevent cross-cat mismatch */
  const pendingTimeoutDiagRef = useRef<Map<string, Record<string, unknown>>>(new Map());

  /** Timeout ref for done(isFinal) reachability */
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Which thread the current timeout guard belongs to */
  const timeoutThreadRef = useRef<string | null>(null);

  /** Start or reset the done timeout */
  const resetTimeout = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    const timeoutThreadId = useChatStore.getState().currentThreadId;
    timeoutThreadRef.current = timeoutThreadId;
    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      timeoutThreadRef.current = null;
      const store = useChatStore.getState();
      const isActiveThreadTimeout = store.currentThreadId === timeoutThreadId;

      if (!isActiveThreadTimeout) {
        const threadState = store.getThreadState(timeoutThreadId);
        for (const message of threadState.messages) {
          if (message.type === 'assistant' && message.isStreaming) {
            store.setThreadMessageStreaming(timeoutThreadId, message.id, false);
          }
        }
        store.resetThreadInvocationState(timeoutThreadId);
        store.addMessageToThread(timeoutThreadId, {
          id: `sysinfo-timeout-${Date.now()}`,
          type: 'system',
          variant: 'info',
          content: '⏱ Response timed out. The operation may still be running in the background.',
          timestamp: Date.now(),
        });
        return;
      }

      // Timeout fired — stop loading and show system message
      setLoading(false);
      clearAllActiveInvocations();
      setIntentMode(null);
      clearCatStatuses();
      for (const ref of activeRefs.current.values()) {
        setStreaming(ref.id, false);
      }
      activeRefs.current.clear();
      addMessage({
        id: `sysinfo-timeout-${Date.now()}`,
        type: 'system',
        variant: 'info',
        content: '⏱ Response timed out. The operation may still be running in the background.',
        timestamp: Date.now(),
      });
    }, DONE_TIMEOUT_MS);
  }, [setLoading, clearAllActiveInvocations, setIntentMode, clearCatStatuses, setStreaming, addMessage]);

  /** Clear the timeout (called on done with isFinal) */
  const clearDoneTimeout = useCallback((threadId?: string) => {
    if (threadId && timeoutThreadRef.current && timeoutThreadRef.current !== threadId) {
      return;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      timeoutThreadRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      timeoutThreadRef.current = null;
    },
    [],
  );

  const getCurrentInvocationStateForCat = useCallback(
    (catId: string): { invocationId?: string; source: 'catInvocations' | 'activeInvocations' | 'none' } => {
      const state = useChatStore.getState();
      const direct = state.catInvocations?.[catId]?.invocationId;
      if (direct) {
        return { invocationId: direct, source: 'catInvocations' };
      }
      const active = findLatestActiveInvocationIdForCat(state.activeInvocations, catId);
      if (active) {
        return { invocationId: active, source: 'activeInvocations' };
      }
      return { source: 'none' };
    },
    [],
  );

  const recordLateBindBubbleCreate = useCallback((catId: string, messageId: string, invocationId?: string) => {
    if (!invocationId) return;
    recordDebugEvent({
      event: 'bubble_lifecycle',
      threadId: useChatStore.getState().currentThreadId,
      timestamp: Date.now(),
      action: 'create',
      reason: 'active_late_bind',
      catId,
      messageId,
      invocationId,
      origin: 'stream',
    });
  }, []);

  const getCurrentInvocationIdForCat = useCallback(
    (catId: string): string | undefined => {
      return getCurrentInvocationStateForCat(catId).invocationId;
    },
    [getCurrentInvocationStateForCat],
  );

  const maybeMigrateSequentialInvocationOwnership = useCallback(
    (nextCatId: string, invocationId: string) => {
      const store = useChatStore.getState();

      const activeInvocations = store.activeInvocations ?? {};
      const primarySlot = activeInvocations[invocationId];
      if (!primarySlot || primarySlot.catId === nextCatId) return;

      const hasExplicitNextCatSlot =
        Boolean(activeInvocations[`${invocationId}-${nextCatId}`]) ||
        Object.values(activeInvocations).some((slot) => slot.catId === nextCatId);
      if (hasExplicitNextCatSlot) return;

      // Serial handoff reuses the parent invocationId for follow-up cats. If the
      // previous cat's done(isFinal=false) is lost, the old primary slot would
      // stay pinned to the first cat forever. Rebind the slot at the moment the
      // next cat announces its invocation boundary so the eventual final done can
      // still clear the UI state.
      removeActiveInvocation(invocationId);
      addActiveInvocation(invocationId, nextCatId, primarySlot.mode, primarySlot.startedAt);

      const currentTargets = Array.isArray(store.targetCats) ? store.targetCats : [];
      if (store.currentThreadId && currentTargets.length === 1 && currentTargets[0] === primarySlot.catId) {
        replaceThreadTargetCats(store.currentThreadId, [nextCatId]);
      }
    },
    [addActiveInvocation, removeActiveInvocation, replaceThreadTargetCats],
  );

  const findRecoverableAssistantMessage = useCallback(
    (catId: string) => {
      const currentMessages = useChatStore.getState().messages;
      for (let i = currentMessages.length - 1; i >= 0; i--) {
        const msg = currentMessages[i];
        if (msg.type === 'assistant' && msg.catId === catId && msg.isStreaming) {
          return { id: msg.id, needsStreamingRestore: false };
        }
      }

      const invocationId = getCurrentInvocationIdForCat(catId);
      if (!invocationId) return null;

      for (let i = currentMessages.length - 1; i >= 0; i--) {
        const msg = currentMessages[i];
        if (msg.type !== 'assistant' || msg.catId !== catId) continue;
        if (msg.extra?.stream?.invocationId !== invocationId) continue;
        return { id: msg.id, needsStreamingRestore: !msg.isStreaming };
      }

      return null;
    },
    [getCurrentInvocationIdForCat],
  );

  const findCallbackReplacementTarget = useCallback((catId: string, invocationId: string): { id: string } | null => {
    const currentMessages = useChatStore.getState().messages;
    for (let i = currentMessages.length - 1; i >= 0; i -= 1) {
      const msg = currentMessages[i];
      if (
        msg?.type === 'assistant' &&
        msg.catId === catId &&
        msg.origin === 'stream' &&
        msg.extra?.stream?.invocationId === invocationId
      ) {
        return { id: msg.id };
      }
    }
    return null;
  }, []);

  const findInvocationlessStreamPlaceholder = useCallback((catId: string): { id: string } | null => {
    const currentMessages = useChatStore.getState().messages;
    const activeId = activeRefs.current.get(catId)?.id;

    if (activeId) {
      const activeMessage = currentMessages.find(
        (msg) =>
          msg.id === activeId &&
          msg.type === 'assistant' &&
          msg.catId === catId &&
          msg.origin === 'stream' &&
          !msg.extra?.stream?.invocationId,
      );
      if (activeMessage) {
        return { id: activeMessage.id };
      }
    }

    // First pass: find actively-streaming invocationless bubble
    for (let i = currentMessages.length - 1; i >= 0; i -= 1) {
      const msg = currentMessages[i];
      if (
        msg?.type === 'assistant' &&
        msg.catId === catId &&
        msg.origin === 'stream' &&
        msg.isStreaming &&
        !msg.extra?.stream?.invocationId
      ) {
        return { id: msg.id };
      }
    }

    // #586 follow-up: Check finalizedStreamRef — the done handler records the
    // exact message ID of the just-finalized stream bubble. This avoids the
    // greedy scan that could match arbitrary historical messages (P1 from review).
    const finalizedId = finalizedStreamRef.current.get(catId);
    if (finalizedId) {
      const finalized = currentMessages.find(
        (m) => m.id === finalizedId && m.type === 'assistant' && m.catId === catId && m.origin === 'stream',
      );
      if (finalized) {
        return { id: finalized.id };
      }
    }

    return null;
  }, []);

  const getOrRecoverActiveAssistantMessageId = useCallback(
    (catId: string, metadata?: AgentMsg['metadata'], options?: { ensureStreaming?: boolean }): string | null => {
      const currentMessages = useChatStore.getState().messages;
      const existing = activeRefs.current.get(catId);
      if (existing?.id) {
        const found = currentMessages.find((msg) => msg.id === existing.id && msg.type === 'assistant');
        if (found) {
          if (options?.ensureStreaming && !found.isStreaming) {
            setStreaming(found.id, true);
          }
          if (metadata) {
            setMessageMetadata(found.id, metadata);
          }
          return found.id;
        }
        activeRefs.current.delete(catId);
      }

      const recovered = findRecoverableAssistantMessage(catId);
      if (!recovered) return null;

      activeRefs.current.set(catId, { id: recovered.id, catId });
      if (options?.ensureStreaming && recovered.needsStreamingRestore) {
        setStreaming(recovered.id, true);
      }
      if (metadata) {
        setMessageMetadata(recovered.id, metadata);
      }
      return recovered.id;
    },
    [findRecoverableAssistantMessage, setMessageMetadata, setStreaming],
  );

  const ensureActiveAssistantMessage = useCallback(
    (catId: string, metadata?: AgentMsg['metadata']): string => {
      const existingId = getOrRecoverActiveAssistantMessageId(catId, metadata, { ensureStreaming: true });
      if (existingId) {
        return existingId;
      }

      const id = `msg-${Date.now()}-${catId}`;
      const invocation = getCurrentInvocationStateForCat(catId);
      const invocationId = invocation.invocationId;
      activeRefs.current.set(catId, { id, catId });
      addMessage({
        id,
        type: 'assistant',
        catId,
        content: '',
        origin: 'stream',
        ...(metadata ? { metadata } : {}),
        ...(invocationId ? { extra: { stream: { invocationId } } } : {}),
        timestamp: Date.now(),
        isStreaming: true,
      });
      if (invocation.source === 'activeInvocations') {
        recordLateBindBubbleCreate(catId, id, invocationId);
      }
      return id;
    },
    [addMessage, getCurrentInvocationStateForCat, getOrRecoverActiveAssistantMessageId, recordLateBindBubbleCreate],
  );

  const shouldSuppressLateStreamChunk = useCallback(
    (catId: string, invocationId?: string): boolean => {
      const replacedInvocationId = replacedInvocationsRef.current.get(catId);
      if (!replacedInvocationId) return false;

      const currentInvocationId = invocationId ?? getCurrentInvocationIdForCat(catId);
      if (currentInvocationId && currentInvocationId !== replacedInvocationId) {
        replacedInvocationsRef.current.delete(catId);
        return false;
      }

      recordDebugEvent({
        event: 'bubble_lifecycle',
        threadId: useChatStore.getState().currentThreadId,
        timestamp: Date.now(),
        action: 'drop',
        reason: 'late_stream_after_callback_replace',
        catId,
        invocationId: replacedInvocationId,
        origin: 'stream',
      });
      return true;
    },
    [getCurrentInvocationIdForCat],
  );

  const handleAgentMessage = useCallback(
    (msg: AgentMsg) => {
      // Reset timeout on any message (keeps timer alive during streaming)
      resetTimeout();

      if (msg.type === 'text' && msg.content) {
        if (msg.origin !== 'callback' && shouldSuppressLateStreamChunk(msg.catId, msg.invocationId)) {
          return;
        }
        setCatStatus(msg.catId, 'streaming');
        // F118: Clear liveness warning when cat resumes output
        setCatInvocation(msg.catId, { livenessWarning: undefined });
        if (msg.origin !== 'callback') {
          sawStreamDataRef.current.add(msg.catId);
        }

        if (msg.origin === 'callback') {
          const invocationId = msg.invocationId ?? getCurrentInvocationIdForCat(msg.catId);
          const hasExplicitInvocationId = !!msg.invocationId;
          const replacementTarget = invocationId
            ? (findCallbackReplacementTarget(msg.catId, invocationId) ??
              (hasExplicitInvocationId ? null : findInvocationlessStreamPlaceholder(msg.catId)))
            : findInvocationlessStreamPlaceholder(msg.catId);

          if (replacementTarget) {
            const finalId = msg.messageId ?? replacementTarget.id;
            if (finalId !== replacementTarget.id) {
              replaceMessageId(replacementTarget.id, finalId);
            }
            patchMessage(finalId, {
              content: msg.content,
              origin: 'callback',
              isStreaming: false,
              ...(msg.metadata ? { metadata: msg.metadata } : {}),
              ...(msg.extra?.crossPost ? { extra: { crossPost: msg.extra.crossPost } } : {}),
              ...(msg.mentionsUser ? { mentionsUser: true } : {}),
              ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
              ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
            });
            activeRefs.current.delete(msg.catId);
            // Consume the finalized ref — callback successfully replaced the bubble
            finalizedStreamRef.current.delete(msg.catId);
            if (invocationId) {
              replacedInvocationsRef.current.set(msg.catId, invocationId);
            }
          } else {
            // Use backend messageId when available for rich_block correlation (#83 P2)
            const id = msg.messageId ?? `msg-${Date.now()}-${msg.catId}-cb-${++cbSeq}`;
            const extraForAdd = {
              ...(msg.extra?.crossPost ? { crossPost: msg.extra.crossPost } : {}),
              ...(hasExplicitInvocationId && msg.invocationId ? { stream: { invocationId: msg.invocationId } } : {}),
            };
            addMessage({
              id,
              type: 'assistant',
              catId: msg.catId,
              content: msg.content,
              origin: 'callback',
              ...(msg.metadata ? { metadata: msg.metadata } : {}),
              ...(Object.keys(extraForAdd).length > 0 ? { extra: extraForAdd } : {}),
              ...(msg.mentionsUser ? { mentionsUser: true } : {}),
              ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
              ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
              timestamp: Date.now(),
            });
            // #586 Bug 1 (TD112): Callback created a new bubble because no stream
            // placeholder existed yet. Mark the invocation as replaced so that
            // late-arriving stream chunks for the same invocation are suppressed
            // instead of spawning a second bubble.
            const shouldLockReplacement =
              invocationId &&
              (!hasExplicitInvocationId || getCurrentInvocationIdForCat(msg.catId) === msg.invocationId);
            if (shouldLockReplacement) {
              replacedInvocationsRef.current.set(msg.catId, invocationId);
            }
          }
        } else {
          // CLI stream message (thinking): append to active stream bubble
          const messageId = getOrRecoverActiveAssistantMessageId(msg.catId, msg.metadata, { ensureStreaming: true });
          if (messageId) {
            appendToMessage(messageId, msg.content);
            if (msg.replyTo || msg.replyPreview) {
              patchMessage(messageId, {
                ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
                ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
              });
            }
          } else {
            // New stream message for this cat
            const id = `msg-${Date.now()}-${msg.catId}`;
            const invocation = getCurrentInvocationStateForCat(msg.catId);
            const invocationId = invocation.invocationId;
            activeRefs.current.set(msg.catId, { id, catId: msg.catId });
            addMessage({
              id,
              type: 'assistant',
              catId: msg.catId,
              content: msg.content,
              origin: 'stream',
              ...(msg.metadata ? { metadata: msg.metadata } : {}),
              ...(invocationId ? { extra: { stream: { invocationId } } } : {}),
              ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
              ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
              timestamp: Date.now(),
              isStreaming: true,
            });
            if (invocation.source === 'activeInvocations') {
              recordLateBindBubbleCreate(msg.catId, id, invocationId);
            }
          }
        }
      } else if (msg.type === 'tool_use') {
        setCatStatus(msg.catId, 'streaming');
        sawStreamDataRef.current.add(msg.catId);
        const toolName = msg.toolName ?? 'unknown';
        const detail = msg.toolInput ? safeJsonPreview(msg.toolInput, 200) : undefined;
        const isFileChange = toolName === 'file_change';
        if (isFileChange) {
          console.info('[agent_message] file_change tool_use received', {
            catId: msg.catId,
            activeRefCount: activeRefs.current.size,
            skipUi: DEBUG_SKIP_FILE_CHANGE_UI,
            detail: detail ?? null,
          });
          if (DEBUG_SKIP_FILE_CHANGE_UI) {
            console.warn('[agent_message] file_change UI append skipped', {
              catId: msg.catId,
              reason: 'NEXT_PUBLIC_DEBUG_SKIP_FILE_CHANGE_UI=1',
            });
            return;
          }
        }

        const messageId = ensureActiveAssistantMessage(msg.catId, msg.metadata);

        appendToolEvent(messageId, {
          id: `tool-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'tool_use',
          label: `${msg.catId} → ${toolName}`,
          ...(detail ? { detail } : {}),
          timestamp: Date.now(),
        });
        if (isFileChange) {
          console.info('[agent_message] file_change tool_use appended', {
            catId: msg.catId,
            messageId,
            activeRefCount: activeRefs.current.size,
          });
        }
      } else if (msg.type === 'tool_result') {
        setCatStatus(msg.catId, 'streaming');
        const messageId = ensureActiveAssistantMessage(msg.catId, msg.metadata);

        const detail = compactToolResultDetail(msg.content ?? '');
        appendToolEvent(messageId, {
          id: `toolr-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          type: 'tool_result',
          label: `${msg.catId} ← result`,
          detail,
          timestamp: Date.now(),
        });
      } else if (msg.type === 'done') {
        setCatStatus(msg.catId, 'done');
        const currentProgress = useChatStore.getState().catInvocations?.[msg.catId]?.taskProgress;
        if (currentProgress?.tasks?.length) {
          setCatInvocation(msg.catId, {
            taskProgress: {
              ...currentProgress,
              snapshotStatus: currentProgress.snapshotStatus === 'interrupted' ? 'interrupted' : 'completed',
              lastUpdate: Date.now(),
            },
          });
        }
        const messageId = getOrRecoverActiveAssistantMessageId(msg.catId);
        if (messageId) {
          setStreaming(messageId, false);
          // #586 follow-up: Record the finalized bubble so callback can find it
          // even after isStreaming=false + activeRefs cleared. Unlike a greedy
          // scan, this is scoped to the exact just-finalized message only.
          finalizedStreamRef.current.set(msg.catId, messageId);
          activeRefs.current.delete(msg.catId);
        }
        // Bugfix: clear stale invocationId so findRecoverableAssistantMessage
        // can't match this finalized message when the next invocation starts.
        // Without this, a race (new text before invocation_created) appends to
        // the old bubble, causing messages to visually merge until page refresh.
        // Cloud review P2: Do NOT clear taskProgress here — lines 552-559 already
        // transition it to 'completed'/'interrupted'. Wiping it would remove the
        // cat from PlanBoardPanel and defeat clearCatStatuses' snapshot preservation.
        setCatInvocation(msg.catId, { invocationId: undefined });
        // Always remove the finishing cat's invocation slot, regardless of isFinal.
        // isFinal=false means "more cats coming" but THIS cat is done — its slot must go.
        // Without this, non-final cats (e.g. 缅因猫 in 缅因猫→布偶猫 sequence) leave
        // orphan slots that keep ThreadExecutionBar showing "执行中" until F5 refresh.
        if (msg.invocationId) {
          const slotState = useChatStore.getState();
          const primarySlot = slotState.activeInvocations[msg.invocationId];
          if (primarySlot?.catId === msg.catId) {
            removeActiveInvocation(msg.invocationId);
          }
          removeActiveInvocation(`${msg.invocationId}-${msg.catId}`);
          // Hydrated synthetic IDs (hydrated-${threadId}-${catId}) won't match the real
          // invocationId from the server. Only clean up hydrated- prefixed orphans to
          // avoid accidentally deleting a NEW invocation's slot during same-cat preempt
          // (where old done arrives after new invocation starts).
          const stateAfter = useChatStore.getState();
          const orphan = findLatestActiveInvocationIdForCat(stateAfter.activeInvocations, msg.catId);
          if (orphan?.startsWith('hydrated-')) {
            removeActiveInvocation(orphan);
          }
        } else {
          const catSlot = findLatestActiveInvocationIdForCat(useChatStore.getState().activeInvocations, msg.catId);
          if (catSlot) {
            removeActiveInvocation(catSlot);
          } else if (Object.keys(useChatStore.getState().activeInvocations ?? {}).length === 0) {
            // Only reset global flag when no active invocations remain.
            // Without this guard, a non-final cat with no slot would incorrectly
            // clear hasActiveInvocation while other cats are still running.
            setHasActiveInvocation(false);
          }
        }
        if (msg.isFinal) {
          // F108 P1 fix: Only clear global state when the LAST active invocation ends.
          // During concurrent multi-cat execution, cancelling one cat must not wipe
          // the execution state (loading/intentMode/catStatuses) of remaining cats.
          const remainingInvocations = Object.keys(useChatStore.getState().activeInvocations ?? {}).length;
          if (remainingInvocations === 0) {
            clearDoneTimeout();
            setLoading(false);
            setIntentMode(null);
            clearCatStatuses();
          }
          // Note: do NOT clear replacedInvocationsRef here. The suppression guard
          // is designed to persist until a *different* invocationId is observed
          // (F123 PR #465, symptom-fixture-matrix.md:23). Clearing on done(isFinal)
          // would allow reordered stale chunks to recreate ghost bubbles.
          // Bug C safety net: if done(isFinal) arrived but no streaming bubble
          // was ever created for this cat, events were lost (socket transport
          // drop, micro-disconnect, dual-pointer guard mismatch, etc.).
          // Request a history catch-up so the user sees the response without F5.
          // Unconditional: covers ghost-message scenario where ALL events
          // (stream + callback) were lost during disconnect (#266, #276).
          if (!messageId) {
            const tid = useChatStore.getState().currentThreadId;
            console.warn('[stream-catchup] done(isFinal) with no active bubble — requesting catch-up', {
              catId: msg.catId,
              threadId: tid,
              hadStreamData: sawStreamDataRef.current.has(msg.catId),
            });
            if (tid) {
              requestStreamCatchUp(tid);
            }
          }
          sawStreamDataRef.current.delete(msg.catId);
        }
      } else if (msg.type === 'a2a_handoff') {
        addMessage({
          id: `a2a-${Date.now()}-${msg.catId}`,
          type: 'system',
          variant: 'info',
          content: msg.content ?? '',
          timestamp: Date.now(),
        });
      } else if (msg.type === 'system_info') {
        sawStreamDataRef.current.add(msg.catId);
        // System notifications: budget warnings, cancel feedback, A2A follow-up hints, invocation metrics
        let sysContent = msg.content ?? '';
        let sysVariant: 'info' | 'a2a_followup' = 'info';
        let consumed = false;
        try {
          const parsed = JSON.parse(sysContent);
          if (parsed?.type === 'a2a_followup_available') {
            const mentions = parsed.mentions as Array<{ catId: string; mentionedBy: string }>;
            sysContent = mentions.map((m) => `${m.mentionedBy} @了 ${m.catId}`).join('、');
            sysVariant = 'a2a_followup';
          } else if (parsed?.type === 'invocation_created') {
            // New invocation boundary: clear stale task snapshot + finalized ref for this cat.
            // #586: Without clearing finalizedStreamRef here, a stale ref from the
            // previous invocation could cause the next callback to overwrite the old message.
            const targetCatId = parsed.catId ?? msg.catId;
            finalizedStreamRef.current.delete(targetCatId);
            const invocationId = typeof parsed.invocationId === 'string' ? parsed.invocationId : undefined;
            if (targetCatId && invocationId) {
              setCatInvocation(targetCatId, {
                invocationId,
                startedAt: Date.now(),
                taskProgress: {
                  tasks: [],
                  lastUpdate: Date.now(),
                  snapshotStatus: 'running',
                  lastInvocationId: invocationId,
                },
              });
              const targetId = getOrRecoverActiveAssistantMessageId(targetCatId);
              if (targetId) {
                setMessageStreamInvocation(targetId, invocationId);
              }
              maybeMigrateSequentialInvocationOwnership(targetCatId, invocationId);
              consumed = true;
            }
          } else if (parsed?.type === 'invocation_metrics') {
            // Store metrics silently — don't show as system message
            if (parsed.kind === 'session_started') {
              setCatInvocation(msg.catId, {
                sessionId: parsed.sessionId,
                invocationId: parsed.invocationId,
                startedAt: Date.now(),
                taskProgress: { tasks: [], lastUpdate: 0 },
                ...(parsed.sessionSeq !== undefined ? { sessionSeq: parsed.sessionSeq, sessionSealed: false } : {}),
              });
            } else if (parsed.kind === 'invocation_complete') {
              setCatInvocation(msg.catId, {
                durationMs: parsed.durationMs,
                sessionId: parsed.sessionId,
              });
            }
            consumed = true;
          } else if (parsed?.type === 'invocation_usage') {
            // F8: Store token usage silently — don't show as system message
            setCatInvocation(msg.catId, {
              usage: parsed.usage,
            });
            // Also persist usage on the cat's last assistant message (message-scoped)
            const ref = activeRefs.current.get(msg.catId);
            if (ref) {
              setMessageUsage(ref.id, parsed.usage);
            }
            consumed = true;
          } else if (parsed?.type === 'context_briefing') {
            // F148 Phase E: Insert briefing card into chat store for immediate display
            const sm = parsed.storedMessage as
              | { id: string; content: string; origin: string; timestamp: number; extra?: Record<string, unknown> }
              | undefined;
            if (sm?.id) {
              addMessage({
                id: sm.id,
                type: 'system',
                content: sm.content ?? '',
                origin: (sm.origin as 'briefing') ?? 'briefing',
                timestamp: sm.timestamp ?? Date.now(),
                ...(sm.extra ? { extra: sm.extra } : {}),
              });
            }
            consumed = true;
          } else if (parsed?.type === 'context_health') {
            // F24: Store context health silently
            const targetCatId = parsed.catId ?? msg.catId;
            if (targetCatId) {
              setCatInvocation(targetCatId, {
                contextHealth: parsed.health,
              });
              consumed = true;
            }
          } else if (parsed?.type === 'rate_limit') {
            // F045: Telemetry only — don't show as chat bubble
            const targetCatId = parsed.catId ?? msg.catId;
            if (targetCatId) {
              setCatInvocation(targetCatId, {
                rateLimit: {
                  ...(typeof parsed.utilization === 'number' ? { utilization: parsed.utilization } : {}),
                  ...(typeof parsed.resetsAt === 'string' ? { resetsAt: parsed.resetsAt } : {}),
                },
              });
            }
            consumed = true;
          } else if (parsed?.type === 'compact_boundary') {
            // F045: Telemetry only — don't show as chat bubble
            const targetCatId = parsed.catId ?? msg.catId;
            if (targetCatId) {
              setCatInvocation(targetCatId, {
                compactBoundary: {
                  ...(typeof parsed.preTokens === 'number' ? { preTokens: parsed.preTokens } : {}),
                },
              });
            }
            consumed = true;
          } else if (parsed?.type === 'task_progress') {
            // F26: Store task progress silently
            const targetCatId = parsed.catId ?? msg.catId;
            const currentInvocationId =
              typeof parsed.invocationId === 'string'
                ? parsed.invocationId
                : useChatStore.getState().catInvocations?.[targetCatId]?.invocationId;
            const tasks = (parsed.tasks ?? []) as import('../stores/chat-types').TaskProgressItem[];
            setCatInvocation(targetCatId, {
              taskProgress: {
                tasks,
                lastUpdate: Date.now(),
                snapshotStatus: 'running',
                ...(currentInvocationId ? { lastInvocationId: currentInvocationId } : {}),
              },
            });
            consumed = true;
          } else if (parsed?.type === 'web_search') {
            // F045: web_search tool event (privacy: no query, count only) — render as ToolEvent, not raw JSON
            setCatStatus(msg.catId, 'streaming');
            const count = typeof parsed.count === 'number' ? parsed.count : 1;
            const messageId = ensureActiveAssistantMessage(msg.catId, msg.metadata);

            appendToolEvent(messageId, {
              id: `toolws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              type: 'tool_use',
              label: `${msg.catId} → web_search${count > 1 ? ` x${count}` : ''}`,
              timestamp: Date.now(),
            });
            consumed = true;
          } else if (parsed?.type === 'thinking') {
            // F045: Embed thinking into the current assistant bubble (like Claude Code)
            const thinkingText = parsed.text ?? '';
            if (thinkingText) {
              const messageId = ensureActiveAssistantMessage(msg.catId, msg.metadata);
              setMessageThinking(messageId, thinkingText);
            }
            consumed = true;
          } else if (parsed?.type === 'liveness_warning') {
            // F118 Phase C: Liveness warning — update cat status + invocation snapshot
            const level = parsed.level as 'alive_but_silent' | 'suspected_stall';
            setCatStatus(msg.catId, level);
            setCatInvocation(msg.catId, {
              livenessWarning: {
                level,
                state: parsed.state as 'active' | 'busy-silent' | 'idle-silent' | 'dead',
                silenceDurationMs: parsed.silenceDurationMs as number,
                cpuTimeMs: typeof parsed.cpuTimeMs === 'number' ? parsed.cpuTimeMs : undefined,
                processAlive: parsed.processAlive as boolean,
                receivedAt: Date.now(),
              },
            });
            consumed = true;
          } else if (parsed?.type === 'timeout_diagnostics') {
            // F118 AC-C3: Store diagnostics keyed by catId to prevent cross-cat mismatch
            if (msg.catId) {
              pendingTimeoutDiagRef.current.set(msg.catId, parsed as Record<string, unknown>);
            }
            consumed = true;
          } else if (parsed?.type === 'warning') {
            // F045: item-level warning — render as readable system message (avoid raw JSON blob)
            const warningText = typeof parsed.message === 'string' ? parsed.message : '';
            sysContent = warningText ? `⚠️ ${warningText}` : '⚠️ Warning';
            sysVariant = 'info';
          } else if (parsed?.type === 'governance_blocked') {
            const projectPath = typeof parsed.projectPath === 'string' ? parsed.projectPath : '';
            const reasonKind = (parsed.reasonKind as string) ?? 'needs_bootstrap';
            const invId = typeof parsed.invocationId === 'string' ? parsed.invocationId : undefined;
            const existingBlocked = useChatStore
              .getState()
              .messages.find(
                (m) => m.variant === 'governance_blocked' && m.extra?.governanceBlocked?.projectPath === projectPath,
              );
            if (existingBlocked) {
              removeMessage(existingBlocked.id);
            }
            addMessage({
              id: `gov-blocked-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              type: 'system',
              variant: 'governance_blocked',
              content: `项目 ${projectPath} ${reasonKind === 'needs_bootstrap' ? '尚未初始化治理' : '治理状态异常'}`,
              timestamp: Date.now(),
              extra: {
                governanceBlocked: {
                  projectPath,
                  reasonKind: reasonKind as 'needs_bootstrap' | 'needs_confirmation' | 'files_missing',
                  invocationId: invId,
                },
              },
            });
            consumed = true;
          } else if (parsed?.type === 'strategy_allow_compress' || parsed?.type === 'resume_failure_stats') {
            // Internal telemetry — suppress to avoid raw JSON bubbles
            consumed = true;
          } else if (parsed?.type === 'silent_completion') {
            // Bugfix: silent-exit — cat ran tools but produced no text response
            const detail = typeof parsed.detail === 'string' ? parsed.detail : '';
            sysContent = detail || `${msg.catId} completed without a text response.`;
          } else if (parsed?.type === 'invocation_preempted') {
            // Bugfix: silent-exit — invocation was superseded by a newer request
            sysContent = 'This response was superseded by a newer request.';
          } else if (parsed?.type === 'rich_block') {
            // F22: Append rich block — prefer messageId correlation (#83 P2), fallback to activeRefs
            let targetId: string | undefined;

            // P2 fix: use messageId from callback post-message path for precise correlation
            if (parsed.messageId) {
              const found = useChatStore.getState().messages.find((m) => m.id === parsed.messageId);
              if (found) targetId = found.id;
            }

            // Bugfix: standalone create_rich_block (no messageId) — prefer most recent
            // callback message from this cat over the active streaming message.
            // Without this, blocks land on the CLI streaming bubble instead of the
            // preceding post_message bubble, showing raw JSON until page refresh.
            // Guard: if the most recent assistant message from this cat is a streaming
            // message, skip callback lookup — the block likely came from the CLI stream
            // (e.g. codex-event-transform image extraction), not a MCP callback.
            if (!targetId) {
              const currentMessages = useChatStore.getState().messages;
              for (let i = currentMessages.length - 1; i >= 0; i--) {
                const m = currentMessages[i];
                if (m.type !== 'assistant' || m.catId !== msg.catId) continue;
                // If we hit an active streaming message first, callback is stale — stop
                if (m.origin === 'stream' && m.isStreaming) break;
                if (m.origin === 'callback') {
                  targetId = m.id;
                  break;
                }
              }
            }

            if (!targetId) {
              // Final fallback: recover the active stream bubble before creating a placeholder.
              targetId = ensureActiveAssistantMessage(msg.catId, msg.metadata);
            }

            if (parsed.block) {
              appendRichBlock(targetId, parsed.block);
            }
            consumed = true;
          } else if (parsed?.type === 'session_seal_requested') {
            // F24 Phase B: Session sealed — update session info + show notification
            setCatInvocation(parsed.catId, {
              sessionSeq: parsed.sessionSeq,
              sessionSealed: true,
            });
            const pct = parsed.healthSnapshot?.fillRatio ? Math.round(parsed.healthSnapshot.fillRatio * 100) : '?';
            sysContent = `${parsed.catId} 的会话 #${parsed.sessionSeq} 已封存（上下文 ${pct}%），下次调用将自动创建新会话`;
          }
        } catch {
          /* not JSON, use raw content */
        }
        if (!consumed) {
          addMessage({
            id: `sysinfo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: 'system',
            variant: sysVariant,
            content: sysContent,
            timestamp: Date.now(),
          });
        }
      } else if (msg.type === 'error') {
        setCatStatus(msg.catId, 'error');
        const currentProgress = useChatStore.getState().catInvocations?.[msg.catId]?.taskProgress;
        if (currentProgress?.tasks?.length) {
          setCatInvocation(msg.catId, {
            taskProgress: {
              ...currentProgress,
              snapshotStatus: 'interrupted',
              interruptReason: msg.error ?? 'Unknown error',
              lastUpdate: Date.now(),
            },
          });
        }
        const messageId = getOrRecoverActiveAssistantMessageId(msg.catId);
        if (messageId) {
          setStreaming(messageId, false);
          activeRefs.current.delete(msg.catId);
        }
        // F118 AC-C3: Attach pending timeout diagnostics matched by catId
        const timeoutDiag = msg.catId ? (pendingTimeoutDiagRef.current.get(msg.catId) ?? null) : null;
        if (msg.catId) pendingTimeoutDiagRef.current.delete(msg.catId);

        addMessage({
          id: `err-${Date.now()}-${msg.catId}`,
          type: 'system',
          variant: 'error',
          catId: msg.catId,
          content: (() => {
            const base = `Error: ${msg.error ?? 'Unknown error'}`;
            try {
              const meta = JSON.parse(msg.content ?? '{}');
              const subtype = meta?.errorSubtype;
              if (subtype) {
                const labels: Record<string, string> = {
                  error_max_turns: '超出 turn 限制',
                  error_max_budget_usd: '预算用尽',
                  error_during_execution: '运行时错误',
                  error_max_structured_output_retries: '结构化输出重试超限',
                };
                return labels[subtype] ? `${base} (${labels[subtype]})` : base;
              }
            } catch {
              /* no subtype */
            }
            return base;
          })(),
          timestamp: Date.now(),
          ...(timeoutDiag
            ? {
                extra: {
                  timeoutDiagnostics: {
                    silenceDurationMs: timeoutDiag.silenceDurationMs as number,
                    processAlive: timeoutDiag.processAlive as boolean,
                    lastEventType: timeoutDiag.lastEventType as string | undefined,
                    firstEventAt: timeoutDiag.firstEventAt as number | undefined,
                    lastEventAt: timeoutDiag.lastEventAt as number | undefined,
                    cliSessionId: timeoutDiag.cliSessionId as string | undefined,
                    invocationId: timeoutDiag.invocationId as string | undefined,
                    rawArchivePath: timeoutDiag.rawArchivePath as string | undefined,
                  },
                },
              }
            : {}),
        });
        // Only stop loading on isFinal; size===0 would false-positive in serial gaps
        if (msg.isFinal) {
          // F108: clear this cat's invocation slot on terminal error
          if (msg.invocationId) {
            // F869: Same multi-cat slot-aware cleanup as the done(isFinal) path.
            const slotState = useChatStore.getState();
            const primarySlot = slotState.activeInvocations[msg.invocationId];
            if (primarySlot?.catId === msg.catId) {
              removeActiveInvocation(msg.invocationId);
            }
            removeActiveInvocation(`${msg.invocationId}-${msg.catId}`);
            // Hydrated-only orphan cleanup (same as done path).
            const stateAfter = useChatStore.getState();
            const orphan = findLatestActiveInvocationIdForCat(stateAfter.activeInvocations, msg.catId);
            if (orphan?.startsWith('hydrated-')) {
              removeActiveInvocation(orphan);
            }
          } else {
            const catSlot = findLatestActiveInvocationIdForCat(useChatStore.getState().activeInvocations, msg.catId);
            if (catSlot) {
              removeActiveInvocation(catSlot);
            } else {
              setHasActiveInvocation(false);
            }
          }
          // F108 P1 fix: Only clear global state when the LAST active invocation ends.
          const remainingInvocations = Object.keys(useChatStore.getState().activeInvocations ?? {}).length;
          if (remainingInvocations === 0) {
            clearDoneTimeout();
            setLoading(false);
            setIntentMode(null);
            clearCatStatuses();
            // Clear ALL remaining streaming refs — global catch uses catId='opus' which may
            // not match the cat that was actually running (e.g. codex/gemini)
            for (const ref of activeRefs.current.values()) {
              setStreaming(ref.id, false);
            }
            activeRefs.current.clear();
          }
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      addMessage,
      appendToMessage,
      appendToolEvent,
      appendRichBlock,
      setStreaming,
      setLoading,
      removeActiveInvocation,
      setIntentMode,
      setCatStatus,
      clearCatStatuses,
      setCatInvocation,
      setMessageThinking,
      setMessageStreamInvocation,
      replaceMessageId,
      patchMessage,
      resetTimeout,
      clearDoneTimeout,
      findCallbackReplacementTarget,
      findInvocationlessStreamPlaceholder,
      getCurrentInvocationIdForCat,
      getCurrentInvocationStateForCat,
      getOrRecoverActiveAssistantMessageId,
      ensureActiveAssistantMessage,
      maybeMigrateSequentialInvocationOwnership,
      recordLateBindBubbleCreate,
      shouldSuppressLateStreamChunk,
      setHasActiveInvocation,
      setMessageUsage,
      requestStreamCatchUp,
      removeMessage,
    ],
  );

  const handleStop = useCallback(
    (cancelFn: (threadId: string, catId?: string) => void, threadId: string) => {
      const store = useChatStore.getState();
      // When exactly one cat is active, cancel only that cat to avoid
      // thread-level cancelAll accidentally killing other cats.
      const activeSlots = Object.values(store.getThreadState(threadId).activeInvocations ?? {});
      const singleCatId = activeSlots.length === 1 ? activeSlots[0]?.catId : undefined;
      cancelFn(threadId, singleCatId);
      const isActiveThreadStop = threadId === store.currentThreadId;

      if (!isActiveThreadStop) {
        clearDoneTimeout(threadId);
        const threadState = store.getThreadState(threadId);
        for (const message of threadState.messages) {
          if (message.type === 'assistant' && message.isStreaming) {
            store.setThreadMessageStreaming(threadId, message.id, false);
          }
        }
        store.resetThreadInvocationState(threadId);
        return;
      }

      clearDoneTimeout(threadId);
      setLoading(false);
      // F108: stop clears all invocation slots (user cancel-all)
      clearAllActiveInvocations();
      setIntentMode(null);
      clearCatStatuses();
      // Stop all active streams
      for (const ref of activeRefs.current.values()) {
        setStreaming(ref.id, false);
      }
      activeRefs.current.clear();
      replacedInvocationsRef.current.clear();
    },
    [setLoading, clearAllActiveInvocations, setStreaming, setIntentMode, clearCatStatuses, clearDoneTimeout],
  );

  const resetRefs = useCallback(() => {
    activeRefs.current.clear();
    replacedInvocationsRef.current.clear();
    // clowder-ai#378: clear ALL ref maps so stale IDs from prior invocation
    // don't cause findInvocationlessStreamPlaceholder to match old bubbles.
    // Without this, scheduler callbacks (no invocationId) could patch a
    // finalized bubble from the previous invocation after thread switch.
    finalizedStreamRef.current.clear();
    sawStreamDataRef.current.clear();
  }, []);

  return { handleAgentMessage, handleStop, resetRefs, resetTimeout, clearDoneTimeout };
}
