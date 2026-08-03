/**
 * Regression test: CallbackAuthSnapshotMount must be mounted at AppShell
 * level so the zustand store is populated on ALL non-chromeless routes
 * (settings, memory, mission, etc.). Previously it was only in (chat)/layout
 * which caused the observability panel to show "..." on settings pages.
 *
 * @see PR #2606 — root cause fix
 */

import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAT_THREAD_ROUTE_EVENT } from '@/components/ThreadSidebar/thread-navigation';

const navState = vi.hoisted(() => ({
  pathname: '/',
  search: '',
}));
const useWorkspaceNavigateMock = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  usePathname: () => navState.pathname,
  useSearchParams: () => new URLSearchParams(navState.search),
}));

vi.mock('@/components/ActivityBar', () => ({
  ActivityBar: () => <nav data-testid="activity-bar" />,
}));

vi.mock('@/stores/callbackAuthStore', () => ({
  CallbackAuthSnapshotMount: () => <div data-testid="callback-auth-mount" />,
}));
vi.mock('@/hooks/useWorkspaceNavigate', () => ({
  useWorkspaceNavigate: useWorkspaceNavigateMock,
}));

import { AppShell } from '@/components/AppShell';

describe('AppShell CallbackAuthSnapshotMount presence', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    useWorkspaceNavigateMock.mockClear();
    navState.pathname = '/';
    navState.search = '';
    window.history.replaceState(null, '', '/');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    window.history.replaceState(null, '', '/');
  });

  function renderShell() {
    if (window.location.pathname !== navState.pathname) {
      window.history.replaceState(null, '', navState.pathname);
    }
    React.act(() => {
      root.render(
        <AppShell>
          <main data-testid="content">content</main>
        </AppShell>,
      );
    });
  }

  it('mounts on normal routes (chat)', () => {
    navState.pathname = '/';
    renderShell();
    expect(container.querySelector('[data-testid="callback-auth-mount"]')).toBeTruthy();
  });

  it('mounts on settings route', () => {
    navState.pathname = '/settings';
    renderShell();
    expect(container.querySelector('[data-testid="callback-auth-mount"]')).toBeTruthy();
  });

  it('mounts on memory route', () => {
    navState.pathname = '/memory';
    renderShell();
    expect(container.querySelector('[data-testid="callback-auth-mount"]')).toBeTruthy();
    expect(useWorkspaceNavigateMock).toHaveBeenCalledWith(null, {
      isChatRoute: false,
      isWorkspaceVisible: false,
      enabled: true,
    });
  });

  it('rebinds Workspace navigation when the custom thread route changes before usePathname catches up', () => {
    navState.pathname = '/thread/thread-a';
    window.history.replaceState(null, '', '/thread/thread-a');
    renderShell();
    expect(useWorkspaceNavigateMock).toHaveBeenLastCalledWith('thread-a', {
      isChatRoute: true,
      isWorkspaceVisible: false,
      enabled: true,
    });

    React.act(() => {
      window.history.pushState(null, '', '/thread/thread-b');
      window.dispatchEvent(new Event(CHAT_THREAD_ROUTE_EVENT));
    });

    expect(navState.pathname).toBe('/thread/thread-a');
    expect(useWorkspaceNavigateMock).toHaveBeenLastCalledWith('thread-b', {
      isChatRoute: true,
      isWorkspaceVisible: false,
      enabled: true,
    });
  });

  it('does NOT mount on chromeless /story route', () => {
    navState.pathname = '/story';
    renderShell();
    expect(container.querySelector('[data-testid="callback-auth-mount"]')).toBeNull();
    expect(useWorkspaceNavigateMock).toHaveBeenCalledWith(null, {
      isChatRoute: false,
      isWorkspaceVisible: false,
      enabled: true,
    });
  });

  it('does NOT mount on chromeless /story-export route', () => {
    navState.pathname = '/story-export';
    renderShell();
    expect(container.querySelector('[data-testid="callback-auth-mount"]')).toBeNull();
  });

  it('does NOT mount in export mode', () => {
    navState.pathname = '/';
    navState.search = 'export=true';
    window.history.pushState(null, '', '/?export=true');
    renderShell();
    expect(container.querySelector('[data-testid="callback-auth-mount"]')).toBeNull();
  });
});
