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

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (id: string) => {
      const cats: Record<string, { id: string; displayName: string }> = {
        kimi: { id: 'kimi', displayName: '梵花猫' },
        opus: { id: 'opus', displayName: '布偶猫' },
      };
      return cats[id];
    },
  }),
}));

const chatMessages = [
  { role: 'user', content: 'hello', timestamp: 1000 },
  { role: 'assistant', content: 'hi there', timestamp: 2000 },
];

const handoffInvocations = [
  {
    invocationId: 'inv-1',
    eventCount: 5,
    toolCalls: ['Read', 'Edit'],
    errors: 0,
    durationMs: 1200,
    keyMessages: ['read file'],
  },
  { invocationId: 'inv-2', eventCount: 3, toolCalls: ['Bash'], errors: 1, durationMs: 800, keyMessages: ['ran test'] },
];

describe('SessionEventsViewer', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.apiFetch.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderViewer(props = {}) {
    const { SessionEventsViewer } = await import('../SessionEventsViewer');
    const defaultProps = { sessionId: 's1', onClose: vi.fn(), ...props };
    await act(async () => {
      root.render(React.createElement(SessionEventsViewer, defaultProps));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }

  it('renders chat messages in chat view mode', async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ messages: chatMessages, nextCursor: null, total: 2 }),
    });

    await renderViewer();

    expect(mocks.apiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/sessions/s1/events?view=chat'));
    expect(container.textContent).toContain('hello');
    expect(container.textContent).toContain('hi there');
  });

  it('renders external runtime metadata and digest noise diagnostics when available', async () => {
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url.includes('/api/sessions/s1/events')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ messages: chatMessages, nextCursor: null, total: 2 }),
        });
      }
      if (url === '/api/external-runtime-sessions/s1') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              sessionId: 's1',
              threadId: 'external-runtime:antigravity-desktop:user-1',
              runtime: 'antigravity-desktop',
              runtimeSessionId: 'cascade-0123456789abcdef',
              runtimeConversationId: 'conversation-1',
              catId: 'antigravity',
              model: 'gemini-3.1-pro',
              lastObservedAt: 1000,
              lifecycle: {
                state: 'sealed',
                startedAt: 900,
                lastObservedAt: 1000,
                sealReason: 'runtime_disconnected',
                drainResult: 'complete',
              },
              binding: { mode: 'thread', threadId: 'thread-1', requestedBy: 'agent_key' },
              identityHistory: [
                {
                  catId: 'antigravity',
                  model: 'gemini-3.1-pro',
                  from: 900,
                  source: 'external_registration',
                },
              ],
              drilldown: {
                sessionRecord: '/api/sessions/s1',
                events: '/api/sessions/s1/events',
                digest: '/api/sessions/s1/digest',
              },
            }),
        });
      }
      if (url === '/api/sessions/s1/digest') {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              diagnostics: {
                noise: [
                  {
                    kind: 'context_canceled',
                    count: 2,
                    sample: 'context canceled',
                    invocationIds: ['inv-1'],
                    firstAt: 900,
                    lastAt: 950,
                    outcome: 'recovered',
                  },
                ],
              },
            }),
        });
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    });

    await renderViewer();

    expect(container.textContent).toContain('cascade-012');
    expect(container.textContent).toContain('conversation-1');
    expect(container.textContent).toContain('已封存');
    expect(container.textContent).toContain('Runtime 断开');
    expect(container.textContent).toContain('Thread 绑定');
    expect(container.textContent).toContain('gemini-3.1-pro');
    expect(container.textContent).toContain('context_canceled × 2');
    expect(container.textContent).toContain('recovered');
    expect(container.textContent).toContain('hello');
  });

  it('keeps normal session rendering when external runtime metadata returns 404', async () => {
    mocks.apiFetch.mockImplementation((url: string) => {
      if (url.includes('/api/sessions/s1/events')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ messages: chatMessages, nextCursor: null, total: 2 }),
        });
      }
      if (url === '/api/external-runtime-sessions/s1') {
        return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    });

    await renderViewer();

    expect(container.textContent).toContain('hello');
    expect(container.textContent).not.toContain('加载失败');
  });

  it('uses kimi theme colors for assistant chat rows when catId is kimi', async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ messages: chatMessages, nextCursor: null, total: 2 }),
    });

    await renderViewer({ catId: 'kimi' });

    expect(container.innerHTML).toContain('bg-kimi-light');
    expect(container.innerHTML).toContain('text-kimi-dark');
    expect(container.textContent).toContain('梵花猫');
    expect(container.innerHTML).not.toContain('bg-purple-50');
    expect(container.innerHTML).not.toContain('text-purple-800');
  });

  it('falls back to neutral colors when session catId is unknown', async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ messages: chatMessages, nextCursor: null, total: 2 }),
    });

    await renderViewer({ catId: 'unknown-cat' });

    expect(container.innerHTML).toContain('bg-cafe-surface-elevated');
    expect(container.innerHTML).toContain('text-cafe-secondary');
    expect(container.innerHTML).not.toContain('bg-purple-50');
  });

  it('switches to handoff view and renders invocation summaries', async () => {
    // First fetch: chat view
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ messages: chatMessages, nextCursor: null, total: 2 }),
    });

    await renderViewer();

    // Click handoff tab
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ invocations: handoffInvocations, nextCursor: null, total: 2 }),
    });

    const handoffBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Handoff'));
    expect(handoffBtn).toBeTruthy();

    await act(async () => {
      handoffBtn?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(container.textContent).toContain('inv-1');
    expect(container.textContent).toContain('Read');
    expect(container.textContent).toContain('Edit');
  });

  it('paginates with next/prev buttons', async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ messages: chatMessages, nextCursor: { eventNo: 30 }, total: 60 }),
    });

    await renderViewer();

    // Should show "下一页" button
    const nextBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('下一页'));
    expect(nextBtn).toBeTruthy();

    // Click next page
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          messages: [{ role: 'user', content: 'page 2', timestamp: 3000 }],
          nextCursor: null,
          total: 60,
        }),
    });
    await act(async () => {
      nextBtn?.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(container.textContent).toContain('page 2');
  });

  it('calls onClose when close button clicked', async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ messages: chatMessages, nextCursor: null, total: 2 }),
    });

    const onClose = vi.fn();
    await renderViewer({ onClose });

    const closeBtn = container.querySelector('[data-testid="session-viewer-close"]');
    expect(closeBtn).toBeTruthy();
    await act(async () => {
      closeBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onClose).toHaveBeenCalled();
  });

  it('shows error state on fetch failure', async () => {
    mocks.apiFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    await renderViewer();

    expect(container.textContent).toContain('加载失败');
  });
});
