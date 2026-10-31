/**
 * F252 Phase E PR E-3 — ReplayControls chapter tooltip time accuracy
 *
 * Regression test: chapter tooltip "at X:XX" must use the chapter's
 * actual timestamp offset, not an index-ratio approximation.
 *
 * With uneven event spacing (e.g. events at t=0, t=100, t=600_000),
 * the index-ratio formula gives wildly wrong times for early chapters.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chapter } from '@/lib/story-player/chapters';
import type { ReplayEngineState } from '@/lib/story-player/types';
import { ReplayControls } from '../ReplayControls';

// ---------------------------------------------------------------------------
// DOM setup
// ---------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEngine(overrides: Partial<ReplayEngineState> = {}): ReplayEngineState {
  return {
    state: 'paused',
    speed: 1,
    currentIndex: 0,
    totalEvents: 3,
    elapsedMs: 0,
    totalDurationMs: 600_000, // 10 minutes
    displayMode: 'cinematic',
    adaptivePacing: true,
    bulletTime: null,
    ...overrides,
  };
}

const noop = () => {};

function renderControls(engine: ReplayEngineState, chapters: Chapter[]) {
  act(() => {
    root.render(
      <ReplayControls
        engine={engine}
        activeSkip={null}
        chapters={chapters}
        densityBuckets={[]}
        onTogglePlayPause={noop}
        onSeek={noop}
        onSetSpeed={noop}
        onToggleDisplayMode={noop}
        onToggleAdaptivePacing={noop}
      />,
    );
  });
}

function renderControlsWithCallbacks(
  engine: ReplayEngineState,
  callbacks: Partial<{
    onTogglePlayPause: () => void;
    onSeek: (index: number) => void;
  }> = {},
) {
  act(() => {
    root.render(
      <ReplayControls
        engine={engine}
        activeSkip={null}
        chapters={[]}
        densityBuckets={[]}
        onTogglePlayPause={callbacks.onTogglePlayPause ?? noop}
        onSeek={callbacks.onSeek ?? noop}
        onSetSpeed={noop}
        onToggleDisplayMode={noop}
        onToggleAdaptivePacing={noop}
      />,
    );
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReplayControls chapter tooltip time', () => {
  it('tooltip shows actual timestamp offset, not index-ratio approximation', () => {
    // 3 events: session start at 0ms, pass_ball at 100ms, session end at 10min
    // Old index-ratio: (1/2) * 600_000 = 300_000ms → "5:00" (WRONG)
    // Correct: 100ms offset → "0:00"
    const chapters: Chapter[] = [
      { kind: 'session_start', label: 'Start', eventIndex: 0, timestamp: 1_000_000 },
      { kind: 'pass_ball', label: '→ @codex', eventIndex: 1, timestamp: 1_000_100 },
      { kind: 'session_end', label: 'End', eventIndex: 2, timestamp: 1_600_000 },
    ];

    renderControls(makeEngine(), chapters);

    const badge = container.querySelector('[data-chapter-kind="pass_ball"]') as HTMLElement;
    expect(badge).not.toBeNull();

    // Hover to show tooltip
    act(() => {
      badge.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    const tooltip = badge.querySelector('[role="tooltip"]');
    expect(tooltip).not.toBeNull();

    // 100ms offset → "0:00", NOT "5:00" from index-ratio
    const tooltipText = tooltip?.textContent ?? '';
    expect(tooltipText).toContain('at 0:00');
    expect(tooltipText).not.toContain('at 5:00');
  });

  it('tooltip shows correct time when session_start is deduped by pass_ball at index 0', () => {
    // When event[0] is a pass_ball, extractChapters creates both session_start
    // and pass_ball at index 0. Dedup keeps pass_ball (priority 4 > 1), so
    // chapters array has NO session_start. The baseline must still derive from
    // the earliest chapter timestamp, not fall back to epoch 0.
    const chapters: Chapter[] = [
      // session_start deduped — pass_ball wins at index 0
      { kind: 'pass_ball', label: '→ @codex', eventIndex: 0, timestamp: 1_000_000 },
      { kind: 'invocation', label: 'Invocation abc', eventIndex: 2, timestamp: 1_300_000 },
      { kind: 'session_end', label: 'End', eventIndex: 3, timestamp: 1_600_000 },
    ];

    renderControls(makeEngine({ totalEvents: 4 }), chapters);

    // Hover invocation badge — should show 5:00 (300_000ms offset from first chapter)
    const badge = container.querySelector('[data-chapter-kind="invocation"]') as HTMLElement;
    expect(badge).not.toBeNull();

    act(() => {
      badge.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    const tooltip = badge.querySelector('[role="tooltip"]');
    expect(tooltip).not.toBeNull();

    const tooltipText = tooltip?.textContent ?? '';
    // Correct: 1_300_000 - 1_000_000 = 300_000ms = 5:00
    expect(tooltipText).toContain('at 5:00');
    // Wrong (epoch-based): 1_300_000ms → ~21:40 — must NOT happen
    expect(tooltipText).not.toContain('at 21:');
  });

  it('chapter at actual 5-minute mark shows 5:00 regardless of event distribution', () => {
    // 4 events total; pass_ball at 5 minutes (300_000ms) is at index 1 of 4
    // Old index-ratio: (1/3) * 600_000 = 200_000ms → "3:20" (WRONG)
    // Correct: 300_000ms offset → "5:00"
    const chapters: Chapter[] = [
      { kind: 'session_start', label: 'Start', eventIndex: 0, timestamp: 0 },
      { kind: 'pass_ball', label: '→ @gpt52', eventIndex: 1, timestamp: 300_000 },
      { kind: 'session_end', label: 'End', eventIndex: 3, timestamp: 600_000 },
    ];

    renderControls(makeEngine({ totalEvents: 4 }), chapters);

    const badge = container.querySelector('[data-chapter-kind="pass_ball"]') as HTMLElement;
    expect(badge).not.toBeNull();

    act(() => {
      badge.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });

    const tooltip = badge.querySelector('[role="tooltip"]');
    expect(tooltip).not.toBeNull();

    const tooltipText = tooltip?.textContent ?? '';
    expect(tooltipText).toContain('at 5:00');
    expect(tooltipText).not.toContain('at 3:20');
  });
});

describe('ReplayControls empty replay state', () => {
  it('shows 0 / 0 instead of 1 / 0 when there are no replay events', () => {
    renderControlsWithCallbacks(makeEngine({ totalEvents: 0, totalDurationMs: 0 }));

    expect(container.textContent).toContain('0 / 0');
    expect(container.textContent).not.toContain('1 / 0');
  });

  it('disables play and seek controls when there are no replay events', () => {
    const onTogglePlayPause = vi.fn();
    const onSeek = vi.fn();
    renderControlsWithCallbacks(makeEngine({ totalEvents: 0, totalDurationMs: 0 }), {
      onTogglePlayPause,
      onSeek,
    });

    const playButton = container.querySelector('button[aria-label="Play"]') as HTMLButtonElement;
    expect(playButton.disabled).toBe(true);

    act(() => {
      playButton.click();
    });
    expect(onTogglePlayPause).not.toHaveBeenCalled();

    const progress = container.querySelector('[role="slider"]') as HTMLElement;
    act(() => {
      progress.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      progress.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 1 }));
    });

    expect(onSeek).not.toHaveBeenCalled();
  });
});
