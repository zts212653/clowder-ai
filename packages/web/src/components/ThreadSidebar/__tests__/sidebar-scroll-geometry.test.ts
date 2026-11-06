// @vitest-environment jsdom
/** F314-15: the thread list and the attention groups measure rows with these helpers. */
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_VIEWPORT_HEIGHT_PX,
  offsetTopWithin,
  viewportHeight,
  visibleTopInset,
} from '@/components/ThreadSidebar/sidebar-scroll-geometry';

function box(props: Partial<{ offsetTop: number; offsetParent: HTMLElement | null; clientHeight: number }>) {
  const el = document.createElement('div');
  for (const [key, value] of Object.entries(props)) Object.defineProperty(el, key, { value, configurable: true });
  return el;
}

function rect(el: HTMLElement, top: number, bottom: number) {
  el.getBoundingClientRect = () => ({
    top,
    bottom,
    left: 0,
    right: 0,
    width: 0,
    height: bottom - top,
    x: 0,
    y: top,
    toJSON: () => ({}),
  });
}

describe('sidebar scroll geometry (F314-15)', () => {
  it('sums offsets up to the scroll container', () => {
    const container = box({});
    const group = box({ offsetTop: 120, offsetParent: container });
    const list = box({ offsetTop: 30, offsetParent: group });
    expect(offsetTopWithin(list, container)).toBe(150);
  });

  it('reports how much of the top a sticky header covers, and nothing when it has scrolled away', () => {
    const container = box({});
    rect(container, 100, 700);
    const header = document.createElement('div');
    header.setAttribute('data-scroll-occluder', 'true');
    container.appendChild(header);

    rect(header, 100, 140);
    expect(visibleTopInset(container)).toBe(40);
    rect(header, 60, 90);
    expect(visibleTopInset(container)).toBe(0);
    container.removeChild(header);
    expect(visibleTopInset(container)).toBe(0);
  });

  it('falls back to a fixed height before layout', () => {
    expect(viewportHeight(box({ clientHeight: 0 }))).toBe(FALLBACK_VIEWPORT_HEIGHT_PX);
    expect(viewportHeight(box({ clientHeight: 480 }))).toBe(480);
  });
});
