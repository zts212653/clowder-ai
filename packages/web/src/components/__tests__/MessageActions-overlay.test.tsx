import { act } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageActionSlot } from '../MessageActionSlot';
import { MessageActions } from '../MessageActions';
import {
  installReplyLayersActEnvironment,
  ReplyLayersHarness,
  streamReply,
  uninstallReplyLayersActEnvironment,
} from './ChatMessage-reply-layers.harness';

vi.mock('@/hooks/useTextSelectionAction', () => ({ useTextSelectionAction: () => null }));
vi.mock('../useMessageAnnotationMarkers', () => ({ useMessageAnnotationMarkers: () => [] }));
vi.mock('@/hooks/useTts', () => ({ useTts: () => ({ state: 'idle', synthesize: vi.fn(), activeMessageId: null }) }));

function required<T extends HTMLElement>(selector: string, parent: ParentNode = document): T {
  const node = parent.querySelector<T>(selector);
  if (!node) throw new Error(`Missing action owner: ${selector}`);
  return node;
}

describe('reading-column action overlay', () => {
  let h: ReplyLayersHarness;
  let slotX: number;
  let factsRight: number;
  let slotY: number;
  let columnWidth: number;
  let columnLeft: number;
  beforeAll(installReplyLayersActEnvironment);
  afterAll(uninstallReplyLayersActEnvironment);
  beforeEach(() => {
    h = new ReplyLayersHarness();
    h.enableV2();
    slotX = 242;
    factsRight = 234;
    slotY = 390;
    columnWidth = 216;
    columnLeft = 68;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-message-action-slot')) return new DOMRect(slotX, slotY, 0, 0);
      if (this.tagName === 'SPAN' && this.textContent === 'Author · Time')
        return new DOMRect(180, 382, factsRight - 180, 14);
      if (this.getAttribute('data-testid') === 'message-actions-compact-trigger') return new DOMRect(0, 0, 44, 44);
      if (this.getAttribute('data-testid') === 'message-actions-toolbar') return new DOMRect(0, 0, 188, 34);
      return new DOMRect(columnLeft, 360, columnWidth, 100);
    });
  });
  afterEach(() => {
    h.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function render() {
    act(() =>
      h.root.render(
        <div data-chat-container>
          <div data-thread-chat-reading-column>
            <MessageActions message={streamReply()} threadId="thread-1">
              <div data-message-author-row>
                <span>Author · Time</span>
                <MessageActionSlot />
              </div>
            </MessageActions>
          </div>
        </div>,
      ),
    );
  }

  it('keeps all action paint outside message scroll geometry and clamps the narrow trigger', () => {
    render();
    const owner = required('[data-context-quote-source="message"]', h.container);
    expect(owner.querySelector('[data-testid="message-actions-toolbar"]')).toBeNull();
    expect(owner.querySelector('[data-testid="message-actions-compact-trigger"]')).toBeNull();
    const overlay = required('[data-message-actions-owner="reply-1"]');
    expect(overlay).not.toBeNull();
    expect(overlay.style.position).toBe('fixed');
    expect(overlay.style.left).toBe('240px');
    expect(overlay.querySelector('[data-testid="message-actions-compact-trigger"]')).not.toBeNull();
  });

  it('owns hover/focus visibility across the portal without summoning actions from body focus', () => {
    render();
    const owner = required('[data-context-quote-source="message"]', h.container);
    const overlay = required('[data-message-actions-owner="reply-1"]');
    expect(overlay).not.toBeNull();
    expect(overlay.style.opacity).toBe('0');
    act(() => owner.dispatchEvent(new MouseEvent('pointerenter')));
    expect(overlay.style.opacity).toBe('1');
    act(() => owner.dispatchEvent(new MouseEvent('pointerleave', { relatedTarget: document.body })));
    expect(overlay.style.opacity).toBe('0');
    act(() => required<HTMLButtonElement>('button', overlay).focus());
    expect(overlay.style.opacity).toBe('1');
  });

  it('does not clamp the compact hit target back over a crowded author/time line', () => {
    slotX = 284;
    factsRight = 278;
    render();
    const overlay = required('[data-message-actions-owner="reply-1"]');
    expect(overlay).not.toBeNull();
    const top = Number.parseFloat(overlay.style.top);
    expect(top + 44 <= 382 || top >= 396).toBe(true);
    expect(top >= 360 && top + 44 <= 460).toBe(true);
    expect(overlay.style.left).toBe('240px');
  });

  it('returns keyboard focus to the same compact owner after Escape closes its action sheet', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    render();
    const trigger = required<HTMLButtonElement>('[data-message-actions-owner="reply-1"] button');
    act(() => {
      trigger.focus();
      trigger.click();
    });
    expect(document.querySelector('[data-testid="message-actions-compact-sheet"]')).not.toBeNull();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(document.querySelector('[data-testid="message-actions-compact-sheet"]')).toBeNull();
    expect(document.activeElement).not.toBe(trigger);
    act(() => {
      for (const callback of frames.splice(0)) callback(0);
    });
    expect(document.activeElement).toBe(trigger);
  });

  it('inherits an inert/hidden retained history owner instead of leaving a reachable body portal', async () => {
    render();
    const column = required('[data-thread-chat-reading-column]', h.container);
    const overlay = required('[data-message-actions-owner="reply-1"]');
    await act(async () => {
      column.setAttribute('aria-hidden', 'true');
      column.setAttribute('inert', '');
      await Promise.resolve();
    });
    expect(overlay.hasAttribute('inert')).toBe(true);
    expect(overlay.style.visibility).toBe('hidden');
    await act(async () => {
      column.removeAttribute('inert');
      column.removeAttribute('aria-hidden');
      await Promise.resolve();
    });
    expect(overlay.hasAttribute('inert')).toBe(false);
    expect(overlay.style.visibility).toBe('visible');
  });
  it.each([359, 361, 459, 461])('contains or disables a focused compact control at scrollport edge %s', (edge) => {
    slotY = edge;
    render();
    const overlay = required('[data-message-actions-owner="reply-1"]');
    act(() => required<HTMLButtonElement>('button', overlay).focus());
    const top = Number.parseFloat(overlay.style.top);
    const contained = top >= 360 && top + 44 <= 460;
    expect(contained || (overlay.style.visibility === 'hidden' && overlay.hasAttribute('inert'))).toBe(true);
  });

  for (const coarse of [false, true]) {
    it.each([359, 361, 459, 461])(`contains or disables a wide-column control, coarse=${coarse}, edge=%s`, (edge) => {
      columnWidth = 720;
      slotY = edge;
      vi.stubGlobal('matchMedia', (query: string) => ({
        matches: coarse && query.includes('pointer: coarse'),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }));
      render();
      const overlay = required('[data-message-actions-owner="reply-1"]');
      act(() => required<HTMLButtonElement>('button', overlay).focus());
      const top = Number.parseFloat(overlay.style.top);
      const height = coarse ? 44 : 34;
      expect(
        (top >= 360 && top + height <= 460) || (overlay.style.visibility === 'hidden' && overlay.hasAttribute('inert')),
      ).toBe(true);
      expect(
        overlay.querySelector(
          coarse ? '[data-testid="message-actions-compact-trigger"]' : '[data-testid="message-actions-toolbar"]',
        ),
      ).not.toBeNull();
    });
  }

  it('shares scroll/resize listeners and batches fifty mounted owners without measuring offscreen rows', async () => {
    const listeners = vi.spyOn(window, 'addEventListener');
    const removals = vi.spyOn(window, 'removeEventListener');
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const visible = new Set<Element>();
    const authorTargets: Set<Node>[] = [];
    const OriginalMutationObserver = window.MutationObserver;
    vi.stubGlobal(
      'MutationObserver',
      class extends OriginalMutationObserver {
        private watchedAuthors = new Set<Node>();
        constructor(callback: MutationCallback) {
          super(callback);
          authorTargets.push(this.watchedAuthors);
        }
        observe(target: Node, options?: MutationObserverInit) {
          if (options?.characterData) this.watchedAuthors.add(target);
          super.observe(target, options);
        }
        disconnect() {
          this.watchedAuthors.clear();
          super.disconnect();
        }
      },
    );
    let resizeObservers = 0;
    let resizeDisconnects = 0;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor() {
          resizeObservers++;
        }
        observe() {}
        unobserve() {}
        disconnect() {
          resizeDisconnects++;
        }
      },
    );
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(private callback: IntersectionObserverCallback) {}
        observe(node: Element) {
          const index = Number(node.closest('[data-test-action-row]')?.getAttribute('data-test-action-row'));
          if (index < 2) visible.add(node);
          this.callback(
            [{ target: node, isIntersecting: index < 2 } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
        }
        unobserve() {}
        disconnect() {}
      },
    );
    act(() =>
      h.root.render(
        <div data-chat-container>
          <div data-thread-chat-reading-column>
            {Array.from({ length: 50 }, (_, index) => `batch-${index}`).map((id, index) => (
              <div key={id} data-test-action-row={index}>
                <MessageActions message={streamReply({ id })} threadId="thread-1">
                  <div data-message-author-row>
                    <span>Author · Time</span>
                    <MessageActionSlot />
                  </div>
                </MessageActions>
              </div>
            ))}
          </div>
        </div>,
      ),
    );
    expect(listeners.mock.calls.filter(([name]) => name === 'scroll')).toHaveLength(1);
    expect(listeners.mock.calls.filter(([name]) => name === 'resize')).toHaveLength(1);
    expect(resizeObservers).toBe(1);
    expect(authorTargets.filter((targets) => targets.size)).toHaveLength(1);
    expect(authorTargets.find((targets) => targets.size)?.size).toBe(2);
    act(() => {
      for (const frame of frames.splice(0)) frame(0);
    });
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    measure.mockClear();
    act(() => {
      for (let index = 0; index < 20; index++) window.dispatchEvent(new Event('scroll'));
    });
    expect(measure).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    act(() => {
      for (const frame of frames.splice(0)) frame(1);
    });
    const slots = measure.mock.instances.filter(
      (node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute('data-message-action-slot'),
    );
    expect(slots).toHaveLength(2);
    expect(
      slots.every((node) => Number(node.closest('[data-test-action-row]')?.getAttribute('data-test-action-row')) < 2),
    ).toBe(true);
    expect(visible.size).toBe(2);
    const column = required('[data-thread-chat-reading-column]', h.container);
    const epoch = column.dataset.messageActionsEpoch;
    measure.mockClear();
    await act(async () => {
      const name = required('[data-test-action-row="49"] span', h.container).firstChild;
      if (!name) throw new Error('Missing offscreen author');
      name.nodeValue = 'Offscreen Cat';
      await Promise.resolve();
    });
    expect(column.dataset.messageActionsEpoch).toBe(epoch);
    expect(measure).not.toHaveBeenCalled();
    expect(frames).toHaveLength(0);
    act(() => h.root.render(null));
    expect(removals.mock.calls.filter(([name]) => name === 'scroll')).toHaveLength(1);
    expect(removals.mock.calls.filter(([name]) => name === 'resize')).toHaveLength(1);
    expect(resizeDisconnects).toBe(1);
  });

  it('invalidates focus before a same-width translation and commits coordinates with the latest epoch', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    render();
    const overlay = required('[data-message-actions-owner="reply-1"]');
    const column = required('[data-thread-chat-reading-column]', h.container);
    act(() => required<HTMLButtonElement>('button', overlay).focus());
    columnLeft += 100;
    slotX += 100;
    act(() => window.dispatchEvent(new Event('resize')));
    expect(overlay.dataset.messageActionsReady).toBe('false');
    expect(overlay.dataset.messageActionsCommittedEpoch).toBeUndefined();
    expect(overlay.style.visibility).toBe('hidden');
    expect(overlay.hasAttribute('inert')).toBe(true);
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(overlay.contains(document.activeElement)).toBe(false);
    act(() => {
      for (const callback of frames.splice(0)) callback(0);
    });
    expect(overlay.dataset.messageActionsReady).toBe('true');
    expect(overlay.dataset.messageActionsCommittedEpoch).toBe(column.dataset.messageActionsEpoch);
    expect(overlay.dataset.messageActionsColumnLeft).toBe('168');
    expect(overlay.dataset.messageActionsColumnWidth).toBe('216');
    expect(overlay.style.left).toBe('340px');
    expect(overlay.style.visibility).toBe('visible');
    expect(overlay.hasAttribute('inert')).toBe(false);
  });
});
