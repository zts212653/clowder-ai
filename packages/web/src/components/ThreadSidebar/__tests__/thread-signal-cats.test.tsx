import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cats = vi.hoisted(() => [
  { id: 'sol', displayName: 'Sol', nickname: '小太阳·砚砚', color: { primary: '#777777' } },
  { id: 'astra', displayName: 'Astra', nickname: '小星星·砚砚', color: { primary: '#777777' } },
]);
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: (id: string) => cats.find((cat) => cat.id === id) }),
}));

import { writeShellLanguage } from '../../shell/shell-language';
import { ThreadRowSignals } from '../ThreadRowSignals';

// DOM widths model the actual allocated name slot and its unshrunk content. No viewport guess.
describe('boot20 full nickname or avatars', () => {
  let host: HTMLDivElement;
  let root: Root;
  let available: number;
  let required: number;
  let signalWidth: number;
  let statusAvailable: number;
  const callbacks = new Set<ResizeObserverCallback>();
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    available = 80;
    required = 70;
    signalWidth = 243;
    statusAvailable = 10;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid === 'thread-row-signals') return new DOMRect(0, 0, signalWidth, 20);
      if (this.dataset.signalFixed) return new DOMRect(0, 0, this.dataset.signalFixed === 'faces' ? 32 : 30, 20);
      if (this.hasAttribute('data-signal-badge')) {
        const width = this.querySelector('[data-testid="thread-row-draft"]')
          ? 39
          : this.querySelector('[data-testid="thread-row-mention"]')
            ? 40
            : 77;
        return new DOMRect(0, 0, width, 20);
      }
      if (this.dataset.testid === 'thread-status-label') return new DOMRect(0, 0, statusAvailable, 20);
      if (this.dataset.testid === 'thread-status-label-content') return new DOMRect(0, 0, 76, 20);
      const width = this.dataset.testid === 'thread-cat-name' ? available : required;
      return new DOMRect(0, 0, width, 20);
    });
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      return selector === ':focus-visible' || matches.call(this, selector);
    });
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(readonly callback: ResizeObserverCallback) {
          callbacks.add(callback);
        }
        observe() {}
        disconnect() {
          callbacks.delete(this.callback);
        }
      },
    );
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    writeShellLanguage('zh');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    callbacks.clear();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  it.each([
    'zh',
    'en',
  ] as const)('labels the row unread count visibly in %s, preserving the full accessible count', (language) => {
    act(() => writeShellLanguage(language));
    act(() =>
      root.render(<ThreadRowSignals presence={{ status: 'idle' }} unreadCount={120} hasUserMention hasDraft />),
    );
    const badge = host.querySelector('[data-testid="thread-row-unread"]');
    expect(badge?.textContent).toBe(language === 'zh' ? '99+ 未读' : '99+ unread');
    expect(badge?.querySelector('.sr-only')).toBeNull();
    expect(badge?.getAttribute('aria-label')).toBe(language === 'zh' ? '120 条未读' : '120 unread');
    expect(host.querySelector('[data-testid="thread-row-mention"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="thread-row-draft"]')).not.toBeNull();
  });
  function resize(width: number, contentWidth = required) {
    available = width;
    required = contentWidth;
    act(() => {
      for (const callback of callbacks) callback([], {} as ResizeObserver);
    });
  }
  function renderCrowded() {
    act(() =>
      root.render(
        <ThreadRowSignals
          presence={{ status: 'working', cats: ['sol', 'astra'], activeSince: Date.now() - 120_000 }}
          hasUserMention
          unreadCount={120}
          hasDraft
        />,
      ),
    );
  }
  it.each([
    'zh',
    'en',
  ] as const)('moves fixed facts together at narrow widths in %s, independent of names/focus', (lang) => {
    writeShellLanguage(lang);
    renderCrowded();
    const row = host.querySelector<HTMLElement>('[data-testid="thread-row-signals"]')!;
    expect(row.dataset.signalSplit).toBe('false');
    signalWidth = 183;
    resize(0);
    expect(row.dataset.signalSplit).toBe('true');
    const presence = row.querySelector<HTMLElement>('[data-signal-presence]')!;
    expect(presence.style.minWidth).toBe('66px');
    expect(row.querySelectorAll('[data-signal-badge]')).toHaveLength(3);
    // Restoring optional words in the split presence line must not undo that split.
    statusAvailable = 100;
    resize(100, 76);
    expect(row.dataset.signalSplit).toBe('true');
    act(() => host.querySelector<HTMLElement>('[data-testid="thread-status-text"]')!.focus());
    expect(row.dataset.signalSplit).toBe('true');
    signalWidth = 103;
    resize(0);
    expect(row.dataset.signalSplit).toBe('true');
    expect(row.querySelectorAll('img')).toHaveLength(2);
    signalWidth = 243;
    resize(0);
    expect(row.dataset.signalSplit).toBe('false');
  });
  it.each([
    'zh',
    'en',
  ] as const)('shows status text whole or hidden and recovers it from a visible status unit in %s', (lang) => {
    writeShellLanguage(lang);
    renderCrowded();
    const words = host.querySelector<HTMLElement>('[data-testid="thread-status-label-content"]')!;
    expect(words?.style.visibility).toBe('hidden');
    const recovery = host.querySelector<HTMLElement>('[data-testid="thread-status-text"]')!;
    expect(recovery.querySelector('[data-testid="thread-running-cat"]')).not.toBeNull();
    act(() => recovery.focus());
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(lang === 'zh' ? '执行中' : 'Running');
    statusAvailable = 76;
    resize(0);
    expect(words.style.visibility).toBe('visible');
    statusAvailable = 75.5;
    resize(0);
    expect(words.style.visibility).toBe('hidden');
  });
  it.each([
    'zh',
    'en',
  ] as const)('preserves full names or hides the whole segment on shrink and grow in %s', (language) => {
    writeShellLanguage(language);
    act(() =>
      root.render(
        <ThreadRowSignals
          presence={{ status: 'working', cats: ['sol', 'astra', 'sol'] }}
          hasUserMention
          unreadCount={8}
          hasDraft
        />,
      ),
    );
    const name = host.querySelector<HTMLElement>('[data-testid="thread-cat-name"]');
    expect(name, 'a measured all-or-nothing name slot').not.toBeNull();
    expect(name?.textContent).toBe('小太阳+1');
    expect(name?.style.visibility).toBe('visible');
    resize(10);
    expect(name?.style.visibility).toBe('hidden');
    expect(name?.getAttribute('aria-hidden')).toBe('true');
    expect(name?.querySelector('.truncate')).toBeNull();
    expect(host.querySelectorAll('[data-testid="thread-signal-cats"] img')).toHaveLength(2);
    expect(host.querySelector('[data-testid="thread-row-unread"]')?.textContent).toContain('8');
    const avatar = host.querySelector<HTMLElement>('[data-testid="thread-signal-cats"]')!;
    act(() => avatar.focus());
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('小太阳·砚砚');
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('小星星·砚砚');
    resize(70);
    expect(name?.style.visibility).toBe('visible');
    resize(70, 70.5); // font/identity change at the same sidebar width must not clip a fractional glyph.
    expect(name?.style.visibility).toBe('hidden');
    resize(90);
    expect(name?.style.visibility).toBe('visible');
  });
});
