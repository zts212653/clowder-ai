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

describe('F322 repeated URL intents', () => {
  let host: HTMLDivElement;
  let root: Root;
  function navigate(pathname: string, search = '') {
    nav.pathname = pathname;
    nav.search = search;
    act(() => {
      window.history.pushState(null, '', pathname + (search ? `?${search}` : ''));
      root.render(
        <AppShell>
          <main>navigation target</main>
        </AppShell>,
      );
    });
  }
  function chooseClassic() {
    navigate('/settings', 's=theme&shell=v2');
    act(() => writeShellPresentation('classic'));
    expect(window.localStorage.getItem(SHELL_PRESENTATION_STORAGE_KEY)).toBe('classic');
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    window.localStorage.removeItem(SHELL_PRESENTATION_STORAGE_KEY);
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
  it('a freshly reintroduced identical shell value applies after a route without shell', () => {
    chooseClassic();
    navigate('/thread/without-query');
    navigate('/thread/fresh-intent', 'shell=v2');
    expect(window.localStorage.getItem(SHELL_PRESENTATION_STORAGE_KEY)).toBe('v2');
    expect(host.querySelector('[data-testid="v2-rail"]')).not.toBeNull();
  });
  it('an explicit same-value link to another route is a fresh intent', () => {
    chooseClassic();
    navigate('/thread/fresh-intent', 'shell=v2');
    expect(window.localStorage.getItem(SHELL_PRESENTATION_STORAGE_KEY)).toBe('v2');
  });
  it('rerendering the current URL does not override the user choice', () => {
    chooseClassic();
    navigate('/settings', 's=theme&shell=v2');
    expect(window.localStorage.getItem(SHELL_PRESENTATION_STORAGE_KEY)).toBe('classic');
  });
});
