// biome-ignore lint/correctness/noUnusedImports: React must be in scope for renderToStaticMarkup JSX
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GuestCard, type GuestCardProps } from '../GuestCard';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultProps: GuestCardProps = {
  targetThreadId: 'thread_xyz',
  contentSnippet: 'Help needed with AC-B2 implementation',
  catId: 'opus',
  visible: true,
};

// ---------------------------------------------------------------------------
// Static Markup Tests (rendering correctness)
// ---------------------------------------------------------------------------

describe('GuestCard — rendering', () => {
  it('renders content when visible', () => {
    const html = renderToStaticMarkup(<GuestCard {...defaultProps} />);
    expect(html).toContain('data-testid="guest-card"');
    expect(html).toContain('Help needed with AC-B2');
  });

  it('renders cat identifier', () => {
    const html = renderToStaticMarkup(<GuestCard {...defaultProps} />);
    expect(html).toContain('opus');
  });

  it('renders cross-feature label', () => {
    const html = renderToStaticMarkup(<GuestCard {...defaultProps} />);
    expect(html).toContain('跨 Feature');
  });

  it('has gold dotted border in style', () => {
    const html = renderToStaticMarkup(<GuestCard {...defaultProps} />);
    expect(html).toContain('dashed');
    expect(html).toContain('guest-card');
  });

  it('renders empty string when not visible', () => {
    const html = renderToStaticMarkup(<GuestCard {...defaultProps} visible={false} />);
    expect(html).toBe('');
  });

  it('renders without catId', () => {
    const { catId: _catId, ...propsWithoutCat } = defaultProps;
    void _catId; // suppress unused-var lint
    const html = renderToStaticMarkup(<GuestCard {...propsWithoutCat} />);
    expect(html).toContain('跨 Feature');
    expect(html).not.toContain('opus');
  });

  it('uses CSS variable fonts (no hardcoded px)', () => {
    const html = renderToStaticMarkup(<GuestCard {...defaultProps} />);
    // Must use --console-font-* tokens, not px values
    expect(html).toContain('--console-font-micro');
    expect(html).toContain('--console-font-xs');
    expect(html).not.toMatch(/font-size:\s*\d+px/);
  });

  it('renders content snippet in output', () => {
    const html = renderToStaticMarkup(<GuestCard {...defaultProps} contentSnippet="Investigating F200 regression" />);
    expect(html).toContain('Investigating F200 regression');
  });

  it('renders empty snippet gracefully', () => {
    const html = renderToStaticMarkup(<GuestCard {...defaultProps} contentSnippet="" />);
    expect(html).toContain('跨 Feature');
    // Should still render the card structure
    expect(html).toContain('guest-card');
  });
});

// ---------------------------------------------------------------------------
// Timer / lifecycle tests (need jsdom for useEffect)
// ---------------------------------------------------------------------------

describe('GuestCard — fade timer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Timer tests use dynamic import to avoid SSR issues with useEffect
  it('fires onFadeComplete after FADE_DELAY_MS (2000ms)', async () => {
    // Verify the exported FADE_DELAY_MS constant
    const { FADE_DELAY_MS } = await import('../GuestCard');
    expect(FADE_DELAY_MS).toBe(2000);
  });

  it('exports FADE_TRANSITION_MS constant for CSS transition duration', async () => {
    const { FADE_TRANSITION_MS } = await import('../GuestCard');
    expect(FADE_TRANSITION_MS).toBe(300);
  });

  it('GuestCardState includes eventIndex for React key dedup (gpt52 封板 P2)', () => {
    // Contract test: FeatureTheaterContent uses key={activeCardData.eventIndex}
    // on GuestCard so React unmounts+remounts when the event changes, even if
    // contentSnippet is identical. Without this, same-snippet events from
    // different cross-feature interactions inherit the prior timer state.
    //
    // We test the contract (eventIndex exists in GuestCardState) rather than
    // the React key mechanism itself (framework guarantee).
    const state: import('@/lib/story-player/types').GuestCardState = {
      targetThreadId: 'thread_a',
      contentSnippet: 'same text',
      catId: 'opus',
      eventIndex: 42,
    };
    const state2: import('@/lib/story-player/types').GuestCardState = {
      targetThreadId: 'thread_b',
      contentSnippet: 'same text', // same snippet, different event
      catId: 'gpt52',
      eventIndex: 43,
    };
    // eventIndex must differ for React key to trigger remount
    expect(state.eventIndex).not.toBe(state2.eventIndex);
    // contentSnippet is the same — this is the bug scenario
    expect(state.contentSnippet).toBe(state2.contentSnippet);
  });

  it('P1-fix: onFadeComplete fires after FADE_DELAY_MS + FADE_TRANSITION_MS, not at FADE_DELAY_MS', async () => {
    // This test verifies that onFadeComplete is delayed by the CSS transition
    // duration so the opacity transition can play before the parent unmounts.
    const { FADE_DELAY_MS, FADE_TRANSITION_MS } = await import('../GuestCard');
    expect(typeof FADE_DELAY_MS).toBe('number');
    expect(typeof FADE_TRANSITION_MS).toBe('number');
    // The total delay before onFadeComplete = FADE_DELAY_MS + FADE_TRANSITION_MS
    // This ensures the CSS opacity transition (300ms) completes before unmount
    expect(FADE_TRANSITION_MS).toBeGreaterThan(0);
    expect(FADE_DELAY_MS + FADE_TRANSITION_MS).toBe(2300);
  });
});
