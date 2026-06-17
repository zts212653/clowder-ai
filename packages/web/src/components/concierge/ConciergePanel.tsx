'use client';

/**
 * F229 PR-A3a: ConciergePanel — 漫画气泡（Layer 3）
 *
 * V4 (P1): 漫画气泡风格（圆角 + 尖角指向猫 + canvas bg）
 * V2 (P0): 全部颜色从 OKLCH token 来，零 Tailwind 原生色
 *
 * surfaceState='bubble' 时渲染，其他态返回 null（INV-3 variant）
 *
 * Esc 处理：bubble → toolbar（两级返回）
 * INV-7: 非 modal（role="dialog" aria-modal="false"）
 * INV-9: fetchThreadId lazy on first bubble open
 *
 * 对话集成（A3a）：
 *   - 消息流：useConciergeMessages (GET /api/messages) + 乐观插入
 *   - 发送：POST /api/messages { content, threadId }
 *   - 错误：草稿还原 + 错误提示
 *   - streaming token-by-token: Phase B2（需要 socket room join）
 *
 * Liveness (P0 fix):
 *   - Polls /api/threads/:threadId/queue for authoritative activeInvocations
 *   - Replaces 60s local safety valve with server-truth-driven status
 *   - Shows real "值班猫处理中" / "似乎卡住了" / "未收到回复" status
 *
 * z-30: same layer as ball (below FloatingPresentationSurface z-[35])
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { useIMEGuard } from '@/hooks/useIMEGuard';
import { useConciergeStore } from '@/stores/conciergeStore';
import { apiFetch } from '@/utils/api-client';
import { RichBlocks } from '../rich/RichBlocks';
import { ConciergeMessageContent } from './ConciergeMessageContent';
import { useConciergeConfirmations } from './useConciergeConfirmations';
import { useConciergeMessages } from './useConciergeMessages';
import { useConciergeQueue } from './useConciergeQueue';

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
  const { cats } = useCatData();
  const dutyCatDisplayName = cats.find((c) => c.id === dutyCatProfileId)?.displayName;

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // A3a P2 R4 fix: count non-user messages at send time for reply detection
  const catMsgCountAtSendRef = useRef(0);
  const [inputValue, setInputValue] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);

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

  // Auto-scroll to latest message when messages change (guard for JSDOM/no-op envs)
  useEffect(() => {
    const el = messagesEndRef.current;
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  // A3a P2 R4 fix: reply detection — cat reply arrived → return to idle immediately
  useEffect(() => {
    if (invocationStatus !== 'in_progress') return;
    const catCount = messages.filter((m) => !m.isUser).length;
    if (catCount > catMsgCountAtSendRef.current) {
      setInvocationStatus('idle');
    }
  }, [messages, invocationStatus, setInvocationStatus]);

  // Continued polling every 5 s while in_progress (bridges initial burst for slow replies)
  useEffect(() => {
    if (invocationStatus !== 'in_progress') return;
    const id = setInterval(() => refresh(), 5000);
    return () => clearInterval(id);
  }, [invocationStatus, refresh]);

  // P0 liveness fix: server-truth-driven idle transition.
  // When queue says no active invocation, give 3s grace for the reply message
  // to arrive via refresh, then settle to idle. Replaces the blind 60s safety valve.
  // P1 fix (gpt52 review): don't treat isRunning=false as authoritative until first
  // poll succeeds — otherwise a slow/failed first fetch triggers premature idle.
  useEffect(() => {
    if (invocationStatus !== 'in_progress') return;
    if (queueStatus.isRunning || !queueStatus.loaded) return; // still running OR not loaded yet
    // Server says invocation finished; grace period for reply message to arrive
    let settleId: ReturnType<typeof setTimeout> | undefined;
    const graceId = setTimeout(() => {
      refresh();
      // After refresh, the reply-detection effect (catCount comparison) will
      // set idle if a cat reply arrived. If not, force idle after another 1s.
      settleId = setTimeout(() => {
        // Reading from store directly avoids stale closure
        const current = useConciergeStore.getState().invocationStatus;
        if (current === 'in_progress') {
          setInvocationStatus('idle');
        }
      }, 1000);
    }, 2000);
    return () => {
      clearTimeout(graceId);
      if (settleId !== undefined) clearTimeout(settleId);
    };
  }, [invocationStatus, queueStatus.isRunning, queueStatus.loaded, refresh, setInvocationStatus]);

  const handleInputFocus = useCallback(() => setInputFocused(true), [setInputFocused]);
  const handleInputBlur = useCallback(() => setInputFocused(false), [setInputFocused]);
  const handleClose = useCallback(() => setSurfaceState('toolbar'), [setSurfaceState]);
  // AC-A6: muted toggle — accessible from panel
  const handleMuteToggle = useCallback(() => void setMuted(!muted), [muted, setMuted]);

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
      // Continued polling and idle transition handled by the three effects below (cloud R4 fix).
      [800, 2500, 5000].forEach((delay) => setTimeout(() => refresh(), delay));
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
      }}
      className={[
        // Position: above ball, right-aligned (Layer 3 layout §7)
        'fixed bottom-[calc(24px+72px+16px)] right-6',
        'z-30',
        'w-80 max-h-[60vh]',
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
        {/* Header */}
        <div
          style={{ borderBottomColor: 'var(--cafe-border-subtle)' }}
          className="flex items-center gap-2 px-4 py-3 border-b"
        >
          <span style={{ color: 'var(--cafe-text)' }} className="text-sm font-semibold flex-1">
            {/* FIX-4 KD-16 R2: show duty cat's display name (not raw catId) so user
                sees "猫猫球 · 值班：烁烁" instead of "猫猫球 · 值班：gemini25" */}
            {dutyCatProfileId ? `${displayName} · 值班：${dutyCatDisplayName ?? dutyCatProfileId}` : displayName}
          </span>
          {invocationStatus === 'error' && (
            <span style={{ color: 'var(--semantic-critical)' }} className="text-xs" role="status">
              连接失败
            </span>
          )}
          {/* AC-A6: muted toggle */}
          <button
            type="button"
            aria-label={muted ? '取消静音' : '静音'}
            onClick={handleMuteToggle}
            title={muted ? '取消静音，召回猫猫球' : '静音，隐藏猫猫球'}
            style={{
              color: muted ? 'var(--semantic-warning)' : 'var(--cafe-text-muted)',
            }}
            className={[
              'p-1 rounded',
              'transition-colors duration-150',
              'hover:opacity-80',
              'focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--cafe-accent)]',
            ].join(' ')}
          >
            {muted ? '🔔' : '🔕'}
          </button>
          <button
            type="button"
            aria-label="关闭面板"
            onClick={handleClose}
            style={{ color: 'var(--cafe-text-muted)' }}
            className={[
              'p-1 rounded',
              'transition-colors duration-150',
              'hover:opacity-80',
              'focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--cafe-accent)]',
            ].join(' ')}
          >
            ✕
          </button>
        </div>

        {/* Message area — A3a: concierge thread message stream */}
        <div
          role="region"
          className="flex-1 overflow-y-auto px-3 py-3 min-h-[120px]"
          aria-live="polite"
          aria-label="对话内容"
        >
          {invocationStatus === 'error' ? (
            <p style={{ color: 'var(--cafe-text-secondary)' }} className="text-sm text-center mt-4">
              无法加载对话，请重试
            </p>
          ) : isLoading && messages.length === 0 ? (
            <p style={{ color: 'var(--cafe-text-muted)' }} className="text-sm text-center mt-4">
              加载中…
            </p>
          ) : messages.length === 0 ? (
            <p style={{ color: 'var(--cafe-text-secondary)' }} className="text-sm text-center mt-4">
              你好！我是值班前台猫，有什么可以帮你？
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {messages.map((msg) => (
                <div key={msg.id} className={`flex ${msg.isUser ? 'justify-end' : 'justify-start'}`}>
                  <div
                    style={
                      msg.isUser
                        ? {
                            backgroundColor: 'var(--cafe-accent)',
                            color: 'var(--cafe-surface-canvas)',
                          }
                        : {
                            backgroundColor: 'var(--cafe-surface-elevated)',
                            color: 'var(--cafe-text)',
                            // FIX-1: canvas vs elevated 差 0.005 OKLCH 肉眼不可分辨，
                            // 加 border 确保气泡可见（operator 首验 Q3）
                            borderWidth: '1px',
                            borderStyle: 'solid',
                            borderColor: 'var(--cafe-border-subtle)',
                          }
                    }
                    className="max-w-[85%] px-3 py-1.5 rounded-xl text-sm leading-snug whitespace-pre-wrap break-words"
                  >
                    {/* Bug2 method A: inline marker buttons for duty cat replies.
                         User messages render as plain text (no markers to parse). */}
                    {msg.isUser ? (
                      msg.content
                    ) : (
                      <ConciergeMessageContent
                        content={msg.content}
                        actions={
                          msg.richBlocks
                            ?.flatMap((b) => ('actions' in b && Array.isArray(b.actions) ? b.actions : []))
                            .filter(
                              (
                                a,
                              ): a is {
                                action: string;
                                label: string;
                                handle?: string;
                                verb?: string;
                                payload: { threadId: string; messageId?: string };
                              } => typeof a.action === 'string' && typeof a.label === 'string',
                            ) ?? []
                        }
                        messageId={msg.id}
                      />
                    )}
                    {/* R-review R4 P1 fix: render rich blocks (interaction cards) in bubble.
                         Card actions still render below as KD-19 fallback (AC-6). */}
                    {!msg.isUser && msg.richBlocks && msg.richBlocks.length > 0 && (
                      <div className="mt-2">
                        <RichBlocks
                          blocks={msg.richBlocks}
                          messageId={msg.id}
                          confirmations={confirmations.get(msg.id)}
                          sendContext="concierge"
                        />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* P0 liveness status — shows real invocation state from server */}
          {invocationStatus === 'pending' && (
            <div
              style={{ color: 'var(--cafe-text-muted)' }}
              className="text-xs text-center mt-2 animate-pulse"
              role="status"
            >
              发送中…
            </div>
          )}
          {invocationStatus === 'in_progress' && (
            <div style={{ color: 'var(--cafe-text-secondary)' }} className="text-xs text-center mt-2" role="status">
              {queueStatus.isRunning ? (
                <span className="animate-pulse">值班猫正在处理…</span>
              ) : (
                <span className="animate-pulse">确认回复中…</span>
              )}
            </div>
          )}
          {/* Error display */}
          {sendError && (
            <p style={{ color: 'var(--semantic-critical)' }} className="text-xs text-center mt-2">
              {sendError}
            </p>
          )}
          {/* Scroll anchor */}
          <div ref={messagesEndRef} />
        </div>

        {/* Input area */}
        <div style={{ borderTopColor: 'var(--cafe-border-subtle)' }} className="border-t px-3 py-2">
          <textarea
            ref={inputRef}
            rows={2}
            value={inputValue}
            onChange={(e) => {
              setInputValue(e.target.value);
              if (sendError) setSendError(null);
            }}
            onKeyDown={handleKeyDown}
            onCompositionStart={ime.onCompositionStart}
            onCompositionEnd={ime.onCompositionEnd}
            placeholder="发消息给前台猫…"
            aria-label="消息输入框"
            style={{
              backgroundColor: 'var(--cafe-surface-elevated)',
              color: 'var(--cafe-text)',
              borderColor: 'transparent',
            }}
            className={[
              'w-full resize-none text-sm',
              'rounded-lg px-3 py-2',
              'placeholder-[color:var(--cafe-text-muted)]',
              'focus:outline-none',
              'border',
              'transition-colors duration-150',
            ].join(' ')}
            onFocus={handleInputFocus}
            onBlur={handleInputBlur}
          />

          <div className="flex gap-2 mt-1.5">
            <button
              type="button"
              aria-label="发送"
              disabled={
                !inputValue.trim() || invocationStatus === 'pending' || invocationStatus === 'in_progress' || isLoading
              }
              onClick={() => void handleSend()}
              style={{
                backgroundColor: 'var(--cafe-accent)',
                color: 'var(--cafe-surface-canvas)',
              }}
              className={[
                'ml-auto px-3 py-1 rounded-lg text-xs font-medium',
                'transition-opacity duration-150',
                'disabled:opacity-40 disabled:cursor-not-allowed',
                'hover:opacity-90',
                'focus:outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--cafe-accent)]',
              ].join(' ')}
            >
              发送
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
