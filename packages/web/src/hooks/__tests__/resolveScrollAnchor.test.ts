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
      userScrolledUp: false,
      expected: 'bottom',
    },
    {
      name: 'streaming grows content below (scrollTop flat, height increases) keeps bottom',
      el: geom(400, 1400),
      prev: { top: 400, anchor: 'bottom' as const },
      userScrolledUp: false,
      expected: 'bottom',
    },
    {
      name: 'downward programmatic scroll frame (scrollTop increasing, not yet at bottom) keeps bottom',
      el: geom(350, 1200),
      prev: { top: 300, anchor: 'bottom' as const },
      userScrolledUp: false,
      expected: 'bottom',
    },
    {
      name: 'user scroll-up away from bottom demotes to offset',
      el: geom(200),
      prev: { top: 400, anchor: 'bottom' as const },
      userScrolledUp: true,
      expected: 'offset',
    },
    {
      name: 'programmatic 2px upward correction outside near-bottom band keeps bottom',
      el: geom(198, 1400),
      prev: { top: 200, anchor: 'bottom' as const },
      userScrolledUp: false,
      expected: 'bottom',
    },
    {
      name: '2px upward movement with explicit user input demotes to offset',
      el: geom(198, 1400),
      prev: { top: 200, anchor: 'bottom' as const },
      userScrolledUp: true,
      expected: 'offset',
    },
    {
      name: 'existing offset reader who has not returned to bottom stays offset',
      el: geom(200),
      prev: { top: 200, anchor: 'offset' as const },
      userScrolledUp: false,
      expected: 'offset',
    },
    {
      name: 'offset reader scrolling back into the threshold re-anchors to bottom',
      el: geom(400),
      prev: { top: 200, anchor: 'offset' as const },
      userScrolledUp: false,
      expected: 'bottom',
    },
    {
      name: 'unseen mid-scroll position with no prior state defaults to offset',
      el: geom(200),
      prev: null,
      userScrolledUp: false,
      expected: 'offset',
    },
  ])('$name', ({ el, prev, userScrolledUp, expected }) => {
    expect(resolveScrollAnchor(el, prev, userScrolledUp)).toBe(expected);
  });
});
