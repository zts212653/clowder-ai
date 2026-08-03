import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const navState = vi.hoisted(() => ({ pathname: '/starry' }));

vi.mock('next/navigation', () => ({
  usePathname: () => navState.pathname,
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => true }));
vi.mock('@/hooks/useWorkspaceNavigate', () => ({ useWorkspaceNavigate: vi.fn() }));
vi.mock('@/stores/sidebarStore', () => ({
  initSidebarWidth: () => {},
  useSidebarStore: () => ({
    isOpen: true,
    width: 320,
    close: () => {},
    handleResize: () => {},
    resetWidth: () => {},
  }),
}));
vi.mock('@/stores/callbackAuthStore', () => ({ CallbackAuthSnapshotMount: () => null }));
vi.mock('@/components/ActivityBar', () => ({ ActivityBar: () => <nav data-testid="activity-bar" /> }));
vi.mock('@/components/ThreadSidebar', () => ({ ThreadSidebar: () => <aside data-testid="thread-sidebar" /> }));
vi.mock('@/components/workspace/ResizeHandle', () => ({ ResizeHandle: () => <div data-testid="resize-handle" /> }));
vi.mock('@/components/workspace/FloatingPresentationSurfaceHost', () => ({
  FloatingPresentationSurfaceHost: () => null,
}));
vi.mock('@/components/concierge/ConciergeHost', () => ({ ConciergeHost: () => null }));

import { AppShell } from '@/components/AppShell';

describe('F258 Visible Cafe focused shell', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    navState.pathname = '/starry';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    React.act(() => root.unmount());
    container.remove();
    window.history.replaceState(null, '', '/');
  });

  it.each([
    '/starry',
    '/starry/immersive',
  ])('keeps the global ActivityBar but hides the thread sidebar on %s', (pathname) => {
    navState.pathname = pathname;
    window.history.replaceState(null, '', pathname);

    React.act(() => {
      root.render(
        <AppShell>
          <main>cat planet</main>
        </AppShell>,
      );
    });

    expect(container.querySelector('[data-testid="activity-bar"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="thread-sidebar"]')).toBeNull();
    expect(container.querySelector('[data-testid="resize-handle"]')).toBeNull();
    expect(container.textContent).toContain('cat planet');
  });
});
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = undefined;
});
