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

describe('F322 URL selection is consumed once', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    nav.pathname = '/settings';
    nav.search = 's=theme&shell=v2';
    window.history.replaceState(null, '', '/settings?s=theme&shell=v2');
    window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, 'v2');
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
  it('a later presentation choice overrides the initial shell query', () => {
    act(() =>
      root.render(
        <AppShell>
          <main>settings</main>
        </AppShell>,
      ),
    );
    act(() => writeShellPresentation('classic'));
    expect(window.localStorage.getItem(SHELL_PRESENTATION_STORAGE_KEY)).toBe('classic');
    expect(document.documentElement.dataset.shell).toBeUndefined();
    expect(host.querySelector('[data-testid="classic-rail"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="v2-rail"]')).toBeNull();
  });
});
