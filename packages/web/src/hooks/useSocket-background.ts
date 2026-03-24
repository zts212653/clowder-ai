import { recordDebugEvent } from '@/debug/invocationEventDebug';
import type { CatStatusType } from '@/stores/chat-types';
import { compactToolResultDetail } from '@/utils/toolPreview';
import type {
  ActiveRoutedAgentMessage,
  BackgroundAgentMessage,
  BackgroundStreamRef,
  HandleBackgroundMessageOptions,
} from './useSocket-background.types';
import { consumeBackgroundSystemInfo } from './useSocket-background-system-info';

export type {
  ActiveRoutedAgentMessage,
  BackgroundAgentMessage,
  BackgroundStoreLike,
  BackgroundStreamRef,
  BackgroundToastInput,
  HandleBackgroundMessageOptions,
} from './useSocket-background.types';

const STATUS_MAP: Record<string, CatStatusType> = {
  streaming: 'streaming',
  thinking: 'pending',
  done: 'done',
};

function getStreamKey(msg: Pick<BackgroundAgentMessage, 'threadId' | 'catId'>): string {
  return `${msg.threadId}::${msg.catId}`;
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

function shouldClearBackgroundRefOnActiveEvent(msg: ActiveRoutedAgentMessage): boolean {
  if (!msg.threadId) return false;
  if (msg.type === 'done') return true;
  if (msg.type === 'error') return msg.isFinal === true;
  if (msg.type === 'text' && msg.isFinal) return true;
  return false;
}

function getThreadInvocationId(
  msg: Pick<BackgroundAgentMessage, 'threadId' | 'catId'>,
  options: HandleBackgroundMessageOptions,
): string | undefined {
  const threadState = options.store.getThreadState(msg.threadId);
  return (
    threadState.catInvocations[msg.catId]?.invocationId ??
    findLatestActiveInvocationIdForCat(threadState.activeInvocations, msg.catId)
  );
}

export function clearBackgroundStreamRefForActiveEvent(
  msg: ActiveRoutedAgentMessage,
  bgStreamRefs: Map<string, BackgroundStreamRef>,
): void {
  if (!shouldClearBackgroundRefOnActiveEvent(msg) || !msg.threadId) return;
  bgStreamRefs.delete(`${msg.threadId}::${msg.catId}`);
}

function stopTrackedStream(
  streamKey: string,
  msg: BackgroundAgentMessage,
  options: HandleBackgroundMessageOptions,
): BackgroundStreamRef | undefined {
  const existing = options.bgStreamRefs.get(streamKey);
  if (!existing) return undefined;
  options.store.setThreadMessageStreaming(msg.threadId, existing.id, false);
  // #586 follow-up: Record finalized bubble ID so callback can find it
  // after bgStreamRefs is cleared and isStreaming is false.
  options.finalizedBgRefs.set(streamKey, existing.id);
  options.bgStreamRefs.delete(streamKey);
  return existing;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function safeJsonPreview(value: unknown, maxLength: number): string {
  try {
    return truncate(JSON.stringify(value), maxLength);
  } catch {
    return '[unserializable input]';
  }
}

function addBackgroundSystemMessage(
  msg: BackgroundAgentMessage,
  options: HandleBackgroundMessageOptions,
  content: string,
  variant: 'info' | 'a2a_followup' = 'info',
): void {
  options.store.addMessageToThread(msg.threadId, {
    id: `bg-sys-${msg.timestamp}-${msg.catId}-${options.nextBgSeq()}`,
    type: 'system',
    variant,
    catId: msg.catId,
    content,
    timestamp: msg.timestamp,
  });
}

/**
 * Recover an existing streaming assistant message from the thread state.
 * This handles the active→background transition: when the user switches threads,
 * activeRefs are cleared but the streaming message still exists in the store.
 * Instead of creating a duplicate bubble, we adopt the existing one into bgStreamRefs.
 */
function recoverStreamingMessage(
  msg: BackgroundAgentMessage,
  streamKey: string,
  options: HandleBackgroundMessageOptions,
): string | undefined {
  const threadMessages = options.store.getThreadState(msg.threadId).messages;
  for (let i = threadMessages.length - 1; i >= 0; i--) {
    const m = threadMessages[i];
    if (m.type === 'assistant' && m.catId === msg.catId && m.isStreaming) {
      options.bgStreamRefs.set(streamKey, { id: m.id, threadId: msg.threadId, catId: msg.catId });
      recordDebugEvent({
        event: 'bubble_lifecycle',
        threadId: msg.threadId,
        timestamp: msg.timestamp,
        action: 'recover',
        reason: 'background_ref_lost',
        catId: msg.catId,
        messageId: m.id,
        invocationId: m.extra?.stream?.invocationId,
        origin: 'stream',
      });
      return m.id;
    }
  }
  return undefined;
}

function findBackgroundCallbackReplacementTarget(
  msg: BackgroundAgentMessage,
  options: HandleBackgroundMessageOptions,
): { id: string; invocationId: string | null } | null {
  const invocationId = msg.invocationId ?? getThreadInvocationId(msg, options);

  const threadMessages = options.store.getThreadState(msg.threadId).messages;

  // Try invocationId-based match first
  if (invocationId) {
    for (let i = threadMessages.length - 1; i >= 0; i -= 1) {
      const m = threadMessages[i];
      if (
        m?.type === 'assistant' &&
        m.catId === msg.catId &&
        m.origin === 'stream' &&
        m.extra?.stream?.invocationId === invocationId
      ) {
        return { id: m.id, invocationId };
      }
    }
  }

  // #586 Bug 1: Fallback — find invocationless stream placeholder from the same cat.
  // Background system-info creates bg-rich/bg-think placeholders without invocationId;
  // without this fallback, callback creates a duplicate bubble alongside the placeholder.
  // #586 P1-2 fix: Return real invocationId (may be null) — callers must guard
  // against null before writing to replacedInvocations. Using a pseudo ID would
  // cause shouldSuppressLateBackgroundStreamChunk to permanently drop future
  // invocationless stream chunks.
  // First pass: actively-streaming invocationless placeholder
  for (let i = threadMessages.length - 1; i >= 0; i -= 1) {
    const m = threadMessages[i];
    if (
      m?.type === 'assistant' &&
      m.catId === msg.catId &&
      m.origin === 'stream' &&
      m.isStreaming &&
      !m.extra?.stream?.invocationId
    ) {
      return { id: m.id, invocationId: invocationId ?? null };
    }
  }
  // #586 follow-up: Check finalizedBgRefs — the done handler records the exact
  // message ID of the just-finalized stream bubble. This avoids the greedy scan
  // that could match arbitrary historical messages (P1 from review).
  const streamKey = `${msg.threadId}::${msg.catId}`;
  const finalizedId = options.finalizedBgRefs.get(streamKey);
  if (finalizedId) {
    const finalized = threadMessages.find(
      (m) => m.id === finalizedId && m.type === 'assistant' && m.catId === msg.catId && m.origin === 'stream',
    );
    if (finalized) {
      return { id: finalized.id, invocationId: invocationId ?? null };
    }
  }

  return null;
}

function shouldSuppressLateBackgroundStreamChunk(
  msg: BackgroundAgentMessage,
  streamKey: string,
  options: HandleBackgroundMessageOptions,
): boolean {
  const replacedInvocationId = options.replacedInvocations.get(streamKey);
  if (!replacedInvocationId) return false;

  const currentInvocationId = msg.invocationId ?? getThreadInvocationId(msg, options);
  if (currentInvocationId && currentInvocationId !== replacedInvocationId) {
    options.replacedInvocations.delete(streamKey);
    return false;
  }

  recordDebugEvent({
    event: 'bubble_lifecycle',
    threadId: msg.threadId,
    timestamp: msg.timestamp,
    action: 'drop',
    reason: 'late_stream_after_callback_replace',
    catId: msg.catId,
    invocationId: replacedInvocationId,
    origin: 'stream',
  });
  return true;
}

function ensureBackgroundAssistantMessage(
  msg: BackgroundAgentMessage,
  streamKey: string,
  existing: BackgroundStreamRef | undefined,
  options: HandleBackgroundMessageOptions,
): string {
  if (existing?.id) {
    if (msg.metadata) {
      options.store.setThreadMessageMetadata(msg.threadId, existing.id, msg.metadata);
    }
    return existing.id;
  }

  // Active→background transition recovery: find existing streaming bubble
  const recoveredId = recoverStreamingMessage(msg, streamKey, options);
  if (recoveredId) {
    if (msg.metadata) {
      options.store.setThreadMessageMetadata(msg.threadId, recoveredId, msg.metadata);
    }
    return recoveredId;
  }

  const messageId = `bg-tool-${msg.timestamp}-${msg.catId}-${options.nextBgSeq()}`;
  const invocationId = getThreadInvocationId(msg, options);
  options.bgStreamRefs.set(streamKey, { id: messageId, threadId: msg.threadId, catId: msg.catId });
  options.store.addMessageToThread(msg.threadId, {
    id: messageId,
    type: 'assistant',
    catId: msg.catId,
    content: '',
    ...(msg.metadata ? { metadata: msg.metadata } : {}),
    ...(invocationId ? { extra: { stream: { invocationId } } } : {}),
    timestamp: msg.timestamp,
    isStreaming: true,
    origin: 'stream',
  });
  return messageId;
}

function markThreadInvocationActive(msg: BackgroundAgentMessage, options: HandleBackgroundMessageOptions): void {
  const threadState = options.store.getThreadState(msg.threadId);
  if (!threadState.isLoading) {
    options.store.setThreadLoading(msg.threadId, true);
  }
  // F108: slot-aware — register specific invocation if ID available
  if (msg.invocationId) {
    options.store.addThreadActiveInvocation(msg.threadId, msg.invocationId, msg.catId, 'execute');
  } else if (!threadState.hasActiveInvocation) {
    options.store.setThreadHasActiveInvocation(msg.threadId, true);
  }
}

function markThreadInvocationComplete(msg: BackgroundAgentMessage, options: HandleBackgroundMessageOptions): void {
  options.store.setThreadLoading(msg.threadId, false);
  options.store.setThreadCatInvocation(msg.threadId, msg.catId, { invocationId: undefined });
  // F108: slot-aware — remove specific invocation if ID available.
  // Cancel fallback: find and remove only this cat's latest active slot to avoid
  // clearing other cats' slots during multi-cat concurrent dispatch.
  if (msg.invocationId) {
    options.store.removeThreadActiveInvocation(msg.threadId, msg.invocationId);
  } else {
    const threadState = options.store.getThreadState(msg.threadId);
    const catSlot = findLatestActiveInvocationIdForCat(threadState.activeInvocations, msg.catId);
    if (catSlot) {
      options.store.removeThreadActiveInvocation(msg.threadId, catSlot);
    } else {
      options.store.setThreadHasActiveInvocation(msg.threadId, false);
    }
  }
}

export function handleBackgroundAgentMessage(
  msg: BackgroundAgentMessage,
  options: HandleBackgroundMessageOptions,
): void {
  const streamKey = getStreamKey(msg);
  const existing = options.bgStreamRefs.get(streamKey);

  if (msg.type === 'text' && msg.content) {
    const isCallbackText = msg.origin === 'callback';
    if (!isCallbackText) {
      markThreadInvocationActive(msg, options);
    }
    // Track the final message ID for toast preview (must capture before deleting bgStreamRefs)
    let finalMsgId: string | undefined;

    if (msg.origin === 'callback') {
      const replacementTarget = findBackgroundCallbackReplacementTarget(msg, options);
      if (replacementTarget) {
        const cbId = msg.messageId ?? replacementTarget.id;
        if (cbId !== replacementTarget.id) {
          options.store.replaceThreadMessageId(msg.threadId, replacementTarget.id, cbId);
        }
        options.store.patchThreadMessage(msg.threadId, cbId, {
          content: msg.content,
          origin: 'callback',
          isStreaming: false,
          ...(msg.metadata ? { metadata: msg.metadata } : {}),
          ...(msg.extra?.crossPost ? { extra: { crossPost: msg.extra.crossPost } } : {}),
          ...(msg.mentionsUser ? { mentionsUser: true } : {}),
          ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
          ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
        });
        options.bgStreamRefs.delete(streamKey);
        // Consume finalized ref — callback successfully replaced
        options.finalizedBgRefs.delete(streamKey);
        // #586 P1-2 fix: Only set replacedInvocations when we have a real invocationId.
        // Fallback matches return null — writing a pseudo ID would permanently suppress
        // future invocationless stream chunks via shouldSuppressLateBackgroundStreamChunk.
        if (replacementTarget.invocationId) {
          options.replacedInvocations.set(streamKey, replacementTarget.invocationId);
        }
        finalMsgId = cbId;
      } else {
        const cbId = msg.messageId ?? `bg-cb-${msg.timestamp}-${msg.catId}-${options.nextBgSeq()}`;
        options.store.addMessageToThread(msg.threadId, {
          id: cbId,
          type: 'assistant',
          catId: msg.catId,
          content: msg.content,
          ...(msg.metadata ? { metadata: msg.metadata } : {}),
          ...(msg.extra?.crossPost ? { extra: { crossPost: msg.extra.crossPost } } : {}),
          ...(msg.mentionsUser ? { mentionsUser: true } : {}),
          ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
          ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
          timestamp: msg.timestamp,
          origin: 'callback',
        });
        // #586 Bug 1 (TD112): Callback created new bubble without finding a stream
        // placeholder. Mark invocation as replaced so late background stream chunks
        // are suppressed instead of spawning a duplicate bubble.
        const bgInvocationId = msg.invocationId ?? getThreadInvocationId(msg, options);
        if (bgInvocationId) {
          options.replacedInvocations.set(streamKey, bgInvocationId);
        }
        finalMsgId = cbId;
      }
    } else {
      if (shouldSuppressLateBackgroundStreamChunk(msg, streamKey, options)) {
        return;
      }
      // CLI stream text (thinking): merge into existing stream bubble
      let messageId = existing?.id;
      // Active→background transition recovery: find existing streaming bubble
      if (!messageId) {
        messageId = recoverStreamingMessage(msg, streamKey, options);
      }
      if (messageId) {
        // HOT PATH: batch content + metadata + streaming + catStatus into ONE set()
        // to prevent React update-depth overflow during high-frequency streaming.
        options.store.batchStreamChunkUpdate({
          threadId: msg.threadId,
          messageId,
          catId: msg.catId,
          content: msg.content,
          metadata: msg.metadata,
          streaming: !msg.isFinal,
          catStatus: msg.isFinal ? 'done' : 'streaming',
        });
        if (msg.replyTo || msg.replyPreview) {
          options.store.patchThreadMessage(msg.threadId, messageId, {
            ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
            ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
          });
        }
        if (msg.isFinal) {
          options.bgStreamRefs.delete(streamKey);
        }
      } else {
        messageId = `bg-${msg.timestamp}-${msg.catId}-${options.nextBgSeq()}`;
        const invocationId = getThreadInvocationId(msg, options);
        options.bgStreamRefs.set(streamKey, { id: messageId, threadId: msg.threadId, catId: msg.catId });
        options.store.addMessageToThread(msg.threadId, {
          id: messageId,
          type: 'assistant',
          catId: msg.catId,
          content: msg.content,
          ...(msg.metadata ? { metadata: msg.metadata } : {}),
          ...(invocationId ? { extra: { stream: { invocationId } } } : {}),
          ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
          ...(msg.replyPreview ? { replyPreview: msg.replyPreview } : {}),
          timestamp: msg.timestamp,
          isStreaming: !msg.isFinal,
          origin: 'stream',
        });
        // Cat status for new message (not batched — fires once per stream start)
        options.store.updateThreadCatStatus(msg.threadId, msg.catId, msg.isFinal ? 'done' : 'streaming');
        if (msg.isFinal) {
          options.bgStreamRefs.delete(streamKey);
        }
      }

      finalMsgId = messageId;
    }

    // Callback-only: update cat status on isFinal (non-callback handled by batch/new-message above)
    if (isCallbackText && msg.isFinal) {
      options.store.updateThreadCatStatus(msg.threadId, msg.catId, 'done');
    }
    if (msg.isFinal) {
      // #80 fix-C: Clear timeout guard for text(isFinal) path
      options.clearDoneTimeout?.(msg.threadId);
      const finalMessage = finalMsgId
        ? options.store.getThreadState(msg.threadId).messages.find((m) => m.id === finalMsgId)
        : undefined;
      const preview = finalMessage?.content ?? msg.content;
      markThreadInvocationComplete(msg, options);
      options.addToast({
        type: 'success',
        title: `${msg.catId} 完成`,
        message: preview.slice(0, 80) + (preview.length > 80 ? '...' : ''),
        threadId: msg.threadId,
        duration: 5000,
      });
    }
    return;
  }

  if (msg.type === 'error') {
    markThreadInvocationActive(msg, options);
    stopTrackedStream(streamKey, msg, options);
    options.store.addMessageToThread(msg.threadId, {
      id: `bg-err-${msg.timestamp}-${msg.catId}-${options.nextBgSeq()}`,
      type: 'system',
      variant: 'error',
      catId: msg.catId,
      content: `Error: ${msg.error ?? 'Unknown error'}`,
      timestamp: msg.timestamp,
    });
    options.store.updateThreadCatStatus(msg.threadId, msg.catId, 'error');
    if (msg.isFinal) {
      // #80 fix-C: Clear timeout guard for error(isFinal) path
      options.clearDoneTimeout?.(msg.threadId);
      markThreadInvocationComplete(msg, options);
    }
    options.addToast({
      type: 'error',
      title: `${msg.catId} 出错`,
      message: msg.error ?? 'Unknown error',
      threadId: msg.threadId,
      duration: 8000,
    });
    return;
  }

  if (msg.type === 'done') {
    stopTrackedStream(streamKey, msg, options);
    const currentStatus = options.store.getThreadState(msg.threadId).catStatuses[msg.catId];
    if (currentStatus !== 'error') {
      options.store.updateThreadCatStatus(msg.threadId, msg.catId, 'done');
      options.addToast({
        type: 'success',
        title: `${msg.catId} 完成`,
        message: `${msg.catId} 已完成处理`,
        threadId: msg.threadId,
        duration: 5000,
      });
    }
    if (msg.isFinal) {
      // #80 fix-C: Clear timeout guard so it doesn't fire a false "timed out" message
      options.clearDoneTimeout?.(msg.threadId);
      markThreadInvocationComplete(msg, options);
    }
    return;
  }

  if (msg.type === 'status') {
    const mapped = STATUS_MAP[msg.content ?? ''] ?? 'streaming';
    options.store.updateThreadCatStatus(msg.threadId, msg.catId, mapped);
    return;
  }

  if (msg.type === 'tool_use') {
    markThreadInvocationActive(msg, options);
    const toolName = msg.toolName ?? 'unknown';
    const detail = msg.toolInput ? safeJsonPreview(msg.toolInput, 200) : undefined;
    const messageId = ensureBackgroundAssistantMessage(msg, streamKey, existing, options);
    options.store.appendToolEventToThread(msg.threadId, messageId, {
      id: `bg-tool-use-${msg.timestamp}-${options.nextBgSeq()}`,
      type: 'tool_use',
      label: `${msg.catId} → ${toolName}`,
      ...(detail ? { detail } : {}),
      timestamp: msg.timestamp,
    });
    options.store.setThreadMessageStreaming(msg.threadId, messageId, true);
    options.store.updateThreadCatStatus(msg.threadId, msg.catId, 'streaming');
    return;
  }

  if (msg.type === 'tool_result') {
    markThreadInvocationActive(msg, options);
    const detail = compactToolResultDetail(msg.content ?? '');
    const messageId = ensureBackgroundAssistantMessage(msg, streamKey, existing, options);
    options.store.appendToolEventToThread(msg.threadId, messageId, {
      id: `bg-tool-result-${msg.timestamp}-${options.nextBgSeq()}`,
      type: 'tool_result',
      label: `${msg.catId} ← result`,
      detail,
      timestamp: msg.timestamp,
    });
    options.store.setThreadMessageStreaming(msg.threadId, messageId, true);
    options.store.updateThreadCatStatus(msg.threadId, msg.catId, 'streaming');
    return;
  }

  if (msg.type === 'system_info' || msg.type === 'a2a_handoff') {
    if (!msg.content) return;
    if (msg.type === 'a2a_handoff') {
      addBackgroundSystemMessage(msg, options, msg.content);
      return;
    }

    const result = consumeBackgroundSystemInfo(msg, existing, options);
    if (!result.consumed) {
      addBackgroundSystemMessage(msg, options, result.content, result.variant);
    }
  }
}
