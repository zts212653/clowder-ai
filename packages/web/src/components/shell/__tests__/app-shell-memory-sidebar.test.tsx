import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({
  pathname: '/thread/current',
  search: '',
  sidebarOpen: true,
  sidebarInitialized: true,
  openSidebar: vi.fn(),
}));
const sidebarProps = vi.hoisted(() => ({ last: null as null | { activeDestination?: string | null } }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => true }));
vi.mock('@/hooks/useWorkspaceNavigate', () => ({ useWorkspaceNavigate: vi.fn() }));
vi.mock('@/stores/sidebarStore', () => ({
  initSidebarWidth: vi.fn(),
  useSidebarStore: () => ({
    isOpen: nav.sidebarOpen,
    initialized: nav.sidebarInitialized,
    open: nav.openSidebar,
    width: 260,
    close: vi.fn(),
    handleResize: vi.fn(),
    resetWidth: vi.fn(),
  }),
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (s: (v: { rightPanelMode: string }) => unknown) => s({ rightPanelMode: 'none' }),
}));
vi.mock('@/stores/callbackAuthStore', () => ({ CallbackAuthSnapshotMount: () => null }));
vi.mock('@/components/ActivityBar', () => ({ ActivityBar: () => <nav data-testid="classic-rail" /> }));
vi.mock('../WorldRail', () => ({ WorldRail: () => <nav data-testid="v2-rail" /> }));
vi.mock('@/components/ThreadSidebar', () => ({
  ThreadSidebar: (props: { activeDestination?: string | null }) => {
    sidebarProps.last = props;
    return <aside data-testid="sidebar" data-active-destination={props.activeDestination ?? ''} />;
  },
}));
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
import { SHELL_PRESENTATION_STORAGE_KEY } from '../shell-presentation';

describe('F322 v2: 记忆 is a Café destination that keeps the sidebar', () => {
  let host: HTMLDivElement;
  let root: Root;
  function renderAt(pathname: string, presentation: 'v2' | 'classic') {
    nav.pathname = pathname;
    window.history.replaceState(null, '', pathname);
    window.localStorage.setItem(SHELL_PRESENTATION_STORAGE_KEY, presentation);
    act(() => root.render(<AppShell>page</AppShell>));
  }
  const sidebar = () => host.querySelector('[data-testid="sidebar"]');
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    nav.search = '';
    nav.sidebarOpen = true;
    nav.sidebarInitialized = true;
    nav.openSidebar.mockReset();
    sidebarProps.last = null;
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

  it.each([
    '/memory',
    '/memory/search',
    '/memory/graph',
    '/memory/status',
  ])('v2 keeps the sidebar on %s and names the destination', (path) => {
    renderAt(path, 'v2');
    expect(sidebar()).not.toBeNull();
    expect(sidebar()?.getAttribute('data-active-destination')).toBe('memory');
  });

  it('v2 on a conversation keeps the sidebar with no destination selected', () => {
    renderAt('/thread/current', 'v2');
    expect(sidebar()).not.toBeNull();
    expect(sidebar()?.getAttribute('data-active-destination')).toBe('');
  });

  it('classic still hides the sidebar on /memory, with no destination ever passed', () => {
    renderAt('/memory', 'classic');
    expect(sidebar()).toBeNull();
    renderAt('/thread/current', 'classic');
    expect(sidebar()?.getAttribute('data-active-destination')).toBe('');
  });

  it('classic keeps the sidebar and selected memory destination only on the new preview page', () => {
    renderAt('/memory/preview', 'classic');
    expect(sidebar()).not.toBeNull();
    expect(sidebar()?.getAttribute('data-active-destination')).toBe('memory');
  });

  it('classic preview applies the cold desktop default without reopening a user collapse', () => {
    nav.sidebarOpen = false;
    nav.sidebarInitialized = false;
    renderAt('/memory/preview', 'classic');
    expect(nav.openSidebar).toHaveBeenCalledTimes(1);
    nav.openSidebar.mockClear();
    nav.sidebarInitialized = true;
    renderAt('/memory/preview', 'classic');
    expect(nav.openSidebar).not.toHaveBeenCalled();
  });

  it.each([
    '/settings',
    '/marketplace',
    '/signals',
    '/mission',
    '/starry',
    '/collective',
  ])('v2 still hides the sidebar on %s (only the memory family is exempt)', (path) => {
    renderAt(path, 'v2');
    expect(sidebar()).toBeNull();
  });

  it('the exemption is the memory route family, not any path that starts with the word', () => {
    renderAt('/memory-archive', 'v2');
    expect(sidebar()).toBeNull();
  });

  it("the user's collapsed sidebar stays collapsed on /memory; it is never forced open", () => {
    nav.sidebarOpen = false;
    renderAt('/memory', 'v2');
    expect(sidebar()).toBeNull();
  });
  it('a cold load straight into 记忆 applies the desktop default once, because nothing on that route ever opens the sidebar', () => {
    nav.sidebarOpen = false;
    nav.sidebarInitialized = false;
    renderAt('/memory/search', 'v2');
    expect(nav.openSidebar).toHaveBeenCalledTimes(1);
  });

  it('a collapse the user already made this session is never undone by arriving on 记忆', () => {
    nav.sidebarOpen = false;
    nav.sidebarInitialized = true;
    renderAt('/memory', 'v2');
    expect(nav.openSidebar).not.toHaveBeenCalled();
    expect(sidebar()).toBeNull();
  });

  it('the default is only applied for 记忆 in v2: not classic, not a conversation, not the other hidden routes', () => {
    nav.sidebarOpen = false;
    nav.sidebarInitialized = false;
    renderAt('/memory', 'classic');
    renderAt('/thread/current', 'v2');
    renderAt('/settings', 'v2');
    expect(nav.openSidebar).not.toHaveBeenCalled();
  });
});
