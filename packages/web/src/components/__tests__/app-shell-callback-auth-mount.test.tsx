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

const navState = vi.hoisted(() => ({
  pathname: '/',
  search: '',
}));

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

import { AppShell } from '@/components/AppShell';

describe('AppShell CallbackAuthSnapshotMount presence', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
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
  });

  it('does NOT mount on chromeless /story route', () => {
    navState.pathname = '/story';
    renderShell();
    expect(container.querySelector('[data-testid="callback-auth-mount"]')).toBeNull();
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
