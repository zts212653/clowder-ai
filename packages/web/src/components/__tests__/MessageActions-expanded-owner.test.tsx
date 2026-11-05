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
  if (!node) throw new Error(`Missing action surface: ${selector}`);
  return node;
}

function actionRect(node: HTMLElement, left: number, top: number) {
  if (node.matches('button[aria-haspopup="menu"]')) return new DOMRect(left + 150, top + 3, 28, 28);
  if (node.getAttribute('role') === 'menu') {
    const inlineLeft = node.classList.contains('right-0') ? left + 2 : left + 150;
    return new DOMRect(
      Number.parseFloat(node.style.left) || inlineLeft,
      Number.parseFloat(node.style.top) || top + 35,
      176,
      152,
    );
  }
  if (node.dataset.testid === 'message-actions-compact-trigger') return new DOMRect(left, top, 44, 44);
  if (node.dataset.testid === 'message-actions-toolbar') return new DOMRect(left, top, 188, 34);
  return undefined;
}

describe('all action surfaces retain the same message owner', () => {
  let h: ReplyLayersHarness;
  let width: number;
  let slotX: number;
  let slotY: number;
  let portHeight: number;
  let frames: FrameRequestCallback[];
  beforeAll(installReplyLayersActEnvironment);
  afterAll(uninstallReplyLayersActEnvironment);
  beforeEach(() => {
    h = new ReplyLayersHarness();
    h.enableV2();
    vi.stubGlobal('innerHeight', 1000);
    width = 216;
    slotX = 242;
    slotY = 390;
    portHeight = 600;
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('min-width: 768px') ? width === 720 : query.includes('max-width: 767px') && width !== 720,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-message-action-slot')) return new DOMRect(slotX, slotY, 0, 0);
      if (this.hasAttribute('data-author-fact')) return new DOMRect(180, slotY - 8, 54, 14);
      const plane = this.closest<HTMLElement>('[data-message-actions-owner]');
      const left = Number.parseFloat(plane?.style.left ?? '0');
      const top = Number.parseFloat(plane?.style.top ?? '0');
      const control = actionRect(this, left, top);
      if (control) return control;
      if (this.hasAttribute('data-chat-container')) return new DOMRect(68, 360, width, portHeight);
      return new DOMRect(68, 360, width, 600);
    });
  });
  afterEach(() => {
    h.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function render(user = false) {
    act(() =>
      h.root.render(
        <div data-chat-container>
          <div data-thread-chat-reading-column>
            <MessageActions message={streamReply(user ? { type: 'user', catId: undefined } : {})} threadId="thread-1">
              <div data-message-author-row>
                <span data-author-fact>Cat Name</span>
                <MessageActionSlot />
              </div>
              <p data-action-body>Unchanged body</p>
            </MessageActions>
          </div>
        </div>,
      ),
    );
  }
  function flush() {
    act(() => {
      for (const callback of frames.splice(0)) callback(0);
    });
  }
  function openSheet(overflow: boolean) {
    act(() => required<HTMLButtonElement>('[data-testid="message-actions-compact-trigger"]').click());
    if (overflow)
      act(() =>
        required<HTMLButtonElement>(
          'button[aria-haspopup="menu"]',
          required('[data-testid="message-actions-compact-sheet"]'),
        ).click(),
      );
    const surface = overflow
      ? required('[role="menu"]').parentElement
      : required('[data-testid="message-actions-compact-sheet"]');
    if (!surface) throw new Error('Missing sheet root');
    flush();
    expect(surface.hasAttribute('data-message-action-unavailable')).toBe(false);
    act(() => required<HTMLButtonElement>('button', surface).focus());
    return surface;
  }

  for (const overflow of [false, true]) {
    it(`Escape closes the ${overflow ? 'overflow' : 'compact'} sheet and restores its original action`, () => {
      render();
      const sheet = openSheet(overflow);
      act(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
      flush();
      expect(sheet.isConnected).toBe(false);
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(document.activeElement).toBe(required('[data-testid="message-actions-compact-trigger"]'));
    });
    for (const hidden of [true, false]) {
      it(`retires an open ${overflow ? 'overflow' : 'compact'} sheet on ${hidden ? 'retained hidden' : 'clipped'} ownership, then permits a fresh sheet`, async () => {
        render();
        const sheet = openSheet(overflow);
        const column = required('[data-thread-chat-reading-column]', h.container);
        await act(async () => {
          if (hidden) {
            column.setAttribute('aria-hidden', 'true');
            column.setAttribute('inert', '');
          } else {
            slotY = 359;
            window.dispatchEvent(new Event('scroll'));
          }
          await Promise.resolve();
        });
        flush();
        expect(sheet.isConnected).toBe(false);
        expect(sheet.contains(document.activeElement)).toBe(false);
        await act(async () => {
          column.removeAttribute('aria-hidden');
          column.removeAttribute('inert');
          slotY = 390;
          window.dispatchEvent(new Event('scroll'));
          await Promise.resolve();
        });
        flush();
        const fresh = openSheet(overflow);
        expect(fresh.isConnected).toBe(true);
        expect(fresh.contains(document.activeElement)).toBe(true);
      });
    }
  }

  for (const user of [false, true]) {
    it.each([361, 959])(`bounds the expanded desktop More menu for user=${user} at edge %s`, (edge) => {
      width = 720;
      slotX = user ? 700 : 242;
      slotY = edge;
      render(user);
      act(() =>
        required<HTMLButtonElement>(
          'button[aria-haspopup="menu"]',
          required('[data-message-actions-owner="reply-1"]'),
        ).click(),
      );
      flush();
      const menu = required('[role="menu"]');
      const rect = menu.getBoundingClientRect();
      expect(rect.top >= 360 && rect.bottom <= 960 && rect.left >= 68 && rect.right <= 788).toBe(true);
      expect(menu.style.visibility).not.toBe('hidden');
    });
  }

  it('invalidates a changed author text/slot without resize, scroll, class or style mutation', async () => {
    width = 720;
    render();
    const plane = required('[data-message-actions-owner="reply-1"]');
    const column = required('[data-thread-chat-reading-column]', h.container);
    const epoch = column.dataset.messageActionsEpoch;
    slotX += 30;
    await act(async () => {
      const text = required('[data-author-fact]', h.container).firstChild;
      if (!text) throw new Error('Missing author text');
      text.nodeValue = 'Longer Cat Name';
      await Promise.resolve();
    });
    expect(plane.dataset.messageActionsReady).toBe('false');
    expect(column.dataset.messageActionsEpoch).not.toBe(epoch);
    flush();
    expect(plane.style.left).toBe('272px');
    expect(plane.dataset.messageActionsCommittedEpoch).toBe(column.dataset.messageActionsEpoch);
    expect(plane.style.visibility).toBe('visible');
  });

  it('does not invalidate author geometry for ordinary body streaming', async () => {
    width = 720;
    render();
    const column = required('[data-thread-chat-reading-column]', h.container);
    const epoch = column.dataset.messageActionsEpoch;
    frames.splice(0);
    const reads = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
    reads.mockClear();
    await act(async () => {
      const text = required('[data-action-body]', h.container).firstChild;
      if (!text) throw new Error('Missing body text');
      text.nodeValue = 'Streaming body grows';
      await Promise.resolve();
    });
    expect(column.dataset.messageActionsEpoch).toBe(epoch);
    expect(frames).toHaveLength(0);
    expect(reads).not.toHaveBeenCalled();
  });

  it('uses the existing overflow sheet when neither side can fit the menu, and retires it with its owner', async () => {
    width = 720;
    portHeight = 120;
    render();
    act(() => required<HTMLButtonElement>('button[aria-haspopup="menu"]').click());
    flush();
    flush();
    expect(document.querySelector('[data-message-actions-menu]')).toBeNull();
    const sheet = required('[data-testid="message-actions-overflow-sheet"]');
    expect(sheet.hasAttribute('inert')).toBe(false);
    act(() => required<HTMLButtonElement>('button', sheet).focus());
    await act(async () => {
      required('[data-thread-chat-reading-column]', h.container).setAttribute('inert', '');
      await Promise.resolve();
    });
    flush();
    expect(sheet.isConnected).toBe(false);
    expect(sheet.contains(document.activeElement)).toBe(false);
  });

  it('keeps a body confirmation usable when only its author anchor is clipped, and closes it on message loss', async () => {
    render();
    openSheet(false);
    act(() => required<HTMLButtonElement>('button[aria-label="删除"]').click());
    flush();
    const dialog = required('[data-message-action-owned][data-message-action-source="message"]');
    act(() => {
      slotY = 359;
      window.dispatchEvent(new Event('scroll'));
    });
    flush();
    expect(dialog.isConnected).toBe(true);
    expect(dialog.closest('[data-message-action-unavailable]')).toBeNull();
    await act(async () => {
      required('[data-thread-chat-reading-column]', h.container).setAttribute('inert', '');
      await Promise.resolve();
    });
    flush();
    expect(dialog.isConnected).toBe(false);
  });

  it('does not retire a focused sheet for scrolling inside an independent action portal', () => {
    render();
    const sheet = openSheet(false);
    const active = document.activeElement;
    const column = required('[data-thread-chat-reading-column]', h.container);
    const epoch = column.dataset.messageActionsEpoch;
    act(() => sheet.dispatchEvent(new Event('scroll', { bubbles: true })));
    expect(column.dataset.messageActionsEpoch).toBe(epoch);
    expect(document.activeElement).toBe(active);
    expect(sheet.hasAttribute('data-message-action-unavailable')).toBe(false);
  });
});
