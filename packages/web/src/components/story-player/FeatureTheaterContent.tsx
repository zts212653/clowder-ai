'use client';

/**
 * F252 Phase E PR E-4 — Feature Theater Content
 *
 * Orchestrator that wires useFeatureReplay → MultiCamStage + ReplayControls.
 * Feature-level equivalent of TheaterReplayContent (which handles single-thread).
 *
 * AC-E5: Multi-cam split screen layout
 * AC-E3: Spotlight/dim visual state per panel
 */

import { useCallback, useRef, useState } from 'react';
import type { GuestCardState } from '@/lib/story-player/types';
import { useFeatureReplay } from '@/lib/story-player/useFeatureReplay';
import { GuestCard } from './GuestCard';
import { MultiCamStage } from './MultiCamStage';
import { ReplayControls } from './ReplayControls';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FeatureTheaterContent({ featId }: { featId: string }) {
  const {
    threadPanels,
    layout,
    isLoading,
    error,
    engine,
    activeSkip,
    chapters,
    densityBuckets,
    guestCard,
    togglePlayPause,
    doSeek,
    doSetSpeed,
    doToggleDisplayMode,
    doToggleAdaptivePacing,
  } = useFeatureReplay({ featId });

  // Guest card state: snapshot triggered card data so it persists even when
  // playback advances past the cross-feature event (Cloud P2-1 fix).
  // activeCardData holds the card props until onFadeComplete fires.
  const [activeCardData, setActiveCardData] = useState<GuestCardState | null>(null);
  const lastTriggeredIndex = useRef(-1);

  // Trigger: snapshot new cross-feature event data.
  // Reset dedup when guestCard becomes null (seek away) so the same event
  // re-shows on backward-then-forward seek (local P2 fix).
  if (guestCard && guestCard.eventIndex !== lastTriggeredIndex.current) {
    setActiveCardData(guestCard);
    lastTriggeredIndex.current = guestCard.eventIndex;
  } else if (!guestCard && lastTriggeredIndex.current !== -1) {
    lastTriggeredIndex.current = -1;
  }

  const handleGuestCardFade = useCallback(() => {
    setActiveCardData(null);
  }, []);

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
          <span className="text-sm">Loading feature threads...</span>
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

  return (
    <div className="flex flex-col h-full" data-testid="feature-theater-content">
      {/* Multi-cam stage (dynamic layout with spotlight/dim panels) */}
      <div className="relative flex-1 flex flex-col">
        <MultiCamStage panels={threadPanels} layout={layout} displayMode={engine.displayMode} />
        {/* AC-E6: Guest card overlay for cross-feature interactions */}
        {activeCardData && (
          <div
            style={{
              position: 'absolute',
              bottom: '16px',
              right: '16px',
              zIndex: 20,
            }}
          >
            {/* key={eventIndex} forces React to unmount+remount GuestCard when
                the event changes, even if contentSnippet is identical. Without
                this, same-snippet events inherit the prior timer/fading state
                (gpt52 封板 P2 fix). */}
            <GuestCard
              key={activeCardData.eventIndex}
              targetThreadId={activeCardData.targetThreadId}
              contentSnippet={activeCardData.contentSnippet}
              catId={activeCardData.catId}
              visible={!!activeCardData}
              onFadeComplete={handleGuestCardFade}
            />
          </div>
        )}
      </div>

      {/* Shared playback controls */}
      <div className="border-t border-[var(--console-border,rgba(255,255,255,0.1))] px-4 py-3 bg-[var(--console-shell-bg,#111)]">
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
