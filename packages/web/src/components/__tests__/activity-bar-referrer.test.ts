import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { assignDocumentRoute, getThreadIdFromPathname, getWorldSwitchHref } = vi.hoisted(() => ({
  assignDocumentRoute: vi.fn((_href: string) => _href),
  getThreadIdFromPathname: vi.fn((pathname: string) => {
    const match = pathname.match(/^\/thread\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : 'default';
  }),
  getWorldSwitchHref: vi.fn(() => '/classic'),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/thread/thread-abc',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({
  CLASSIC_WORLD_PREFIX: '/classic',
  assignDocumentRoute,
  getThreadIdFromPathname,
  getWorldSwitchHref,
}));

vi.mock('@/components/icons/MemoryIcon', () => ({
  MemoryIcon: ({ className }: { className?: string }) => React.createElement('span', { className }, 'M'),
}));

import { ActivityBar } from '@/components/ActivityBar';

describe('ActivityBar referrer forwarding (P2 fix)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    assignDocumentRoute.mockClear();
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  it('appends ?from=threadId when navigating from /thread/xxx to signals', () => {
    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });

    const signalsBtn = container.querySelector('button[title="信号"]') as HTMLElement;
    expect(signalsBtn).toBeTruthy();

    React.act(() => {
      signalsBtn.click();
    });

    expect(assignDocumentRoute).toHaveBeenCalledWith('/signals?from=thread-abc', expect.anything());
  });

  it('appends ?from=threadId when navigating to memory', () => {
    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });

    const memoryBtn = container.querySelector('button[title="记忆"]') as HTMLElement;
    expect(memoryBtn).toBeTruthy();

    React.act(() => {
      memoryBtn.click();
    });

    expect(assignDocumentRoute).toHaveBeenCalledWith('/memory?from=thread-abc', expect.anything());
  });

  it('does NOT append ?from= when clicking the home button', () => {
    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });

    const homeBtn = container.querySelector('button[title="对话"]') as HTMLElement;
    expect(homeBtn).toBeTruthy();

    React.act(() => {
      homeBtn.click();
    });

    expect(assignDocumentRoute).toHaveBeenCalledWith('/', expect.anything());
  });

  it('does NOT append ?from= when already on root (default thread)', () => {
    getThreadIdFromPathname.mockReturnValueOnce('default');

    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });

    const signalsBtn = container.querySelector('button[title="信号"]') as HTMLElement;
    React.act(() => {
      signalsBtn.click();
    });

    expect(assignDocumentRoute).toHaveBeenCalledWith('/signals', expect.anything());
  });

  it('forwards existing ?from= when cross-hopping between non-thread pages', () => {
    getThreadIdFromPathname.mockReturnValueOnce('default');
    const originalSearch = window.location.search;
    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: '?from=thread-abc' },
      writable: true,
      configurable: true,
    });

    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });

    const memoryBtn = container.querySelector('button[title="记忆"]') as HTMLElement;
    expect(memoryBtn).toBeTruthy();

    React.act(() => {
      memoryBtn.click();
    });

    expect(assignDocumentRoute).toHaveBeenCalledWith('/memory?from=thread-abc', expect.anything());

    Object.defineProperty(window, 'location', {
      value: { ...window.location, search: originalSearch },
      writable: true,
      configurable: true,
    });
  });
});
