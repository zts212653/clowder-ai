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

import { AppShell } from '@/components/AppShell';

describe('AppShell export mode', () => {
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

  it('recomputes export chrome when the query string changes after mount', () => {
    renderShell();
    expect(container.querySelector('[data-testid="activity-bar"]')).toBeTruthy();

    navState.search = 'export=true';
    window.history.pushState(null, '', '/?export=true');
    renderShell();
    expect(container.querySelector('[data-testid="activity-bar"]')).toBeNull();

    navState.search = '';
    window.history.pushState(null, '', '/');
    renderShell();
    expect(container.querySelector('[data-testid="activity-bar"]')).toBeTruthy();
  });
});
