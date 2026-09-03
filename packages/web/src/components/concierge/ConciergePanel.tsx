'use client';

/**
 * F229 Cat Ball compact adapter.
 *
 * Conversation semantics live in ThreadChatSurface. This component owns only
 * bubble chrome, size, concierge-thread discovery and read-only pet activity.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useCatData } from '@/hooks/useCatData';
import { resolveCatDisplayName } from '@/lib/cat-display-name';
import { useConciergeStore } from '@/stores/conciergeStore';
import { type ThreadChatActivity, ThreadChatSurface } from '../thread-chat';
import { ConciergePanelHeader, ConciergePanelResizeHandles } from './ConciergePanelChrome';
import { useConciergeConfirmations } from './useConciergeConfirmations';
import { usePanelWidth } from './usePanelWidth';

export function ConciergePanel() {
  const surfaceState = useConciergeStore((state) => state.surfaceState);
  const setSurfaceState = useConciergeStore((state) => state.setSurfaceState);
  const setInputFocused = useConciergeStore((state) => state.setInputFocused);
  const fetchThreadId = useConciergeStore((state) => state.fetchThreadId);
  const displayName = useConciergeStore((state) => state.displayName);
  const dutyCatProfileId = useConciergeStore((state) => state.dutyCatProfileId);
  const invocationStatus = useConciergeStore((state) => state.invocationStatus);
  const setInvocationStatus = useConciergeStore((state) => state.setInvocationStatus);
  const muted = useConciergeStore((state) => state.muted);
  const setMuted = useConciergeStore((state) => state.setMuted);
  const notifyMessage = useConciergeStore((state) => state.notifyMessage);
  const threadId = useConciergeStore((state) => state.threadId);
  const pendingPrompt = useConciergeStore((state) => state.pendingPrompt);
  const clearPendingPrompt = useConciergeStore((state) => state.clearPendingPrompt);
  const { getCatById } = useCatData();
  const dutyCatDisplayName = dutyCatProfileId ? resolveCatDisplayName(dutyCatProfileId, getCatById) : undefined;
  const seenMessageCountRef = useRef<number | null>(null);
  const seedSequenceRef = useRef(0);
  const [composerSeed, setComposerSeed] = useState<{ id: string; text: string }>();
  const { confirmations: messageConfirmations } = useConciergeConfirmations(surfaceState === 'bubble');

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

  useEffect(() => {
    if (surfaceState === 'bubble') void fetchThreadId();
  }, [fetchThreadId, surfaceState]);

  useEffect(() => {
    if (surfaceState !== 'bubble' || pendingPrompt === null) return;
    seedSequenceRef.current += 1;
    setComposerSeed({ id: `concierge-prompt-${seedSequenceRef.current}`, text: pendingPrompt });
    clearPendingPrompt();
  }, [clearPendingPrompt, pendingPrompt, surfaceState]);

  useEffect(() => {
    if (surfaceState !== 'bubble') return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSurfaceState('toolbar');
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [setSurfaceState, surfaceState]);

  const handleActivity = useCallback(
    (activity: ThreadChatActivity) => {
      setInvocationStatus(activity.hasActiveInvocation ? 'in_progress' : 'idle');
      const previousCount = seenMessageCountRef.current;
      seenMessageCountRef.current = activity.messageCount;
      if (previousCount !== null && activity.messageCount > previousCount) notifyMessage();
    },
    [notifyMessage, setInvocationStatus],
  );

  const handleClose = useCallback(() => setSurfaceState('toolbar'), [setSurfaceState]);
  const handleVisibilityToggle = useCallback(() => {
    if (muted) {
      void setMuted(false);
      return;
    }
    void setMuted(true);
    setSurfaceState('collapsed');
  }, [muted, setMuted, setSurfaceState]);

  const seedStarter = useCallback(() => {
    seedSequenceRef.current += 1;
    setComposerSeed({ id: `concierge-starter-${seedSequenceRef.current}`, text: '你能帮我什么？' });
  }, []);

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
        width: panelWidth,
        height: panelHeight,
      }}
      className={[
        'fixed bottom-[calc(24px+72px+16px)] right-6',
        'z-30 flex flex-col rounded-2xl border',
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
      <div
        className="absolute -bottom-2 right-8 h-0 w-0"
        style={{
          borderLeft: '8px solid transparent',
          borderRight: '8px solid transparent',
          borderTop: '8px solid var(--cafe-border-subtle)',
        }}
        aria-hidden="true"
      />
      <div
        className="absolute -bottom-[7px] right-8 h-0 w-0"
        style={{
          borderLeft: '7px solid transparent',
          borderRight: '7px solid transparent',
          borderTop: '7px solid var(--cafe-surface-canvas)',
        }}
        aria-hidden="true"
      />
      <div data-testid="concierge-inner-content" className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl">
        <ConciergePanelHeader
          title={dutyCatProfileId ? `${displayName} · 值班：${dutyCatDisplayName ?? dutyCatProfileId}` : displayName}
          invocationStatus={invocationStatus}
          muted={muted}
          isExpanded={isExpanded}
          onVisibilityToggle={handleVisibilityToggle}
          onToggleExpanded={toggleExpanded}
          onClose={handleClose}
        />
        {threadId ? (
          <ThreadChatSurface
            threadId={threadId}
            density="compact"
            messageConfirmations={messageConfirmations}
            composerPlaceholder="发消息给猫猫球…"
            composerSeed={composerSeed}
            onComposerFocusChange={setInputFocused}
            onActivity={handleActivity}
            emptyState={
              <div className="mt-4 flex flex-col items-center gap-3 text-center">
                <p className="text-sm text-cafe-secondary">你好！我是猫猫球，有什么可以帮你？</p>
                <button
                  type="button"
                  aria-label="问问猫猫能帮什么"
                  onClick={seedStarter}
                  className="rounded-full border border-cafe-divider bg-cafe-surface px-3 py-1.5 text-xs text-cafe-secondary"
                >
                  我能帮你做什么？
                </button>
              </div>
            }
          />
        ) : (
          <p className="mt-4 text-center text-sm text-cafe-muted">正在准备猫猫球…</p>
        )}
      </div>
    </div>
  );
}
