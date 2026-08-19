'use client';

/**
 * F229 ConciergePanel — non-modal conversation bubble (Layer 3).
 * Owns orchestration and delegates chrome, conversation rendering, resizing,
 * queue liveness, and message loading to focused modules.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import { useConciergeStore } from '@/stores/conciergeStore';
import { apiFetch } from '@/utils/api-client';
import { ConciergePanelHeader, ConciergePanelResizeHandles } from './ConciergePanelChrome';
import { ConciergePanelConversation } from './ConciergePanelConversation';
import { useConciergeConfirmations } from './useConciergeConfirmations';
import { useConciergeMessages } from './useConciergeMessages';
import { useConciergePanelLiveness } from './useConciergePanelLiveness';
import { useConciergeQueue } from './useConciergeQueue';
import { usePanelWidth } from './usePanelWidth';

export function ConciergePanel() {
  const surfaceState = useConciergeStore((s) => s.surfaceState);
  const setSurfaceState = useConciergeStore((s) => s.setSurfaceState);
  const setInputFocused = useConciergeStore((s) => s.setInputFocused);
  const fetchThreadId = useConciergeStore((s) => s.fetchThreadId);
  const displayName = useConciergeStore((s) => s.displayName);
  // FIX-4 KD-16: show which cat is on duty in the panel header
  const dutyCatProfileId = useConciergeStore((s) => s.dutyCatProfileId);
  const invocationStatus = useConciergeStore((s) => s.invocationStatus);
  const muted = useConciergeStore((s) => s.muted);
  const setMuted = useConciergeStore((s) => s.setMuted);
  const notifyMessage = useConciergeStore((s) => s.notifyMessage);
  const threadId = useConciergeStore((s) => s.threadId);
  // A3a P2 fix: pre-filled prompt from toolbar ability buttons (找找看/新功能/传话)
  const pendingPrompt = useConciergeStore((s) => s.pendingPrompt);
  const clearPendingPrompt = useConciergeStore((s) => s.clearPendingPrompt);
  // cloud R3 fix: wire invocationStatus transitions so ball enters thinking + send btn guards work
  const setInvocationStatus = useConciergeStore((s) => s.setInvocationStatus);

  // F229 Phase B: mount-time confirmation state recovery (INV C3)
  // Fetches all user confirmations when panel opens so CardBlock buttons
  // reflect confirmed/cancelled states on refresh.
  const { confirmations } = useConciergeConfirmations(surfaceState === 'bubble');

  // FIX-2b R2: use project-standard IME guard (useIMEGuard) instead of bare
  // nativeEvent.isComposing — Chrome fires compositionend BEFORE keydown(Enter),
  // so isComposing is already false. The hook keeps a ref true for one extra rAF frame.
  const ime = useIMEGuard();
  // FIX-4 R2: resolve dutyCatProfileId → human-readable display name from cat roster
  const { getCatById } = useCatData();
  const dutyCatDisplayName = dutyCatProfileId ? resolveCatDisplayName(dutyCatProfileId, getCatById) : undefined;

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // A3a P2 R4 fix: count non-user messages at send time for reply detection
  const catMsgCountAtSendRef = useRef(0);
  const [inputValue, setInputValue] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);

  // BUG-UX-3: Resizable panel dimensions (extracted to usePanelWidth hook — gpt52 R5 P1)
  const {
    panelWidth,
    panelHeight,
    isExpanded,
    toggleExpanded,
    handleResizePointerDown,
    handleResizePointerMove,
    handleResizePointerUp,
    handleHeightResizePointerDown,
    handleHeightResizePointerMove,
    handleHeightResizePointerUp,
    handleCornerResizePointerDown,
    handleCornerResizePointerMove,
    handleCornerResizePointerUp,
  } = usePanelWidth();

  const { messages, isLoading, addOptimistic, removeOptimistic, refresh } = useConciergeMessages(threadId);

  // P0 liveness: poll /api/threads/:threadId/queue for authoritative invocation status
  const queueStatus = useConciergeQueue(threadId, invocationStatus === 'in_progress');

  // INV-9: lazy thread creation on first bubble open
  useEffect(() => {
    if (surfaceState === 'bubble') {
      void fetchThreadId();
    }
  }, [surfaceState, fetchThreadId]);

  // A3a P2 fix: apply pending prompt when bubble opens from a toolbar ability button.
  // Guard: pendingPrompt===null means no pending action; ''  means "clear input" (聊聊).
  useEffect(() => {
    if (surfaceState !== 'bubble' || pendingPrompt === null) return;
    setInputValue(pendingPrompt);
    clearPendingPrompt();
  }, [surfaceState, pendingPrompt, clearPendingPrompt]);

  // Esc: bubble → toolbar (two-level back per A3a spec)
  useEffect(() => {
    if (surfaceState !== 'bubble') return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSurfaceState('toolbar');
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [surfaceState, setSurfaceState]);

  useConciergePanelLiveness({
    messages,
    invocationStatus,
    queueStatus,
    refresh,
    setInvocationStatus,
    notifyMessage,
    catMsgCountAtSendRef,
    messagesEndRef,
  });

  const handleInputFocus = useCallback(() => setInputFocused(true), [setInputFocused]);
  const handleInputBlur = useCallback(() => setInputFocused(false), [setInputFocused]);
  const handleClose = useCallback(() => setSurfaceState('toolbar'), [setSurfaceState]);
  const handleVisibilityToggle = useCallback(() => {
    if (muted) {
      void setMuted(false);
      return;
    }
    void setMuted(true);
    setSurfaceState('collapsed');
  }, [muted, setMuted, setSurfaceState]);

  // F229 UX: cancel/stop in-progress invocation via scoped per-cat cancel (F122B AC-B9).
  // Uses /cancel/:catId (scoped to the duty cat) instead of /force-reset (whole-thread nuclear).
  // dutyCatId comes from useConciergeQueue which polls activeInvocations during in_progress.
  const [cancelLoading, setCancelLoading] = useState(false);
  const handleCancel = useCallback(async () => {
    if (!threadId || !queueStatus.dutyCatId || cancelLoading) return;
    setCancelLoading(true);
    try {
      const res = await apiFetch(`/api/threads/${threadId}/cancel/${queueStatus.dutyCatId}`, {
        method: 'POST',
      });
      if (res.ok) {
        setInvocationStatus('idle');
      }
    } catch {
      // Silently fail — user can retry or wait for natural timeout
    } finally {
      setCancelLoading(false);
    }
  }, [threadId, queueStatus.dutyCatId, cancelLoading, setInvocationStatus]);

  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    // cloud R5 fix: block send while initial history is loading so catMsgCountAtSendRef
    // is captured from settled messages, not from a stale empty array
    // R8 P2 fix: also block if a send is already in-flight (keyboard path bypasses button disabled guard)
    if (!text || !threadId || isLoading || invocationStatus === 'pending' || invocationStatus === 'in_progress') return;

    setSendError(null);
    // cloud R4 fix: snapshot pre-send cat-message count for reply detection
    catMsgCountAtSendRef.current = messages.filter((m) => !m.isUser).length;
    // cloud R3 fix: ball enters thinking state; send button is disabled during send
    setInvocationStatus('pending');
    // Optimistic insert before clearing input — allows draft restore on failure
    const optId = addOptimistic(text);
    setInputValue('');

    try {
      // P1-2 fix: POST to /api/messages with { content, threadId } in body
      const res = await apiFetch('/api/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, threadId }),
      });
      if (!res.ok) {
        // Restore draft on API error
        removeOptimistic(optId);
        setInputValue(text);
        setSendError('发送失败，请重试');
        setInvocationStatus('idle');
        return;
      }
      // in_progress: message delivered, waiting for cat reply (reply detection effect handles idle)
      setInvocationStatus('in_progress');
      // P1 gpt52 fix: initial burst of refreshes — 800ms catches fast replies, 2500/5000ms slower ones.
      // Continued polling and idle transition are handled by useConciergePanelLiveness.
      [800, 2500, 5000].forEach((delay) => {
        setTimeout(() => refresh(), delay);
      });
    } catch {
      // Network error: restore draft
      removeOptimistic(optId);
      setInputValue(text);
      setSendError('发送失败，请检查网络');
      setInvocationStatus('idle');
    }
  }, [
    inputValue,
    threadId,
    isLoading,
    invocationStatus,
    addOptimistic,
    removeOptimistic,
    refresh,
    setInvocationStatus,
    messages,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // FIX-2b R2: skip Enter during IME composition. Uses useIMEGuard's ref-based
      // check instead of bare nativeEvent.isComposing — Chrome fires compositionend
      // BEFORE the final keydown(Enter), so isComposing is already false by then.
      // The hook's rAF-delayed ref stays true for one extra frame to bridge the gap.
      if (e.key === 'Enter' && !e.shiftKey && !ime.isComposing()) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend, ime],
  );

  // INV-3 variant: only bubble → something in DOM
  if (surfaceState !== 'bubble') return null;

  return (
    <div
      role="dialog"
      aria-label={`${displayName} 对话气泡`}
      aria-modal="false"
      style={{
        backgroundColor: 'var(--cafe-surface-canvas)',
        borderColor: 'var(--cafe-border-subtle)',
        boxShadow: 'var(--shadow-elevation-2)',
        // BUG-UX-3: dynamic dimensions from resize handles
        width: panelWidth,
        height: panelHeight,
      }}
      className={[
        // Position: above ball, right-aligned (Layer 3 layout §7)
        'fixed bottom-[calc(24px+72px+16px)] right-6',
        'z-30',
        // height now controlled by usePanelWidth hook (replaces max-h-[60vh])
        'flex flex-col',
        // Comic bubble shape: 16px radius + speech bubble tail (CSS pseudo)
        // R7 fix: NO overflow-hidden here so the tail triangles can escape the clip
        'rounded-2xl',
        'border',
        // Pop-in animation from bottom-right origin
        'origin-bottom-right',
        'animate-[concierge-bubble-pop_200ms_cubic-bezier(0.34,1.56,0.64,1)_both]',
      ].join(' ')}
    >
      {!isExpanded && (
        <ConciergePanelResizeHandles
          width={{
            onPointerDown: handleResizePointerDown,
            onPointerMove: handleResizePointerMove,
            onPointerUp: handleResizePointerUp,
          }}
          height={{
            onPointerDown: handleHeightResizePointerDown,
            onPointerMove: handleHeightResizePointerMove,
            onPointerUp: handleHeightResizePointerUp,
          }}
          corner={{
            onPointerDown: handleCornerResizePointerDown,
            onPointerMove: handleCornerResizePointerMove,
            onPointerUp: handleCornerResizePointerUp,
          }}
        />
      )}

      {/* Speech bubble tail (CSS triangle pointing toward cat) */}
      {/* R7 fix: tail sits outside the inner overflow-hidden wrapper so it is never clipped */}
      <div
        className="absolute -bottom-2 right-8 w-0 h-0"
        style={{
          borderLeft: '8px solid transparent',
          borderRight: '8px solid transparent',
          borderTop: '8px solid var(--cafe-border-subtle)',
        }}
        aria-hidden="true"
      />
      <div
        className="absolute -bottom-[7px] right-8 w-0 h-0"
        style={{
          borderLeft: '7px solid transparent',
          borderRight: '7px solid transparent',
          borderTop: '7px solid var(--cafe-surface-canvas)',
        }}
        aria-hidden="true"
      />

      {/* R7 fix: inner content wrapper clips header/messages/input at rounded corners */}
      {/* overflow-hidden here + rounded-2xl preserves the bubble shape for content */}
      <div data-testid="concierge-inner-content" className="flex flex-col overflow-hidden rounded-2xl flex-1 min-h-0">
        <ConciergePanelHeader
          title={dutyCatProfileId ? `${displayName} · 值班：${dutyCatDisplayName ?? dutyCatProfileId}` : displayName}
          invocationStatus={invocationStatus}
          muted={muted}
          isExpanded={isExpanded}
          onVisibilityToggle={handleVisibilityToggle}
          onToggleExpanded={toggleExpanded}
          onClose={handleClose}
        />

        <ConciergePanelConversation
          invocationStatus={invocationStatus}
          isLoading={isLoading}
          messages={messages}
          confirmations={confirmations}
          queueStatus={queueStatus}
          cancelLoading={cancelLoading}
          sendError={sendError}
          inputValue={inputValue}
          inputRef={inputRef}
          messagesEndRef={messagesEndRef}
          onStarter={() => {
            setInputValue('你能帮我什么？');
            inputRef.current?.focus();
          }}
          onCancel={() => void handleCancel()}
          onInputChange={(value) => {
            setInputValue(value);
            if (sendError) setSendError(null);
          }}
          onInputFocus={handleInputFocus}
          onInputBlur={handleInputBlur}
          onKeyDown={handleKeyDown}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onSend={() => void handleSend()}
        />
      </div>
    </div>
  );
}
