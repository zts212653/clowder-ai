import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecallCard, recallResultSemanticsLabel } from '../RecallFeed';

describe('RecallFeed result semantics', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('renders coverage relation without inventing a rank', () => {
    expect(
      recallResultSemanticsLabel({
        title: 'Coverage result',
        matchType: 'direct',
      }),
    ).toBe('[matchType:direct]');
  });

  it('keeps ranked result axes explicit', () => {
    expect(
      recallResultSemanticsLabel({
        title: 'Ranked result',
        matchRank: 'high',
        authority: 'validated',
        updatedAt: '2026-07-12T00:00:00Z',
      }),
    ).toBe('[match:high · authority:validated · updated:2026-07-12T00:00:00Z]');
  });

  it('shows ranked and coverage semantics after expanding a recall card', async () => {
    await act(async () => {
      root.render(
        <RecallCard
          event={{
            id: 'recall-1',
            query: 'F263 axes',
            timestamp: Date.now(),
            resultCount: 2,
            results: [
              {
                title: 'Ranked result',
                matchRank: 'high',
                authority: 'validated',
                updatedAt: '2026-07-12T00:00:00Z',
              },
              { title: 'Coverage result', matchType: 'direct' },
            ],
          }}
        />,
      );
    });

    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.textContent).toContain('[match:high · authority:validated · updated:2026-07-12T00:00:00Z]');
    expect(container.textContent).toContain('[matchType:direct]');
  });

  // F263 B.5: source badge, outcome badge, per-result consumed indicators
  it('renders source badge [push] and outcome badge [used]', async () => {
    await act(async () => {
      root.render(
        <RecallCard
          event={{
            id: 'push-used',
            query: 'session data',
            timestamp: Date.now(),
            source: 'push',
            outcome: 'used',
            results: [],
          }}
        />,
      );
    });

    expect(container.textContent).toContain('push');
    expect(container.textContent).toContain('used');
  });

  it('renders source badge [pull] and outcome badge [ign.]', async () => {
    await act(async () => {
      root.render(
        <RecallCard
          event={{
            id: 'pull-ignored',
            query: 'some search',
            timestamp: Date.now(),
            source: 'pull',
            outcome: 'ignored',
            results: [],
          }}
        />,
      );
    });

    expect(container.textContent).toContain('pull');
    expect(container.textContent).toContain('ign.');
  });

  it('renders per-result consumed indicators when expanded', async () => {
    await act(async () => {
      root.render(
        <RecallCard
          event={{
            id: 'mixed-consumed',
            query: 'mixed results',
            timestamp: Date.now(),
            source: 'pull',
            outcome: 'used',
            resultCount: 2,
            results: [
              { title: 'Consumed result', anchor: 'a-1', consumed: true },
              { title: 'Ignored result', anchor: 'a-2', consumed: false },
            ],
          }}
        />,
      );
    });

    // Expand the card
    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const text = container.textContent ?? '';
    // Per-result indicators: 'used' for consumed=true, 'ign.' for consumed=false
    // Count occurrences to distinguish per-result from event-level
    const usedMatches = text.match(/used/g) ?? [];
    const ignMatches = text.match(/ign\./g) ?? [];
    // At least 1 per-result 'used' + event-level 'used' = 2 total
    expect(usedMatches.length).toBeGreaterThanOrEqual(2);
    // At least 1 per-result 'ign.'
    expect(ignMatches.length).toBeGreaterThanOrEqual(1);
  });

  it('renders ign. for all-ignored event results without requiring outcome=used', async () => {
    await act(async () => {
      root.render(
        <RecallCard
          event={{
            id: 'all-ignored',
            query: 'nothing useful',
            timestamp: Date.now(),
            source: 'pull',
            outcome: 'ignored',
            resultCount: 2,
            results: [
              { title: 'Result A', anchor: 'a-1', consumed: false },
              { title: 'Result B', anchor: 'a-2', consumed: false },
            ],
          }}
        />,
      );
    });

    // Expand the card
    await act(async () => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const text = container.textContent ?? '';
    // Event-level ign. badge + 2 per-result ign. badges = 3 total
    const ignMatches = text.match(/ign\./g) ?? [];
    expect(ignMatches.length).toBe(3);
  });
});
