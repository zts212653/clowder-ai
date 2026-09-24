import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { focusLineageMessage } from '@/utils/focusLineageMessage';
import {
  captureMessageScrollAnchor,
  captureMessageScrollAnchorForElement,
  restoreMessageScrollAnchor,
  restoreTimelineScrollAnchor,
  scrollToMessage,
} from '@/utils/scrollToMessage';

// jsdom doesn't provide CSS.escape — polyfill for tests
beforeAll(() => {
  if (!globalThis.CSS) {
    (globalThis as Record<string, unknown>).CSS = {};
  }
  if (!CSS.escape) {
    CSS.escape = (value: string) => value.replace(/([^\w-])/g, '\\$1');
  }
});

describe('scrollToMessage', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('captures the first visible message relative to the scroll viewport', () => {
    const container = document.createElement('div');
    container.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
    const above = document.createElement('div');
    above.dataset.messageViewportId = 'above';
    above.getBoundingClientRect = () => ({ top: 0, bottom: 80 }) as DOMRect;
    const visible = document.createElement('div');
    visible.dataset.messageViewportId = 'visible';
    visible.getBoundingClientRect = () => ({ top: 76, bottom: 260 }) as DOMRect;
    container.append(above, visible);
    document.body.appendChild(container);

    expect(captureMessageScrollAnchor(container)).toEqual({
      messageId: 'visible',
      viewportOffsetPx: -24,
    });
  });

  it('restores the same message-relative position after predecessor geometry changes', () => {
    const container = document.createElement('div');
    container.scrollTop = 400;
    container.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
    const targetBoundary = document.createElement('div');
    targetBoundary.dataset.messageViewportId = 'target';
    targetBoundary.getBoundingClientRect = () => ({ top: 280, bottom: 520 }) as DOMRect;
    const target = document.createElement('div');
    target.dataset.messageId = 'target';
    targetBoundary.appendChild(target);
    container.appendChild(targetBoundary);
    document.body.appendChild(container);

    expect(
      restoreMessageScrollAnchor(container, {
        messageId: 'target',
        viewportOffsetPx: 20,
      }),
    ).toBe(true);
    expect(container.scrollTop).toBe(560);
  });

  it('anchors the visible paragraph inside a taller-than-viewport card', () => {
    const container = document.createElement('div');
    container.scrollTop = 500;
    container.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
    const boundary = document.createElement('div');
    boundary.dataset.messageViewportId = 'long';
    boundary.getBoundingClientRect = () => ({ top: -900, bottom: 950 }) as DOMRect;
    const target = document.createElement('div');
    target.dataset.messageId = 'long';
    const above = document.createElement('p');
    above.textContent = 'above';
    above.getBoundingClientRect = () => ({ top: -300, bottom: 50 }) as DOMRect;
    const reading = document.createElement('p');
    reading.textContent = 'reading paragraph';
    let readingTop = 180;
    reading.getBoundingClientRect = () => ({ top: readingTop, bottom: readingTop + 150 }) as DOMRect;
    target.append(above, reading);
    boundary.append(target);
    container.append(boundary);
    document.body.append(container);

    const anchor = captureMessageScrollAnchor(container);
    expect(anchor).toEqual({
      messageId: 'long',
      viewportOffsetPx: -1_000,
      blockIndex: 1,
      blockFingerprint: 'p:reading paragraph',
      blockViewportOffsetPx: 80,
    });
    readingTop = 260; // content above the paragraph expanded; card top did not move
    if (!anchor) throw new Error('expected a visible paragraph anchor');
    expect(restoreMessageScrollAnchor(container, anchor)).toBe(true);
    expect(container.scrollTop).toBe(580);
  });

  it('finds the same paragraph when earlier reading blocks are folded away', () => {
    const container = document.createElement('div');
    container.scrollTop = 500;
    container.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
    const boundary = document.createElement('div');
    boundary.dataset.messageViewportId = 'long';
    boundary.getBoundingClientRect = () => ({ top: -900, bottom: 950 }) as DOMRect;
    const target = document.createElement('div');
    target.dataset.messageId = 'long';
    const paragraphs = ['folded one', 'folded two', 'main one', 'main two', 'main three', 'main four'].map(
      (content) => {
        const paragraph = document.createElement('p');
        paragraph.textContent = content;
        return paragraph;
      },
    );
    let mainTwoTop = 180;
    let mainFourTop = 380;
    paragraphs.forEach((paragraph, index) => {
      paragraph.getBoundingClientRect = () => {
        const top = index === 3 ? mainTwoTop : index === 5 ? mainFourTop : -400;
        return { top, bottom: top + 80 } as DOMRect;
      };
    });
    target.append(...paragraphs);
    boundary.append(target);
    container.append(boundary);
    document.body.append(container);

    const anchor = captureMessageScrollAnchor(container);
    expect(anchor?.blockIndex).toBe(3);
    if (!anchor) throw new Error('expected a paragraph anchor');
    paragraphs[0].remove();
    paragraphs[1].remove();
    mainTwoTop = -220;
    mainFourTop = 180; // Old index 3 now names the wrong paragraph at the old offset.

    expect(restoreMessageScrollAnchor(container, anchor)).toBe(true);
    expect(container.scrollTop).toBe(100);
  });

  it('falls back to the message boundary when the viewed paragraph disappears', () => {
    const container = document.createElement('div');
    container.scrollTop = 500;
    container.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
    const boundary = document.createElement('div');
    boundary.dataset.messageViewportId = 'long';
    let boundaryTop = -900;
    boundary.getBoundingClientRect = () => ({ top: boundaryTop, bottom: 950 }) as DOMRect;
    const target = document.createElement('div');
    target.dataset.messageId = 'long';
    const preceding = document.createElement('p');
    preceding.textContent = 'preceding';
    preceding.getBoundingClientRect = () => ({ top: -300, bottom: -220 }) as DOMRect;
    const viewed = document.createElement('p');
    viewed.textContent = 'viewed';
    viewed.getBoundingClientRect = () => ({ top: 180, bottom: 260 }) as DOMRect;
    const replacement = document.createElement('p');
    replacement.textContent = 'replacement';
    replacement.getBoundingClientRect = () => ({ top: 180, bottom: 260 }) as DOMRect;
    target.append(preceding, viewed, replacement);
    boundary.append(target);
    container.append(boundary);
    document.body.append(container);

    const anchor = captureMessageScrollAnchor(container);
    expect(anchor?.blockIndex).toBe(1);
    if (!anchor) throw new Error('expected a paragraph anchor');
    viewed.remove();
    boundaryTop = -800;

    expect(restoreMessageScrollAnchor(container, anchor)).toBe(true);
    expect(container.scrollTop).toBe(600); // Preserve the message's original -1000px offset.
  });

  it('captures a clicked disclosure as offset intent even when the viewport was at bottom', () => {
    const container = document.createElement('div');
    container.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
    const boundary = document.createElement('div');
    boundary.dataset.messageViewportId = 'expanded';
    boundary.getBoundingClientRect = () => ({ top: 50, bottom: 800 }) as DOMRect;
    const target = document.createElement('div');
    target.dataset.messageId = 'expanded';
    const button = document.createElement('button');
    button.dataset.readingDisclosure = '';
    button.textContent = 'Expand section';
    button.getBoundingClientRect = () => ({ top: 380, bottom: 420 }) as DOMRect;
    target.append(button);
    boundary.append(target);
    container.append(boundary);
    document.body.append(container);
    expect(captureMessageScrollAnchorForElement(container, button)).toEqual({
      messageId: 'expanded',
      viewportOffsetPx: -50,
      blockIndex: 0,
      blockFingerprint: 'button:Expand section',
      blockViewportOffsetPx: 280,
    });
  });

  it('keeps a user at the bottom after an earlier message reorders', () => {
    const container = document.createElement('div');
    Object.defineProperties(container, {
      scrollHeight: { configurable: true, value: 1_200 },
      clientHeight: { configurable: true, value: 300 },
    });
    container.scrollTop = 640;

    expect(restoreTimelineScrollAnchor(container, { kind: 'bottom' })).toBe(true);
    expect(container.scrollTop).toBe(900);
  });

  it('keeps the viewed message at the same viewport offset after sibling order changes', () => {
    const container = document.createElement('div');
    container.scrollTop = 400;
    container.getBoundingClientRect = () => ({ top: 100, bottom: 700 }) as DOMRect;
    const targetBoundary = document.createElement('div');
    targetBoundary.dataset.messageViewportId = 'viewed';
    targetBoundary.getBoundingClientRect = () => ({ top: 340, bottom: 520 }) as DOMRect;
    const target = document.createElement('div');
    target.dataset.messageId = 'viewed';
    targetBoundary.appendChild(target);
    container.appendChild(targetBoundary);
    document.body.appendChild(container);

    expect(
      restoreTimelineScrollAnchor(container, {
        kind: 'message',
        messageAnchor: { messageId: 'viewed', viewportOffsetPx: 40 },
      }),
    ).toBe(true);
    expect(container.scrollTop).toBe(600);
  });

  it('scrolls to the element with matching data-message-id', () => {
    const el = document.createElement('div');
    el.setAttribute('data-message-id', 'msg-123');
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);

    scrollToMessage('msg-123');

    expect(el.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'center',
    });
  });

  it('uses the shared message-jump marker and removes it after timeout', () => {
    vi.useFakeTimers();
    const el = document.createElement('div');
    el.setAttribute('data-message-id', 'msg-456');
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);

    scrollToMessage('msg-456');

    expect(el.dataset.messageJumpFocus).toBe('true');
    expect(el.classList.contains('ring-blue-400')).toBe(false);

    vi.advanceTimersByTime(3200);

    expect(el.dataset.messageJumpFocus).toBeUndefined();

    vi.useRealTimers();
  });

  it('uses the same marker for lineage jumps', () => {
    vi.useFakeTimers();
    const el = document.createElement('div');
    el.setAttribute('data-message-id', 'lineage-msg');
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);

    expect(focusLineageMessage('lineage-msg')).toBe(true);
    expect(el.dataset.messageJumpFocus).toBe('true');

    vi.advanceTimersByTime(3200);
    expect(el.dataset.messageJumpFocus).toBeUndefined();
    vi.useRealTimers();
  });

  it('renders the shared marker as an orange open-left bracket rather than a full outline', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf8');
    const markerRule = css.match(/\[data-message-jump-focus="true"\]::after\s*\{([^}]*)\}/)?.[1] ?? '';

    expect(markerRule).toContain('border: 2px solid var(--color-cocreator-primary)');
    expect(markerRule).toContain('border-left: 0');
    expect(markerRule).not.toContain('outline:');
  });

  it('does nothing when element is not found', () => {
    // Should not throw
    scrollToMessage('nonexistent-id');
  });

  it('returns true when the target element is found (lets callers retry until DOM is ready)', () => {
    const el = document.createElement('div');
    el.setAttribute('data-message-id', 'msg-789');
    el.scrollIntoView = vi.fn();
    document.body.appendChild(el);

    expect(scrollToMessage('msg-789')).toBe(true);
  });

  it('returns false when no matching element exists', () => {
    expect(scrollToMessage('missing-id')).toBe(false);
  });

  it('temporarily reveals a folded source return anchor only after navigation hits it', () => {
    vi.useFakeTimers();
    const el = document.createElement('div');
    el.setAttribute('data-message-id', 'msg-folded');
    el.setAttribute('data-folded-source-anchor', 'child-1');
    el.setAttribute('aria-hidden', 'true');
    el.className = 'h-0 overflow-hidden';
    el.scrollIntoView = vi.fn();
    const affordance = document.createElement('button');
    affordance.hidden = true;
    affordance.setAttribute('data-folded-source-affordance', '');
    affordance.textContent = '该补充已归入上方回复';
    el.appendChild(affordance);
    document.body.appendChild(el);

    expect(affordance.hidden).toBe(true);
    expect(scrollToMessage('msg-folded')).toBe(true);
    expect(affordance.hidden).toBe(false);
    expect(el.getAttribute('aria-hidden')).toBe('false');

    vi.advanceTimersByTime(3200);
    expect(affordance.hidden).toBe(true);
    expect(el.getAttribute('aria-hidden')).toBe('true');
    vi.useRealTimers();
  });
});
