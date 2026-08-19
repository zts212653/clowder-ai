import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({
  pathname: '/thread/thread-abc',
  push: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navigation.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: navigation.push,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({
  getThreadIdFromPathname: (pathname: string) => {
    const match = pathname.match(/^\/thread\/([^/?#]+)/);
    return match ? decodeURIComponent(match[1]) : 'default';
  },
}));

vi.mock('@/components/icons/MemoryIcon', () => ({
  MemoryIcon: ({ className }: { className?: string }) => React.createElement('span', { className }, 'M'),
}));

vi.mock('@/hooks/usePinnedSections', () => ({
  usePinnedSections: () => ({ pinned: [], pin: vi.fn(), unpin: vi.fn(), isPinned: () => false }),
}));

vi.mock('@/components/hub-icons', () => ({
  HubIcon: ({ name, className }: { name: string; className?: string }) =>
    React.createElement('span', { className }, name),
}));

vi.mock('@/components/settings/settings-nav-config', () => ({
  SETTINGS_SECTIONS: [],
}));

import { ActivityBar } from '@/components/ActivityBar';

describe('F258 Visible Cafe ActivityBar entry', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    navigation.pathname = '/thread/thread-abc';
    navigation.push.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
  });

  it('exposes a user-visible cat planet button that opens /starry', () => {
    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });

    const button = container.querySelector('button[aria-label="猫猫星球"]') as HTMLButtonElement | null;
    expect(button).toBeTruthy();
    expect(button?.title).toBe('猫猫星球');
    expect(button?.getAttribute('data-guide-id')).toBe('nav.starry');

    React.act(() => {
      button?.click();
    });

    expect(navigation.push).toHaveBeenCalledWith('/starry?from=thread-abc');
  });

  it('marks the cat planet button active while /starry is open', () => {
    navigation.pathname = '/starry';

    React.act(() => {
      root.render(React.createElement(ActivityBar));
    });

    const button = container.querySelector('button[aria-label="猫猫星球"]');
    expect(button?.getAttribute('aria-current')).toBe('page');
  });
});
