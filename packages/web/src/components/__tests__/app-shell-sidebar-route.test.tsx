import React from 'react';
import { createRoot, hydrateRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navState = vi.hoisted(() => ({
  pathname: '/thread/thread-a',
  search: '',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
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
vi.mock('@/components/shell/WorldRail', () => ({ WorldRail: () => <nav data-testid="world-rail" /> }));

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
vi.mock('@/components/listen-mode/ListenModePlayer', () => ({
  ListenModePlayer: ({ variant, workspaceVisible }: { variant?: string; workspaceVisible?: boolean }) => (
    <output data-testid="listen-placement" data-variant={variant} data-workspace-visible={String(workspaceVisible)} />
  ),
}));
vi.mock('@/components/story-player/TheaterReplayHost', () => ({ TheaterReplayHost: () => null }));
vi.mock('@/components/DesktopUpdatePrompt', () => ({ DesktopUpdatePrompt: () => null }));
vi.mock('@/services/playbackRuntime', () => ({ getPlaybackManager: vi.fn(), destroyPlaybackRuntime: vi.fn() }));

import { AppShell } from '@/components/AppShell';
import { writeShellPresentation } from '@/components/shell/shell-presentation';
import { createArtifactReviewSurface } from '@/components/workbench/artifact-review-surface';
import { createArtifactWorkPresentationState } from '@/components/workbench/artifact-work-presentation';
import { toggleArtifactWorkFullWindow } from '@/components/workbench/artifact-work-presentation-actions';
import { useF307ExperienceWorkbenchStore } from '@/components/workbench/experience-workbench-store';
import { createBrowserSurface } from '@/components/workbench/real-surface-adapters';
import { createInitialWorkbenchState } from '@/components/workbench/workbench-model';
import { useChatStore } from '@/stores/chatStore';

describe('AppShell sidebar route ownership', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    navState.pathname = '/thread/thread-a';
    navState.search = '';
    localStorage.clear();
    writeShellPresentation('classic');
    useChatStore.setState({
      currentThreadId: 'thread-a',
      viewMode: 'single',
      rightPanelOpen: true,
      rightPanelMode: 'workspace',
    });
    useF307ExperienceWorkbenchStore.setState({
      layout: createInitialWorkbenchState(),
      artifactWorkPresentation: createArtifactWorkPresentationState(),
    });
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

  it.each([
    { route: '/thread/thread-a', panel: 'workspace' as const, visible: true },
    { route: '/thread/thread-a', panel: 'status' as const, visible: false },
    { route: '/settings', panel: 'workspace' as const, visible: false },
  ])('places the mini listen control according to the actual route and workspace ($route / $panel)', ({
    route,
    panel,
    visible,
  }) => {
    navState.pathname = route;
    window.history.replaceState(null, '', route);
    useChatStore.setState({ rightPanelMode: panel });
    renderShell('reading');
    const placement = container.querySelector('[data-testid="listen-placement"]');
    expect(placement?.getAttribute('data-variant')).toBe('mini');
    expect(placement?.getAttribute('data-workspace-visible')).toBe(String(visible));
  });

  it.each([
    createBrowserSurface({ ownerKey: 'sidebar-browser', port: 5324, path: '/browser-owner-probe' }),
    createArtifactReviewSurface(`review-${'a'.repeat(64)}`, 'thread-a'),
  ])('temporarily hides the Cafe sidebar for v2 $type full-window without detaching its owner', (surface) => {
    writeShellPresentation('v2');
    useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([surface]) });
    renderShell('workspace content');
    const sidebar = container.querySelector<HTMLElement>('[data-testid="thread-sidebar"]');
    if (!sidebar) throw new Error('the original sidebar is mounted before full-window');
    sidebar.scrollTop = 173;
    const wrapper = sidebar.parentElement?.parentElement;
    React.act(() => toggleArtifactWorkFullWindow('thread-a', surface));
    expect(wrapper?.classList.contains('hidden')).toBe(true);
    expect(container.querySelector('[data-testid="thread-sidebar"]')).toBe(sidebar);
    expect(container.querySelector('[data-testid="world-rail"]')).not.toBeNull();
    React.act(() => toggleArtifactWorkFullWindow('thread-a', surface));
    expect(wrapper?.classList.contains('hidden')).toBe(false);
    expect(container.querySelector('[data-testid="thread-sidebar"]')).toBe(sidebar);
    expect(sidebar.scrollTop).toBe(173);
  });

  it('preserves the classic sidebar projection for an existing Artifact full-window session', () => {
    const artifact = createArtifactReviewSurface(`review-${'b'.repeat(64)}`, 'thread-a');
    useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([artifact]) });
    renderShell('classic workspace');
    const sidebar = container.querySelector('[data-testid="thread-sidebar"]');
    React.act(() => toggleArtifactWorkFullWindow('thread-a', artifact));
    expect(sidebar?.parentElement?.parentElement?.classList.contains('hidden')).toBe(false);
  });

  it('keeps the sidebar visible for another Thread or an inactive surface full-window session', () => {
    writeShellPresentation('v2');
    const browser = createBrowserSurface({ ownerKey: 'stale-browser', port: 5324, path: '/browser-owner-probe' });
    useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState([browser]) });
    renderShell('current thread');
    const sidebar = container.querySelector('[data-testid="thread-sidebar"]');
    const wrapper = sidebar?.parentElement?.parentElement;
    React.act(() => toggleArtifactWorkFullWindow('thread-b', browser));
    expect(wrapper?.classList.contains('hidden')).toBe(false);
    React.act(() => toggleArtifactWorkFullWindow('thread-a', browser));
    expect(wrapper?.classList.contains('hidden')).toBe(true);
    const other = createBrowserSurface({ ownerKey: 'other-browser', port: 5324, path: '/' });
    React.act(() =>
      useF307ExperienceWorkbenchStore.getState().dispatch({
        type: 'open-surface',
        surface: other,
        entitlement: { kind: 'user', reason: 'surface-tab' },
      }),
    );
    expect(wrapper?.classList.contains('hidden')).toBe(false);
    expect(container.querySelector('[data-testid="thread-sidebar"]')).toBe(sidebar);
  });

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
