'use client';

import {
  ContextAttachmentSchema,
  type MessageBundleSelectionItem,
  type QuoteContextAttachment,
  type QuoteContextSource,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useIsDesktop } from '@/hooks/useIsDesktop';
import { type TextSelectionAction, useTextSelectionAction } from '@/hooks/useTextSelectionAction';
import type { ChatMessage } from '@/stores/chatStore';
import { useChatStore } from '@/stores/chatStore';
import { useToastStore } from '@/stores/toastStore';
import { apiFetch } from '@/utils/api-client';
import { getUserId } from '@/utils/userId';
import { ConfirmDialog } from './ConfirmDialog';
import { createQuoteContextAttachment } from './chat-context-reference';
import { describeMessageInvocationTrajectory, openMessageInvocationTrajectory } from './InvocationTrajectoryAnchor';
import { LiveSelectionAnnotationAction } from './LiveSelectionAnnotationAction';
import { MessageActionSlotProvider } from './MessageActionSlot';
import { SelectionAnnotationAction } from './SelectionAnnotationAction';
import { pushThreadRouteWithHistory } from './ThreadSidebar/thread-navigation';
import { TransferTargetPicker } from './TransferTargetPicker';
import { TrueRecallActionButton } from './TrueRecallActionButton';
import { useMessageAnnotationMarkers } from './useMessageAnnotationMarkers';

function showErrorToast(title: string, body?: Record<string, unknown>) {
  useToastStore.getState().addToast({
    type: 'error',
    title,
    message: (body?.error as string) ?? '操作未成功，请重试',
    duration: 4000,
  });
}

type DialogState =
  | { type: 'none' }
  | { type: 'soft-delete' }
  | { type: 'hard-delete'; threadTitle: string | null }
  | { type: 'edit'; editedContent: string }
  | { type: 'branch-confirm'; editedContent: string }
  | { type: 'branch-direct' };

interface MessageActionsProps {
  message: ChatMessage;
  threadId: string;
  children: React.ReactNode;
  selectionMode?: boolean;
  selected?: boolean;
  selectionEligible?: boolean;
  onEnterSelection?: (messageId: string) => void;
  onToggleSelection?: (messageId: string) => void;
  /** Blocks network forwarding while this browser document is not admitted to write. */
  forwardingDisabled?: boolean;
}

const COMPACT_ACTIONS_QUERY = '(max-width: 767px), (hover: none) and (pointer: coarse)';

function useCompactMessageActions(): boolean {
  // Keep the server and first client tree identical; media state takes over after hydration.
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(COMPACT_ACTIONS_QUERY);
    const update = (event: MediaQueryListEvent) => setCompact(event.matches);
    setCompact(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return compact;
}

function selectionCoordinates(action: TextSelectionAction): { selectionStart?: number; selectionEnd?: number } {
  if (action.selectionStart === undefined || action.selectionEnd === undefined) return {};
  return { selectionStart: action.selectionStart, selectionEnd: action.selectionEnd };
}

function quoteSourceForSelection(
  action: TextSelectionAction,
  threadId: string,
  messageId: string,
  senderCatId?: string,
): QuoteContextSource {
  if (action.sourceKind === 'cli_output') {
    return {
      kind: 'cli_output',
      threadId,
      messageId,
      ...(action.sourceSegmentId ? { segmentId: action.sourceSegmentId } : {}),
    };
  }
  return {
    kind: 'message',
    threadId,
    messageId,
    ...(senderCatId ? { senderCatId } : {}),
  };
}

function addSelectionAnnotationToComposer(
  action: TextSelectionAction | null,
  threadId: string,
  messageId: string,
  senderCatId: string | undefined,
  comment: string,
) {
  if (!action) return;
  useChatStore.getState().setPendingChatInsert({
    threadId,
    text: '',
    contextAttachments: [
      createQuoteContextAttachment(action.text, quoteSourceForSelection(action, threadId, messageId, senderCatId), {
        comment,
        ...selectionCoordinates(action),
      }),
    ],
  });
  window.getSelection()?.removeAllRanges();
}

function cliQuoteSelectionItem(
  action: TextSelectionAction,
  messageId: string,
  sourceMessageIds: readonly string[] | undefined,
  comment: string,
): MessageBundleSelectionItem | null {
  if (!action.sourceSegmentId || action.selectionStart === undefined || action.selectionEnd === undefined) return null;
  return {
    kind: 'cli_quote',
    messageId,
    sourceMessageIds: sourceMessageIds ? [...sourceMessageIds] : [messageId],
    segmentId: action.sourceSegmentId,
    text: action.text,
    selectionStart: action.selectionStart,
    selectionEnd: action.selectionEnd,
    ...(action.sourceProjectionVersion
      ? {
          sourceProjectionVersion: action.sourceProjectionVersion,
          renderedOccurrences: action.renderedOccurrences,
        }
      : {}),
    ...(comment ? { comment } : {}),
  };
}

function canForwardTextSelection(action: TextSelectionAction): boolean {
  if (action.sourceKind === 'message') return action.renderedOccurrences === 1;
  if (action.sourceKind !== 'cli_output') return false;
  const hasCoordinates =
    Boolean(action.sourceSegmentId) && action.selectionStart !== undefined && action.selectionEnd !== undefined;
  return hasCoordinates && (!action.sourceProjectionVersion || action.renderedOccurrences === 1);
}

export function MessageActions({
  message,
  threadId,
  children,
  selectionMode = false,
  selected = false,
  selectionEligible = false,
  onEnterSelection,
  onToggleSelection,
  forwardingDisabled = false,
}: MessageActionsProps) {
  const [dialog, setDialog] = useState<DialogState>({ type: 'none' });
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [compactOpen, setCompactOpen] = useState(false);
  const [actionSlot, setActionSlot] = useState<HTMLDivElement | null>(null);
  const [forwardSelection, setForwardSelection] = useState<{
    items: MessageBundleSelectionItem[];
  } | null>(null);
  const messageRef = useRef<HTMLDivElement>(null);
  const selectionAction = useTextSelectionAction(messageRef, !message.isStreaming, message.id, 'viewport');
  const annotationMarkers = useMessageAnnotationMarkers(messageRef, threadId, message.id);
  const removeThreadMessage = useChatStore((s) => s.removeThreadMessage);
  const isDesktop = useIsDesktop();
  const compactActions = useCompactMessageActions();

  const isUser = message.type === 'user' && !message.catId;
  const isAssistant = message.type === 'assistant' || (message.type === 'user' && !!message.catId);
  const isRecalled = Boolean(message.extra?.recall);
  const invocationTrajectory = describeMessageInvocationTrajectory(message);
  const canAct = (isUser || isAssistant) && !message.isStreaming && !isRecalled;
  // #699: Reply is available on all message types (not just user/assistant)
  const canReply = !message.isStreaming && !isRecalled;
  const hasSelectionShortcut = canAct && selectionEligible && Boolean(onEnterSelection);
  /* The author row owns a stable horizontal slot. Painting that slot on message hover cannot
   * move the message, and toolbar-local focus keeps unrelated body controls from summoning it.
   * Narrow/coarse layouts retain the same slot but put one 44px entry in it; the full dock opens
   * as a sheet, so touch reachability does not cost every message a permanent vertical row. */
  const toolbarPositionClass = isUser ? 'top-0 right-10 sm:right-auto sm:left-10' : 'top-0 left-10';
  const actionSlotPositionClass = isUser
    ? 'absolute right-0 top-1/2 -translate-y-1/2'
    : 'absolute left-0 top-1/2 -translate-y-1/2';
  const actionsExpanded = compactOpen ? true : overflowOpen;
  const desktopOverflowOpen = overflowOpen && isDesktop && !compactActions;
  const useOverflowSheet = !(isDesktop && !compactActions);
  const toolbarVisibilityClass = actionsExpanded
    ? 'pointer-events-auto opacity-100'
    : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100';

  useEffect(() => {
    if (!overflowOpen && !compactOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOverflowOpen(false);
      setCompactOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [compactOpen, overflowOpen]);
  useEffect(() => {
    if (!desktopOverflowOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!messageRef.current?.contains(event.target as Node)) setOverflowOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [desktopOverflowOpen]);

  const handleSoftDelete = useCallback(() => setDialog({ type: 'soft-delete' }), []);

  const handleHardDelete = useCallback(async () => {
    try {
      const res = await apiFetch(`/api/threads/${threadId}`, { method: 'GET' });
      const thread = res.ok ? await res.json() : null;
      setDialog({ type: 'hard-delete', threadTitle: thread?.title ?? null });
    } catch {
      setDialog({ type: 'hard-delete', threadTitle: null });
    }
  }, [threadId]);

  const handleEdit = useCallback(() => {
    setDialog({ type: 'edit', editedContent: message.content });
  }, [message.content]);

  const handleBranchDirect = useCallback(() => setDialog({ type: 'branch-direct' }), []);

  const confirmSoftDelete = useCallback(async () => {
    setDialog({ type: 'none' });
    try {
      const res = await apiFetch(`/api/messages/${message.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: getUserId(), mode: 'soft' }),
      });
      if (res.ok) {
        removeThreadMessage(threadId, message.id);
      } else {
        const body = await res.json().catch(() => ({}));
        showErrorToast('删除失败', body);
      }
    } catch {
      showErrorToast('删除失败');
    }
  }, [message.id, threadId, removeThreadMessage]);

  const confirmHardDelete = useCallback(async () => {
    if (dialog.type !== 'hard-delete') return;
    const confirmTitle = dialog.threadTitle ?? '确认删除';
    setDialog({ type: 'none' });
    try {
      const res = await apiFetch(`/api/messages/${message.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: getUserId(), mode: 'hard', confirmTitle }),
      });
      if (res.ok) {
        removeThreadMessage(threadId, message.id);
      } else {
        const body = await res.json().catch(() => ({}));
        showErrorToast('删除失败', body);
      }
    } catch {
      showErrorToast('删除失败');
    }
  }, [dialog, message.id, threadId, removeThreadMessage]);

  const handleBranchConfirm = useCallback(() => {
    if (dialog.type !== 'edit') return;
    setDialog({ type: 'branch-confirm', editedContent: dialog.editedContent });
  }, [dialog]);

  const confirmBranch = useCallback(async () => {
    if (dialog.type !== 'branch-confirm') return;
    const { editedContent } = dialog;
    setDialog({ type: 'none' });
    try {
      const res = await apiFetch(`/api/threads/${threadId}/branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fromMessageId: message.id,
          editedContent: editedContent !== message.content ? editedContent : undefined,
          userId: getUserId(),
        }),
      });
      if (res.ok) {
        const { threadId: newThreadId } = await res.json();
        pushThreadRouteWithHistory(newThreadId, typeof window !== 'undefined' ? window : undefined);
      } else {
        const body = await res.json().catch(() => ({}));
        showErrorToast('分支创建失败', body);
      }
    } catch {
      showErrorToast('分支创建失败');
    }
  }, [dialog, message.id, message.content, threadId]);

  const branchingRef = useRef(false);
  const confirmBranchDirect = useCallback(async () => {
    if (branchingRef.current) return;
    branchingRef.current = true;
    setDialog({ type: 'none' });
    try {
      const res = await apiFetch(`/api/threads/${threadId}/branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fromMessageId: message.id, userId: getUserId() }),
      });
      if (res.ok) {
        const { threadId: newThreadId } = await res.json();
        pushThreadRouteWithHistory(newThreadId, typeof window !== 'undefined' ? window : undefined);
      } else {
        const body = await res.json().catch(() => ({}));
        showErrorToast('分支创建失败', body);
      }
    } catch {
      showErrorToast('分支创建失败');
    } finally {
      branchingRef.current = false;
    }
  }, [message.id, threadId]);

  const close = useCallback(() => setDialog({ type: 'none' }), []);

  const handleSelectionAddToChat = useCallback(
    (action: TextSelectionAction, comment: string) =>
      addSelectionAnnotationToComposer(action, threadId, message.id, message.catId, comment),
    [message.catId, message.id, threadId],
  );

  const handleSelectionForward = useCallback(
    (action: TextSelectionAction, comment: string) => {
      if (action.sourceKind === 'cli_output') {
        const item = cliQuoteSelectionItem(action, message.id, message.projectionSourceMessageIds, comment);
        if (item) setForwardSelection({ items: [item] });
        return;
      }
      if (action.sourceKind !== 'message') return;
      setForwardSelection({
        items: [
          {
            kind: 'quote',
            messageId: message.id,
            text: action.text,
            // Only this browser can see the rendered plane; admission requires the count to be 1.
            ...(action.renderedOccurrences !== undefined ? { renderedOccurrences: action.renderedOccurrences } : {}),
            ...selectionCoordinates(action),
            ...(comment ? { comment } : {}),
          },
        ],
      });
    },
    [message.id, message.projectionSourceMessageIds],
  );

  const updateAnnotation = useCallback(
    (attachment: QuoteContextAttachment, comment: string) => {
      const updated = ContextAttachmentSchema.parse({ ...attachment, comment });
      useChatStore.getState().setPendingChatInsert({
        threadId,
        text: '',
        contextAttachments: [updated],
        removeContextAttachmentIds: [attachment.id],
      });
    },
    [threadId],
  );

  const deleteAnnotation = useCallback(
    (attachment: QuoteContextAttachment) => {
      useChatStore.getState().setPendingChatInsert({
        threadId,
        text: '',
        removeContextAttachmentIds: [attachment.id],
      });
    },
    [threadId],
  );

  const overflowMenuItems = (
    <>
      <button
        type="button"
        role="menuitem"
        className="min-h-11 w-full px-3 py-2 text-left text-sm text-cafe-secondary transition-colors hover:bg-cafe-surface-elevated hover:text-cafe-primary"
        onClick={() => {
          setOverflowOpen(false);
          handleBranchDirect();
        }}
      >
        从这里分支
      </button>
      <button
        type="button"
        role="menuitem"
        className="min-h-11 w-full px-3 py-2 text-left text-sm text-conn-red-text transition-colors hover:bg-cafe-surface-elevated"
        onClick={() => {
          setOverflowOpen(false);
          handleHardDelete();
        }}
      >
        永久删除
      </button>
    </>
  );

  const actionToolbar = (compactPresentation: boolean) => (
    <div
      data-quote-exclude
      data-testid="message-actions-toolbar"
      role="toolbar"
      aria-label="消息操作"
      className={`${toolbarVisibilityClass} ${actionSlot ? actionSlotPositionClass : `absolute ${toolbarPositionClass}`} z-30 flex transition-opacity bg-cafe-surface/90 rounded-lg shadow-sm border border-cafe ${
        compactPresentation
          ? 'w-full justify-center gap-1 p-2 [&_button]:min-h-11 [&_button]:min-w-11'
          : 'gap-0.5 px-1 py-0.5'
      }`}
      onClick={compactPresentation ? () => setCompactOpen(false) : undefined}
      onKeyUp={
        compactPresentation
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') setCompactOpen(false);
            }
          : undefined
      }
    >
      {hasSelectionShortcut && (
        <button
          type="button"
          onClick={() => onEnterSelection?.(message.id)}
          className={`rounded p-1 text-cafe-muted transition-colors hover:bg-cafe-surface-elevated hover:text-cafe-primary ${
            isUser ? 'order-2' : ''
          }`}
          title="多选消息"
          aria-label="多选消息"
        >
          <svg aria-hidden="true" className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <rect x="3" y="4" width="6" height="6" rx="1" strokeWidth={2} />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m4.5 7 1.25 1.25L8 6" />
            <rect x="3" y="14" width="6" height="6" rx="1" strokeWidth={2} />
            <path strokeLinecap="round" strokeWidth={2} d="M13 7h8M13 17h8" />
          </svg>
        </button>
      )}
      <div data-testid="message-secondary-actions" className={`${isUser ? 'order-1' : ''} flex gap-0.5`.trim()}>
        <button
          type="button"
          onClick={() => {
            useChatStore.getState().setReplyTo({
              id: message.id,
              content: message.content,
              senderCatId: message.catId === undefined ? null : message.catId,
              threadId,
            });
          }}
          className="p-1 rounded hover:bg-cafe-surface-elevated text-cafe-muted hover:text-cafe-primary transition-colors"
          title="引用回复"
          aria-label="引用回复"
        >
          <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 10h10a5 5 0 015 5v6M3 10l6-6M3 10l6 6"
            />
          </svg>
        </button>
        {invocationTrajectory && (
          <button
            type="button"
            onClick={() => openMessageInvocationTrajectory(message, threadId)}
            className="rounded p-1 text-cafe-muted transition-colors hover:bg-cafe-surface-elevated hover:text-cafe-accent"
            title="查看这轮轨迹"
            aria-label="查看这轮 invocation 轨迹"
            data-testid="message-action-invocation-trajectory"
          >
            <svg
              aria-hidden="true"
              className="h-3.5 w-3.5"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <circle cx="4" cy="4" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <path d="M4 5.5v3A3.5 3.5 0 0 0 7.5 12h3" />
            </svg>
          </button>
        )}
        {canAct && (
          <>
            <button
              type="button"
              onClick={handleSoftDelete}
              className="p-1 rounded hover:bg-cafe-surface-elevated text-cafe-muted hover:text-conn-red-text transition-colors"
              title="删除"
              aria-label="删除"
            >
              <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                />
              </svg>
            </button>
            {isUser && (
              <>
                <TrueRecallActionButton message={message} threadId={threadId} />
                <button
                  type="button"
                  onClick={handleEdit}
                  className="p-1 rounded hover:bg-cafe-surface-elevated text-cafe-muted hover:text-conn-blue-text transition-colors"
                  title="编辑 (创建分支)"
                  aria-label="编辑并创建分支"
                >
                  <svg aria-hidden="true" className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                    />
                  </svg>
                </button>
              </>
            )}
            <div className="relative">
              <button
                type="button"
                onClick={() => setOverflowOpen((open) => !open)}
                className="rounded p-1 text-cafe-muted transition-colors hover:bg-cafe-surface-elevated hover:text-cafe-primary"
                title="更多消息操作"
                aria-label="更多消息操作"
                aria-haspopup="menu"
                aria-expanded={overflowOpen}
              >
                <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="5" cy="12" r="1.8" />
                  <circle cx="12" cy="12" r="1.8" />
                  <circle cx="19" cy="12" r="1.8" />
                </svg>
              </button>
              {overflowOpen && isDesktop && !compactActions && (
                <div
                  role="menu"
                  aria-label="更多消息操作"
                  className={`absolute top-full z-40 mt-1 w-40 rounded-lg border border-cafe bg-cafe-surface py-1 shadow-lg ${
                    isUser ? 'right-0' : 'left-0'
                  }`}
                >
                  {overflowMenuItems}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );

  const compactEntry = (
    <button
      type="button"
      data-quote-exclude
      data-testid="message-actions-compact-trigger"
      aria-label="打开消息操作"
      aria-expanded={compactOpen}
      onClick={() => setCompactOpen(true)}
      className={`${actionSlot ? 'absolute inset-0' : `absolute ${toolbarPositionClass}`} pointer-events-none grid min-h-11 min-w-11 place-items-center rounded-lg border border-cafe bg-cafe-surface/90 text-cafe-muted opacity-0 shadow-sm transition-[background-color,color,opacity] group-hover:pointer-events-auto group-hover:opacity-100 focus:pointer-events-auto focus:opacity-100 [@media(hover:none)_and_(pointer:coarse)]:pointer-events-auto [@media(hover:none)_and_(pointer:coarse)]:opacity-100`}
    >
      <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="5" cy="12" r="1.8" />
        <circle cx="12" cy="12" r="1.8" />
        <circle cx="19" cy="12" r="1.8" />
      </svg>
    </button>
  );

  return (
    <div
      ref={messageRef}
      data-context-quote-source="message"
      data-message-selection={selectionMode ? (selected ? 'selected' : 'available') : undefined}
      data-selection-layout={selectionMode ? 'leading-gutter' : undefined}
      className={`group relative ${selectionMode ? 'pl-12' : ''}`.trimEnd()}
    >
      <MessageActionSlotProvider register={setActionSlot}>{children}</MessageActionSlotProvider>

      {selectionMode && selectionEligible && (
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={selected ? '取消选择这条消息' : '选择这条消息'}
          onClick={() => onToggleSelection?.(message.id)}
          className={`absolute left-2 top-2 z-20 grid h-7 w-7 place-items-center rounded-full border-2 transition-[background-color,border-color,transform] active:scale-95 ${
            selected
              ? 'border-[var(--semantic-success)] bg-[var(--semantic-success)] text-[var(--cafe-surface)]'
              : 'border-cafe bg-cafe-surface text-cafe-muted hover:border-cafe-accent hover:text-cafe-accent'
          }`}
        >
          {selected && (
            <svg aria-hidden="true" className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="m5 12 4 4L19 6" />
            </svg>
          )}
        </button>
      )}

      {!selectionMode && (
        <LiveSelectionAnnotationAction
          action={selectionAction}
          resetKey={message.id}
          positionMode="fixed"
          actionTestId="message-selection-add-to-chat"
          triggerContent="引用…"
          triggerClassName="fixed z-[70] flex min-h-11 min-w-11 items-center justify-center gap-1.5 rounded-lg bg-cafe-accent px-2.5 py-1.5 text-xs font-medium text-[var(--cafe-surface)] shadow-lg transition-colors hover:bg-cafe-interactive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cafe-accent"
          onSave={handleSelectionAddToChat}
          onForward={forwardingDisabled ? undefined : handleSelectionForward}
          canForward={canForwardTextSelection}
        />
      )}

      {!selectionMode &&
        annotationMarkers.map((marker) => (
          <SelectionAnnotationAction
            key={marker.attachment.id}
            selectedText={marker.attachment.text}
            initialComment={marker.attachment.comment}
            position={marker.position}
            positionMode="fixed"
            actionTestId={`context-annotation-marker-${marker.attachment.id}`}
            triggerContent={marker.number}
            triggerClassName="fixed z-[65] grid h-7 w-7 place-items-center rounded-full border-2 border-[var(--cafe-surface)] bg-cafe-accent text-xs font-bold text-[var(--cafe-surface)] shadow-lg transition-transform hover:scale-110"
            onSave={(comment) => updateAnnotation(marker.attachment, comment)}
            onDelete={() => deleteAnnotation(marker.attachment)}
          />
        ))}

      {canReply && !selectionMode && !actionSlot && (compactActions ? compactEntry : actionToolbar(false))}
      {canReply && !selectionMode && actionSlot && !compactActions && createPortal(actionToolbar(false), actionSlot)}
      {canReply && !selectionMode && actionSlot && compactActions && createPortal(compactEntry, actionSlot)}

      {compactOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[75] flex items-end"
            role="presentation"
            data-testid="message-actions-compact-sheet"
          >
            <button
              type="button"
              className="absolute inset-0 bg-[var(--console-overlay-backdrop)] backdrop-blur-sm"
              aria-label="关闭消息操作"
              onClick={() => setCompactOpen(false)}
            />
            <div className="relative m-2 w-[calc(100%-1rem)] rounded-2xl border border-cafe bg-cafe-surface p-2 shadow-2xl">
              <p className="px-3 pb-2 pt-1 text-xs font-semibold text-cafe-muted">消息操作</p>
              {actionToolbar(true)}
            </div>
          </div>,
          document.body,
        )}

      {overflowOpen &&
        useOverflowSheet &&
        typeof document !== 'undefined' &&
        createPortal(
          <div className="fixed inset-0 z-[80] flex items-end" role="presentation">
            <button
              type="button"
              className="absolute inset-0 bg-[var(--console-overlay-backdrop)] backdrop-blur-sm"
              aria-label="关闭更多消息操作"
              onClick={() => setOverflowOpen(false)}
            />
            <div
              role="menu"
              aria-label="更多消息操作"
              className="relative m-2 w-[calc(100%-1rem)] rounded-2xl border border-cafe bg-cafe-surface p-2 shadow-2xl"
            >
              <p className="px-3 pb-2 pt-1 text-xs font-semibold text-cafe-muted">消息操作</p>
              {overflowMenuItems}
            </div>
          </div>,
          document.body,
        )}

      {forwardSelection !== null && !forwardingDisabled && (
        <TransferTargetPicker
          open
          admissionBlocked={forwardingDisabled}
          sourceThreadId={threadId}
          items={forwardSelection.items}
          onClose={() => setForwardSelection(null)}
          onSuccess={() => {
            window.getSelection()?.removeAllRanges();
            setForwardSelection(null);
          }}
        />
      )}

      {/* Soft delete confirmation */}
      <ConfirmDialog
        open={dialog.type === 'soft-delete'}
        title="删除消息"
        message="确认删除此消息？删除后可恢复。"
        confirmLabel="删除"
        variant="danger"
        onConfirm={confirmSoftDelete}
        onCancel={close}
      />

      {/* Hard delete confirmation — requires title input */}
      <ConfirmDialog
        open={dialog.type === 'hard-delete'}
        title="永久删除"
        message="此操作不可恢复。请输入对话标题以确认。"
        requireInput={dialog.type === 'hard-delete' ? (dialog.threadTitle ?? '确认删除') : undefined}
        inputPlaceholder={dialog.type === 'hard-delete' && dialog.threadTitle ? '输入对话标题' : '输入 "确认删除"'}
        confirmLabel="永久删除"
        variant="danger"
        onConfirm={confirmHardDelete}
        onCancel={close}
      />

      {/* Edit: inline textarea */}
      {dialog.type === 'edit' && (
        <div
          className="fixed inset-0 bg-[var(--console-overlay-backdrop)] backdrop-blur-sm flex items-center justify-center z-50"
          onClick={close}
        >
          <div
            className="bg-cafe-surface rounded-xl shadow-xl p-6 max-w-lg w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-base font-semibold mb-2">编辑消息</h3>
            <textarea
              value={dialog.editedContent}
              onChange={(e) => setDialog({ ...dialog, editedContent: e.target.value })}
              className="w-full border border-cafe rounded-lg px-3 py-2 text-sm mb-4 h-32 resize-y focus:outline-none focus:ring-2 focus:ring-[var(--semantic-info)]"
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={close}
                className="px-4 py-2 text-sm text-cafe-secondary hover:bg-cafe-surface-elevated rounded-lg"
              >
                取消
              </button>
              <button
                onClick={handleBranchConfirm}
                disabled={!dialog.editedContent.trim()}
                className="px-4 py-2 text-sm text-[var(--cafe-surface)] bg-conn-blue-text hover:bg-conn-blue-hover rounded-lg disabled:opacity-40"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Branch confirmation (from edit) */}
      <ConfirmDialog
        open={dialog.type === 'branch-confirm'}
        title="创建分支"
        message="编辑将从此消息创建一个新的对话分支。原对话保留不变。是否继续？"
        confirmLabel="创建分支"
        onConfirm={confirmBranch}
        onCancel={close}
      />

      {/* Direct branch confirmation (no edit) */}
      <ConfirmDialog
        open={dialog.type === 'branch-direct'}
        title="从这里分支"
        message="将从此消息创建一个新的对话分支，复制到这条消息为止的所有历史。原对话保留不变。"
        confirmLabel="创建分支"
        onConfirm={confirmBranchDirect}
        onCancel={close}
      />
    </div>
  );
}
