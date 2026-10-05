import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({ pathname: '/thread/current', search: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => true }));
vi.mock('@/hooks/useWorkspaceNavigate', () => ({ useWorkspaceNavigate: vi.fn() }));
vi.mock('@/stores/sidebarStore', () => ({
  initSidebarWidth: vi.fn(),
  useSidebarStore: () => ({ isOpen: true, width: 260, close: vi.fn(), handleResize: vi.fn(), resetWidth: vi.fn() }),
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (s: (v: { rightPanelMode: string }) => unknown) => s({ rightPanelMode: 'none' }),
}));
vi.mock('@/stores/callbackAuthStore', () => ({ CallbackAuthSnapshotMount: () => null }));
vi.mock('@/components/ActivityBar', () => ({ ActivityBar: () => <nav data-testid="classic-rail" /> }));
vi.mock('../WorldRail', () => ({ WorldRail: () => <nav data-testid="v2-rail" /> }));
vi.mock('@/components/ThreadSidebar', () => ({ ThreadSidebar: () => <aside data-testid="sidebar" /> }));
vi.mock('@/components/workspace/ResizeHandle', () => ({ ResizeHandle: () => null }));
vi.mock('@/components/workspace/FloatingPresentationSurfaceHost', () => ({
  FloatingPresentationSurfaceHost: () => null,
}));
vi.mock('@/components/concierge/ConciergeHost', () => ({ ConciergeHost: () => null }));
vi.mock('@/components/thread-chat', () => ({
  ThreadChatRuntimeProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/listen-mode/ListenModePlayer', () => ({ ListenModePlayer: () => null }));
vi.mock('@/components/story-player/TheaterReplayHost', () => ({ TheaterReplayHost: () => null }));
vi.mock('@/components/DesktopUpdatePrompt', () => ({ DesktopUpdatePrompt: () => null }));
vi.mock('@/services/playbackRuntime', () => ({ getPlaybackManager: vi.fn(), destroyPlaybackRuntime: vi.fn() }));

import { AppShell } from '@/components/AppShell';
import { SHELL_PRESENTATION_STORAGE_KEY, writeShellPresentation } from '../shell-presentation';

describe('F322 AppShell presentation isolation', () => {
  let host: HTMLDivElement;
  let root: Root;
  function render() {
    act(() =>
      root.render(
        <AppShell>
          <input aria-label="draft" defaultValue="unsent" />
        </AppShell>,
      ),
    );
  }
  function expectShell(v2: boolean) {
    expect(document.documentElement.dataset.shell).toBe(v2 ? 'v2' : undefined);
    expect(host.querySelectorAll('[data-testid="v2-rail"]')).toHaveLength(v2 ? 1 : 0);
    expect(host.querySelectorAll('[data-testid="classic-rail"]')).toHaveLength(v2 ? 0 : 1);
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    nav.pathname = '/thread/current';
    nav.search = '';
    window.history.replaceState(null, '', nav.pathname);
    window.localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
    delete document.documentElement.dataset.shell;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    window.localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
    window.history.replaceState(null, '', '/');
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  it('default classic, v2, and back do not share rails or remount the unsent draft', () => {
    render();
    expectShell(false);
    const draft = host.querySelector('input');
    if (!draft) throw new Error('Unsent draft input is missing');
    draft.value = 'still unsent';
    act(() => writeShellPresentation('v2'));
    expectShell(true);
    expect(host.querySelector('input')).toBe(draft);
    act(() => writeShellPresentation('classic'));
    expectShell(false);
    expect(draft.value).toBe('still unsent');
  });
  it.each([
    'v2',
    'classic',
  ] as const)('initial ?shell=%s takes precedence over the opposite preference', (requested) => {
    window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, requested === 'v2' ? 'classic' : 'v2');
    nav.search = `shell=${requested}`;
    window.history.replaceState(null, '', `${nav.pathname}?${nav.search}`);
    render();
    expectShell(requested === 'v2');
    expect(window.localStorage.getItem(SHELL_PRESENTATION_STORAGE_KEY)).toBe(requested);
  });
  it('cross-tab preference changes replace the rail and remove v2 tokens', () => {
    render();
    window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'v2');
    act(() =>
      window.dispatchEvent(new StorageEvent('storage', { key: SHELL_PRESENTATION_STORAGE_KEY, newValue: 'v2' })),
    );
    expectShell(true);
    window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'classic');
    act(() =>
      window.dispatchEvent(new StorageEvent('storage', { key: SHELL_PRESENTATION_STORAGE_KEY, newValue: 'classic' })),
    );
    expectShell(false);
  });
  it('unmount cleans the html presentation attribute', () => {
    window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'v2');
    render();
    expectShell(true);
    act(() => root.render(null));
    expect(document.documentElement.dataset.shell).toBeUndefined();
  });
});
