'use client';

/**
 * F252 Phase E — Theater Replay Content
 *
 * Integrates useThreadReplay + ReplayMessageList + ReplayControls
 * into the content rendered inside TheaterOverlay.
 */

import { useThreadReplay } from '@/lib/story-player/useThreadReplay';
import { ReplayControls } from './ReplayControls';
import { ReplayMessageList } from './ReplayMessageList';

interface TheaterReplayContentProps {
  threadId: string;
}

export function TheaterReplayContent({ threadId }: TheaterReplayContentProps) {
  const {
    messages,
    isLoading,
    error,
    engine,
    activeSkip,
    chapters,
    densityBuckets,
    togglePlayPause,
    doSeek,
    doSetSpeed,
    // doStepForward / doStepBackward available for keyboard shortcuts (PR E-2)
    doToggleDisplayMode,
    doToggleAdaptivePacing,
  } = useThreadReplay({ threadId });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="flex items-center gap-3 text-[var(--console-text-secondary,#aaa)]">
          <svg
            className="animate-spin h-5 w-5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" opacity="0.25" />
            <path d="M12 2a10 10 0 0 1 10 10" opacity="0.75" />
          </svg>
          <span className="text-sm">Loading thread events...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <p className="text-sm text-[var(--semantic-critical,#f44)]">{error}</p>
          <p className="text-xs text-[var(--console-text-tertiary,#888)] mt-2">Try closing and reopening the replay</p>
        </div>
      </div>
    );
  }

  const emptyStateLabel =
    engine.totalEvents === 0
      ? 'No replayable events yet — this thread may only have live or unsealed messages.'
      : 'Press play to start replay';

  return (
    <div className="flex flex-col h-full">
      {/* Message list (scrollable) — paddingBottom reserves space for fixed ReplayControls */}
      <div className="flex-1 overflow-y-auto px-4 py-4" style={{ paddingBottom: '64px' }}>
        <ReplayMessageList
          messages={messages}
          autoScroll={engine.state === 'playing'}
          emptyStateLabel={emptyStateLabel}
          displayMode={engine.displayMode}
        />
      </div>

      {/* Playback controls */}
      <div className="border-t border-[var(--console-border-soft)] px-4 py-3 bg-[var(--console-shell-bg,#111)]">
        <ReplayControls
          engine={engine}
          activeSkip={activeSkip}
          chapters={chapters}
          densityBuckets={densityBuckets}
          onTogglePlayPause={togglePlayPause}
          onSeek={doSeek}
          onSetSpeed={doSetSpeed}
          onToggleDisplayMode={doToggleDisplayMode}
          onToggleAdaptivePacing={doToggleAdaptivePacing}
        />
      </div>
    </div>
  );
}
