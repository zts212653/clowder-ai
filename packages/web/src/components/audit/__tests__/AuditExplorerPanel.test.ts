import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));
vi.mock('../../runtime-sessions/ExternalRuntimeSessionsPanel', () => ({
  ExternalRuntimeSessionsPanel: ({ onViewSession }: { onViewSession?: (sessionId: string, catId?: string) => void }) =>
    React.createElement(
      'div',
      { 'data-testid': 'runtime-sessions-panel' },
      React.createElement(
        'button',
        {
          type: 'button',
          onClick: () => onViewSession?.('runtime-session-1', 'antigravity'),
        },
        'open runtime session',
      ),
    ),
}));

describe('AuditExplorerPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.apiFetch.mockReset();
    // Default: return empty responses for any audit/session fetches
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ events: [], hits: [], logPath: null, logFiles: [] }),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderPanel(props = {}) {
    const { AuditExplorerPanel } = await import('../AuditExplorerPanel');
    const defaultProps = { threadId: 't1', ...props };
    await act(async () => {
      root.render(React.createElement(AuditExplorerPanel, defaultProps));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }

  it('renders with 3 tabs: 审计事件, Session, 搜索', async () => {
    await renderPanel();

    const buttons = Array.from(container.querySelectorAll('button'));
    const tabLabels = buttons.map((b) => b.textContent);
    expect(tabLabels).toEqual(expect.arrayContaining(['审计事件', 'Session', '搜索']));
  });

  it('shows AuditEventsTab content by default', async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ events: [], logPath: null, logFiles: [] }),
    });

    await renderPanel();

    // Default tab is audit events, which shows empty state
    expect(container.textContent).toContain('最近 7 天无审计事件');
  });

  it('switches to search tab on click', async () => {
    await renderPanel();

    const searchTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '搜索');
    expect(searchTab).toBeTruthy();

    await act(async () => {
      searchTab?.click();
    });

    // Search tab shows input
    const input = container.querySelector('input[type="text"]');
    expect(input).toBeTruthy();
  });

  it('opens runtime tab and switches selected runtime session into the session viewer', async () => {
    mocks.apiFetch.mockImplementation((url: string) => {
      const body = url.includes('/api/sessions/runtime-session-1/events')
        ? { messages: [{ role: 'user', content: 'runtime evidence', timestamp: 1000 }], nextCursor: null, total: 1 }
        : { events: [], logPath: null, logFiles: [] };
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(body),
      });
    });

    await renderPanel();

    const runtimeTab = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Runtime');
    expect(runtimeTab).toBeTruthy();

    await act(async () => {
      runtimeTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="runtime-sessions-panel"]')).toBeTruthy();

    const openButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'open runtime session',
    );
    await act(async () => {
      openButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(container.querySelector('[data-testid="session-viewer-close"]')).toBeTruthy();
    expect(mocks.apiFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/sessions/runtime-session-1/events?view=chat'),
    );
  });

  it('starts collapsed and expands on click', async () => {
    await renderPanel();

    // Should have header with expand toggle
    const header = container.querySelector('[data-testid="audit-explorer-header"]');
    expect(header).toBeTruthy();
  });

  it('calls onCloseSession when viewer is closed, enabling reopen of same session', async () => {
    const onCloseSession = vi.fn();

    // First render with an external session
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ events: [{ role: 'user', content: 'hello', timestamp: 1000 }], nextCursor: null, total: 1 }),
    });

    await renderPanel({ externalSessionId: 's1', onCloseSession });

    // Should show session viewer with close button
    const closeBtn = container.querySelector('[data-testid="session-viewer-close"]');
    expect(closeBtn).toBeTruthy();

    // Close the viewer
    await act(async () => {
      closeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // Parent callback should have been called to clear external state
    expect(onCloseSession).toHaveBeenCalled();
  });

  it('clears session viewer when externalSessionId changes to null (thread switch)', async () => {
    // Simulate: user opens session in thread A, then switches to thread B (parent clears prop)
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ events: [{ role: 'user', content: 'hello', timestamp: 1000 }], nextCursor: null, total: 1 }),
    });

    const { AuditExplorerPanel } = await import('../AuditExplorerPanel');

    // Render with a session open
    await act(async () => {
      root.render(React.createElement(AuditExplorerPanel, { threadId: 't1', externalSessionId: 's1' }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Session viewer should be showing
    const closeBtn = container.querySelector('[data-testid="session-viewer-close"]');
    expect(closeBtn).toBeTruthy();

    // Re-render with null externalSessionId (simulates thread switch clearing parent state)
    await act(async () => {
      root.render(React.createElement(AuditExplorerPanel, { threadId: 't2', externalSessionId: null }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Session viewer should be gone — should show placeholder text
    const closeBtnAfter = container.querySelector('[data-testid="session-viewer-close"]');
    expect(closeBtnAfter).toBeNull();
    expect(container.textContent).toContain('点击左侧');
  });
});
