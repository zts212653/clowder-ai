import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navState = vi.hoisted(() => ({
  pathname: '/',
  search: '',
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => navState.pathname,
  useSearchParams: () => new URLSearchParams(navState.search),
}));

vi.mock('@/components/ActivityBar', () => ({
  ActivityBar: () => <nav data-testid="activity-bar" />,
}));
vi.mock('@/hooks/useWorkspaceNavigate', () => {
  // AppShell mounts the hook through WorkspaceNavigateHost; the host forwards to the mocked hook.
  const useWorkspaceNavigate = vi.fn();
  return {
    useWorkspaceNavigate,
    WorkspaceNavigateHost: ({ threadId, ...options }: { threadId: string | null }) => {
      useWorkspaceNavigate(threadId, options);
      return null;
    },
  };
});
vi.mock('@/services/playbackRuntime', () => ({ getPlaybackManager: vi.fn(), destroyPlaybackRuntime: vi.fn() }));
// The chromeless page connection, without the network: the tests only ask whether AppShell mounts it.
vi.mock('@/components/thread-chat/StandaloneHubSocketProvider', () => ({
  StandaloneHubSocketProvider: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="standalone-page-connection">{children}</div>
  ),
}));

import { AppShell } from '@/components/AppShell';
import { loadExportThreadTitle, selectMessagesForExport } from '@/components/message-export-selection';
import {
  readShellPresentation,
  useShellPresentation,
  writeShellPresentation,
} from '@/components/shell/shell-presentation';
import { useWorkspaceNavigate } from '@/hooks/useWorkspaceNavigate';

function PresentationProbe() {
  return <output data-testid="presentation">{useShellPresentation()}</output>;
}

describe('AppShell export mode', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    navState.pathname = '/';
    navState.search = '';
    writeShellPresentation('classic');
    window.history.replaceState(null, '', '/');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    React.act(() => root.unmount());
    container.remove();
    window.history.replaceState(null, '', '/');
  });

  function renderShell() {
    React.act(() => {
      root.render(
        <AppShell>
          <main data-testid="content">
            <PresentationProbe />
          </main>
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
    expect(container.querySelector('[data-testid="presentation"]')?.textContent).toBe('v2');
    expect(document.documentElement.dataset.shell).toBe('v2');
    expect(readShellPresentation()).toBe('classic');

    navState.search = '';
    window.history.pushState(null, '', '/');
    renderShell();
    expect(container.querySelector('[data-testid="activity-bar"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="presentation"]')?.textContent).toBe('classic');
    expect(document.documentElement.dataset.shell).toBeUndefined();
  });

  it.each([
    'export=true',
    'export=true&shell=classic',
    'export=true&shell=v2',
  ])('renders a direct %s document in v2 without changing the saved interface', (search) => {
    navState.search = search;
    window.history.replaceState(null, '', `/?${search}`);
    renderShell();

    expect(container.querySelector('[data-testid="presentation"]')?.textContent).toBe('v2');
    expect(document.documentElement.dataset.shell).toBe('v2');
    expect(container.querySelector('[data-testid="activity-bar"]')).toBeNull();
    expect(readShellPresentation()).toBe('classic');
  });

  function navigationWasEnabled() {
    return vi
      .mocked(useWorkspaceNavigate)
      .mock.calls.some(([, options]) => (options as { enabled?: boolean } | undefined)?.enabled === true);
  }

  it.each([
    '/story-export',
    '/story',
    '/showcase',
  ])('keeps an exported %s page off workspace navigation and the page connection', (pathname) => {
    vi.mocked(useWorkspaceNavigate).mockClear();
    navState.pathname = pathname;
    navState.search = 'export=true';
    window.history.replaceState(null, '', `${pathname}?export=true`);
    renderShell();

    expect(container.querySelector('[data-testid="content"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="standalone-page-connection"]')).toBeNull();
    expect(navigationWasEnabled()).toBe(false);
  });

  it('still queues workspace navigation on a chromeless page outside export (#3276)', () => {
    vi.mocked(useWorkspaceNavigate).mockClear();
    navState.pathname = '/story';
    window.history.replaceState(null, '', '/story');
    renderShell();

    expect(container.querySelector('[data-testid="standalone-page-connection"] [data-testid="content"]')).toBeTruthy();
    expect(navigationWasEnabled()).toBe(true);
  });
});

describe('selective export message projection', () => {
  const messages = [{ id: 'message-1' }, { id: 'message-2' }, { id: 'message-3' }];

  it('renders only validated IDs in server-normalized order', () => {
    expect(selectMessagesForExport(messages, ['message-3', 'message-1'])).toEqual({
      messages: [{ id: 'message-3' }, { id: 'message-1' }],
      ready: true,
    });
  });

  it('keeps export readiness closed for missing or duplicate IDs', () => {
    expect(selectMessagesForExport(messages, ['message-1', 'missing'])).toEqual({
      messages: [{ id: 'message-1' }],
      ready: false,
    });
    expect(selectMessagesForExport(messages, ['message-1', 'message-1'])).toEqual({
      messages: [],
      ready: false,
    });
  });

  it('loads authoritative source metadata before declaring the capture ready', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ title: 'F294 source' }), { status: 200 }));
    await expect(loadExportThreadTitle('thread-source', fetcher)).resolves.toBe('F294 source');
    expect(fetcher).toHaveBeenCalledWith('/api/threads/thread-source');
  });
});
