import { describe, expect, it } from 'vitest';
import { resolveScrollAnchor } from '../useChatHistory';

// Container geometry used across cases: viewport 600, content 1000 → bottom is scrollTop 400.
const AT_BOTTOM = { scrollTop: 400, scrollHeight: 1000, clientHeight: 600 };
const MID = { scrollTop: 200, scrollHeight: 1000, clientHeight: 600 };

describe('resolveScrollAnchor (streaming bottom-anchor stability)', () => {
  it('reports bottom when within the near-bottom threshold', () => {
    expect(resolveScrollAnchor({ ...AT_BOTTOM, prevTop: null, prevAnchor: null })).toBe('bottom');
  });

  it('keeps bottom while streaming grows content below (scrollTop flat, height increases)', () => {
    // User was pinned at bottom; a bubble streams in and grows scrollHeight while scrollTop
    // stays put. The viewport is momentarily NOT within 24px of the new bottom — but the user
    // never scrolled up, so we must not demote to offset (that is the blank-thread bug).
    const anchor = resolveScrollAnchor({
      scrollTop: 400,
      scrollHeight: 1400,
      clientHeight: 600,
      prevTop: 400,
      prevAnchor: 'bottom',
    });
    expect(anchor).toBe('bottom');
  });

  it('keeps bottom during a downward programmatic scroll (scrollTop increasing, not yet at bottom)', () => {
    // Mid smooth-scroll-to-bottom frame: scrollTop is increasing toward the target.
    const anchor = resolveScrollAnchor({
      scrollTop: 350,
      scrollHeight: 1200,
      clientHeight: 600,
      prevTop: 300,
      prevAnchor: 'bottom',
    });
    expect(anchor).toBe('bottom');
  });

  it('demotes to offset only when the user scrolls up away from bottom', () => {
    const anchor = resolveScrollAnchor({
      scrollTop: 200,
      scrollHeight: 1000,
      clientHeight: 600,
      prevTop: 400,
      prevAnchor: 'bottom',
    });
    expect(anchor).toBe('offset');
  });

  it('ignores sub-threshold jitter/reflow nudges (tiny scrollTop decrease keeps prior anchor)', () => {
    const anchor = resolveScrollAnchor({
      scrollTop: 398,
      scrollHeight: 1000,
      clientHeight: 600,
      prevTop: 400,
      prevAnchor: 'bottom',
    });
    expect(anchor).toBe('bottom');
  });

  it('preserves an existing offset anchor when the user has not returned to bottom', () => {
    expect(resolveScrollAnchor({ ...MID, prevTop: 200, prevAnchor: 'offset' })).toBe('offset');
  });

  it('re-anchors to bottom once an offset reader scrolls back down into the threshold', () => {
    expect(resolveScrollAnchor({ ...AT_BOTTOM, prevTop: 200, prevAnchor: 'offset' })).toBe('bottom');
  });

  it('defaults an unseen mid-scroll position to offset (no prior state)', () => {
    expect(resolveScrollAnchor({ ...MID, prevTop: null, prevAnchor: null })).toBe('offset');
  });
});
