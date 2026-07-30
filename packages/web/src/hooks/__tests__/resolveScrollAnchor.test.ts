import { describe, expect, it } from 'vitest';
import { resolveScrollAnchor } from '../useChatHistory';

// Viewport 600 / content 1000 → bottom is scrollTop 400 (near-bottom band: ≥ 376).
const geom = (scrollTop: number, scrollHeight = 1000) => ({ scrollTop, scrollHeight, clientHeight: 600 });

describe('resolveScrollAnchor (streaming bottom-anchor stability)', () => {
  it.each([
    {
      name: 'within the near-bottom threshold → bottom',
      el: geom(400),
      prev: null,
      expected: 'bottom',
    },
    {
      name: 'streaming grows content below (scrollTop flat, height increases) keeps bottom',
      el: geom(400, 1400),
      prev: { top: 400, anchor: 'bottom' as const },
      expected: 'bottom',
    },
    {
      name: 'downward programmatic scroll frame (scrollTop increasing, not yet at bottom) keeps bottom',
      el: geom(350, 1200),
      prev: { top: 300, anchor: 'bottom' as const },
      expected: 'bottom',
    },
    {
      name: 'user scroll-up away from bottom demotes to offset',
      el: geom(200),
      prev: { top: 400, anchor: 'bottom' as const },
      expected: 'offset',
    },
    {
      name: 'sub-threshold jitter (2px up, outside near-bottom band) keeps bottom',
      el: geom(198, 1400),
      prev: { top: 200, anchor: 'bottom' as const },
      expected: 'bottom',
    },
    {
      name: 'scroll-up just past the intent threshold demotes to offset',
      el: geom(195, 1400),
      prev: { top: 200, anchor: 'bottom' as const },
      expected: 'offset',
    },
    {
      name: 'existing offset reader who has not returned to bottom stays offset',
      el: geom(200),
      prev: { top: 200, anchor: 'offset' as const },
      expected: 'offset',
    },
    {
      name: 'offset reader scrolling back into the threshold re-anchors to bottom',
      el: geom(400),
      prev: { top: 200, anchor: 'offset' as const },
      expected: 'bottom',
    },
    {
      name: 'unseen mid-scroll position with no prior state defaults to offset',
      el: geom(200),
      prev: null,
      expected: 'offset',
    },
  ])('$name', ({ el, prev, expected }) => {
    expect(resolveScrollAnchor(el, prev)).toBe(expected);
  });
});
