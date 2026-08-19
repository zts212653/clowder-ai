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
vi.mock('@/hooks/useWorkspaceNavigate', () => ({ useWorkspaceNavigate: vi.fn() }));

import { AppShell } from '@/components/AppShell';
import { loadExportThreadTitle, selectMessagesForExport } from '@/components/message-export-selection';

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
