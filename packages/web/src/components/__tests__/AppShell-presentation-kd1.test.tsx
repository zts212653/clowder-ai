import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { AppShell } from '../AppShell';

/**
 * F226 KD-1 integration test (砚砚 P1-2): the presentation float is mounted at AppShell
 * root level (outside route children), so it MUST survive a route change. This is the
 * core architectural risk — verified here at unit level via createRoot + pathname swap,
 * no browser needed. AC-A2 (survive route switch) + AC-A5 (host survival test).
 */
const nav = vi.hoisted(() => ({ pathname: '/thread/x' }));

vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => {} }),
}));
vi.mock('@/hooks/useIsDesktop', () => ({ useIsDesktop: () => false }));
vi.mock('@/stores/sidebarStore', () => ({
  useSidebarStore: () => ({
    isOpen: false,
    width: 240,
    close: () => {},
    handleResize: () => {},
    resetWidth: () => {},
  }),
  initSidebarWidth: () => {},
}));
// Stub heavy rail/sidebar children so the test stays focused on AppShell + float host.
vi.mock('../ActivityBar', () => ({ ActivityBar: () => null }));
vi.mock('../ThreadSidebar', () => ({ ThreadSidebar: () => null }));
vi.mock('@/utils/api-client', () => ({
  API_URL: 'http://localhost:3112',
  apiFetch: () => Promise.resolve({ ok: false, json: () => Promise.resolve(null) }),
}));

const sampleSurface = {
  content: {
    worktreeId: 'wt-main',
    filePath: 'docs/讲稿.md',
    tabs: ['docs/讲稿.md'],
    fileKind: 'markdown' as const,
    renderMode: 'rendered' as const,
    line: null,
    scrollTop: null,
    title: '讲稿.md',
  },
  pos: { x: 600, y: 400 },
  size: { width: 420, height: 320 },
  minimized: false,
  maximized: false,
  preMaximizeGeometry: null,
};

describe('F226 KD-1: presentation float survives route change (AppShell-root mount)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterAll(() => {
    (globalThis as { React?: typeof React }).React = undefined;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = undefined;
  });
  beforeEach(() => {
    nav.pathname = '/thread/x';
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({ presentationSurface: sampleSurface });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useChatStore.setState({ presentationSurface: null });
  });

  it('float (with filename) is visible on a /thread/* route', async () => {
    await act(async () => {
      root.render(<AppShell>{React.createElement('div', null, 'thread content')}</AppShell>);
    });
    expect(container.textContent).toContain('讲稿.md');
    expect(container.textContent).toContain('thread content');
  });

  it('float STILL visible after route children swap to /memory (KD-1)', async () => {
    await act(async () => {
      root.render(<AppShell>{React.createElement('div', null, 'thread content')}</AppShell>);
    });
    expect(container.textContent).toContain('讲稿.md');

    // Simulate route change: pathname + route children both change; AppShell stays mounted.
    nav.pathname = '/memory';
    await act(async () => {
      root.render(<AppShell>{React.createElement('div', null, 'memory hub content')}</AppShell>);
    });
    expect(container.textContent).toContain('memory hub content'); // new route rendered
    expect(container.textContent).toContain('讲稿.md'); // KD-1: float survived the route change
  });

  it('renders exactly one float instance (no double mount)', async () => {
    await act(async () => {
      root.render(<AppShell>{React.createElement('div', null, 'thread content')}</AppShell>);
    });
    const dockBackButtons = Array.from(container.querySelectorAll('button')).filter((b) =>
      b.textContent?.includes('回坞'),
    );
    expect(dockBackButtons).toHaveLength(1);
  });

  it('Esc closes the float when no overlay is open', async () => {
    await act(async () => {
      root.render(<AppShell>{React.createElement('div', null, 'thread content')}</AppShell>);
    });
    expect(useChatStore.getState().presentationSurface).not.toBeNull();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(useChatStore.getState().presentationSurface).toBeNull();
  });

  it('Esc does NOT close the float when a fullscreen overlay (fixed inset-0) is open (砚砚 R3)', async () => {
    await act(async () => {
      root.render(<AppShell>{React.createElement('div', null, 'thread content')}</AppShell>);
    });
    // All existing modals/overlays are fixed inset-0 backdrops (role varies) — simulate one open.
    const overlay = document.createElement('div');
    overlay.className = 'fixed inset-0';
    document.body.appendChild(overlay);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(useChatStore.getState().presentationSurface).not.toBeNull(); // overlay has Esc priority
    overlay.remove();
  });

  it('Esc still closes the float when only a non-interactive backdrop is present (砚砚 R4)', async () => {
    await act(async () => {
      root.render(<AppShell>{React.createElement('div', null, 'thread content')}</AppShell>);
    });
    // MobileStatusSheet-style backdrop: permanently rendered, hidden via opacity-0 + pointer-events-none.
    const hiddenBackdrop = document.createElement('div');
    hiddenBackdrop.className = 'fixed inset-0 opacity-0 pointer-events-none';
    document.body.appendChild(hiddenBackdrop);
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    // A non-interactive backdrop must NOT block Esc — float still closes.
    expect(useChatStore.getState().presentationSurface).toBeNull();
    hiddenBackdrop.remove();
  });
});
