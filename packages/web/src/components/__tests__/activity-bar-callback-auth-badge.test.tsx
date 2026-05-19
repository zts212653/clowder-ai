/**
 * F174 D2b-2 (rev3) callback-auth badge — migrated from HubButton to ActivityBar SettingsButton.
 *
 * Behavior matrix (unchanged from F174 rev3):
 *   isAvailable=false             → no badge
 *   unviewedFailures24h = 0       → no badge
 *   unviewedFailures24h 1-5       → amber badge (#F59E0B)
 *   unviewedFailures24h >= 6      → red badge (#EF4444)
 *   count > 99                    → "99+" cap with maxWidth 22px
 */

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let mockAvailable = false;
let mockAggregate = { unviewedFailures24h: 0 };

vi.mock('@/stores/callbackAuthStore', () => ({
  useCallbackAuthAvailable: () => mockAvailable,
  useCallbackAuthAggregate: () => mockAggregate,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock('@/hooks/useCafeTheme', () => ({
  useCafeTheme: () => ({ toggleTheme: vi.fn(), resolvedTheme: 'light' }),
}));

vi.mock('@/hooks/usePinnedSections', () => ({
  usePinnedSections: () => ({ pinned: [], pin: vi.fn(), unpin: vi.fn(), isPinned: () => false }),
}));

vi.mock('@/components/icons/MemoryIcon', () => ({
  MemoryIcon: () => React.createElement('span', null, 'M'),
}));

vi.mock('@/components/hub-icons', () => ({
  HubIcon: () => React.createElement('span'),
}));

vi.mock('@/components/settings/settings-nav-config', () => ({
  SETTINGS_SECTIONS: [],
}));

vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({
  getThreadIdFromPathname: () => 'default',
}));

import { ActivityBar } from '@/components/ActivityBar';

Object.assign(globalThis as Record<string, unknown>, { React });

describe('ActivityBar SettingsButton — F174 callback-auth badge', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('no badge when isAvailable=false', async () => {
    mockAvailable = false;
    mockAggregate = { unviewedFailures24h: 5 };
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });
    expect(container.querySelector('[data-testid="settings-callback-auth-badge"]')).toBeNull();
    expect(container.querySelector('[data-callback-auth-unviewed]')).toBeNull();
  });

  it('no badge when unviewedFailures24h=0', async () => {
    mockAvailable = true;
    mockAggregate = { unviewedFailures24h: 0 };
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });
    expect(container.querySelector('[data-testid="settings-callback-auth-badge"]')).toBeNull();
  });

  it('amber badge for 1-5 unviewed', async () => {
    mockAvailable = true;
    mockAggregate = { unviewedFailures24h: 3 };
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });
    const badge = container.querySelector('[data-testid="settings-callback-auth-badge"]') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('3');
    expect(badge.style.backgroundColor).toBe('rgb(245, 158, 11)');
    const btn = container.querySelector('[data-testid="settings-button"]') as HTMLElement;
    expect(btn.getAttribute('data-callback-auth-unviewed')).toBe('3');
  });

  it('red badge for >= 6 unviewed', async () => {
    mockAvailable = true;
    mockAggregate = { unviewedFailures24h: 12 };
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });
    const badge = container.querySelector('[data-testid="settings-callback-auth-badge"]') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('12');
    expect(badge.style.backgroundColor).toBe('rgb(239, 68, 68)');
  });

  it('caps at "99+" with maxWidth 22px', async () => {
    mockAvailable = true;
    mockAggregate = { unviewedFailures24h: 250 };
    await act(async () => {
      root.render(React.createElement(ActivityBar));
    });
    const badge = container.querySelector('[data-testid="settings-callback-auth-badge"]') as HTMLElement;
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe('99+');
    expect(badge.style.maxWidth).toBe('22px');
    expect(badge.style.overflow).toBe('hidden');
    const btn = container.querySelector('[data-testid="settings-button"]') as HTMLElement;
    expect(btn.getAttribute('data-callback-auth-unviewed')).toBe('250');
  });
});
