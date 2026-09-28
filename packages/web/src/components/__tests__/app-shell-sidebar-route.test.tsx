import React from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navState = vi.hoisted(() => ({
  pathname: '/thread/thread-a',
  search: '',
}));

vi.mock('next/navigation', () => ({
  usePathname: () => navState.pathname,
  useSearchParams: () => new URLSearchParams(navState.search),
}));

vi.mock('@/hooks/useWorkspaceNavigate', () => ({
  useWorkspaceNavigate: vi.fn(),
}));

vi.mock('@/stores/sidebarStore', () => ({
  initSidebarWidth: vi.fn(),
  useSidebarStore: () => ({
    isOpen: true,
    width: 240,
    close: vi.fn(),
    handleResize: vi.fn(),
    resetWidth: vi.fn(),
  }),
}));

vi.mock('@/stores/callbackAuthStore', () => ({
  CallbackAuthSnapshotMount: () => null,
}));

vi.mock('@/components/ActivityBar', () => ({
  ActivityBar: () => <nav data-testid="activity-bar" />,
}));

vi.mock('@/components/ThreadSidebar', () => ({
  ThreadSidebar: () => <aside data-testid="thread-sidebar" />,
}));

vi.mock('@/components/workspace/ResizeHandle', () => ({
  ResizeHandle: () => null,
}));

vi.mock('@/components/workspace/FloatingPresentationSurfaceHost', () => ({
  FloatingPresentationSurfaceHost: () => null,
}));

vi.mock('@/components/concierge/ConciergeHost', () => ({
  ConciergeHost: () => null,
}));

vi.mock('@/components/thread-chat', () => ({
  ThreadChatRuntimeProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/listen-mode/ListenModePlayer', () => ({ ListenModePlayer: () => null }));
vi.mock('@/components/story-player/TheaterReplayHost', () => ({ TheaterReplayHost: () => null }));
vi.mock('@/components/DesktopUpdatePrompt', () => ({ DesktopUpdatePrompt: () => null }));
vi.mock('@/services/playbackRuntime', () => ({ getPlaybackManager: vi.fn(), destroyPlaybackRuntime: vi.fn() }));

import { AppShell } from '@/components/AppShell';

describe('AppShell sidebar route ownership', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    navState.pathname = '/thread/thread-a';
    navState.search = '';
    vi.stubGlobal('matchMedia', () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    window.history.replaceState(null, '', '/thread/thread-a');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    React.act(() => root.unmount());
    container.remove();
    window.history.replaceState(null, '', '/');
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
    vi.unstubAllGlobals();
  });

  function renderShell(content: string) {
    React.act(() => {
      root.render(
        <AppShell>
          <main>{content}</main>
        </AppShell>,
      );
    });
  }

  it('replaces the thread sidebar with settings navigation during a Next route transition', () => {
    renderShell('thread content');
    expect(container.querySelector('[data-testid="thread-sidebar"]')).toBeTruthy();

    navState.pathname = '/settings';
    renderShell('settings content');
    expect(window.location.pathname).toBe('/thread/thread-a');

    window.history.pushState(null, '', '/settings');

    expect(container.textContent).toContain('settings content');
    expect(container.querySelector('[data-testid="thread-sidebar"]')).toBeNull();
  });

  it('hydrates a desktop shell without replacing its existing thread content', async () => {
    React.act(() => root.unmount());
    const content = (
      <AppShell>
        <main>
          <input defaultValue="server draft" />
        </main>
      </AppShell>
    );
    const browserWindow = window;
    try {
      vi.stubGlobal('window', undefined);
      container.innerHTML = renderToString(content);
    } finally {
      vi.stubGlobal('window', browserWindow);
    }
    const originalInput = container.querySelector('input');
    if (!originalInput) throw new Error('SSR thread content is missing');
    originalInput.value = 'draft entered before hydration';
    const errors: unknown[] = [];
    await React.act(async () => {
      root = hydrateRoot(container, content, { onRecoverableError: (error) => errors.push(error) });
    });
    expect(errors).toEqual([]);
    expect(container.querySelector('input')).toBe(originalInput);
    expect(originalInput.value).toBe('draft entered before hydration');
    expect(container.querySelector('[data-testid="thread-sidebar"]')).not.toBeNull();
  });
});
