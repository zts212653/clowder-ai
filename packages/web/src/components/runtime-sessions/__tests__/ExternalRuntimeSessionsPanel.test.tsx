import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExternalRuntimeSessionListItem } from '../external-runtime-session-types';

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

function item(overrides: Partial<ExternalRuntimeSessionListItem> = {}): ExternalRuntimeSessionListItem {
  return {
    sessionId: 'session-active',
    threadId: 'external-runtime:antigravity-desktop:user-1',
    runtime: 'antigravity-desktop',
    runtimeSessionId: 'cascade-active-1234567890abcdef',
    runtimeConversationId: 'conversation-active',
    catId: 'antigravity',
    surface: 'ide-direct',
    model: 'gemini-3.1-pro',
    title: 'IDE active session',
    lastObservedAt: 1780000000000,
    lifecycle: { state: 'active', startedAt: 1779999999000, lastObservedAt: 1780000000000 },
    binding: { mode: 'orphan_anchor', anchorThreadId: 'external-runtime:antigravity-desktop:user-1' },
    drilldown: {
      sessionRecord: '/api/sessions/session-active',
      events: '/api/sessions/session-active/events',
      digest: '/api/sessions/session-active/digest',
    },
    ...overrides,
  };
}

const sessions = [
  item(),
  item({
    sessionId: 'session-sealed',
    runtimeSessionId: 'cascade-sealed-1234567890abcdef',
    runtimeConversationId: 'conversation-sealed',
    catId: 'antig-opus',
    surface: 'cat-cafe-dispatch',
    model: 'claude-opus-4-6',
    title: undefined,
    lastObservedAt: 1780000001000,
    lifecycle: {
      state: 'sealed',
      startedAt: 1779999998000,
      lastObservedAt: 1780000001000,
      sealReason: 'runtime_disconnected',
      drainResult: 'complete',
    },
    binding: { mode: 'thread', threadId: 'thread-1', requestedBy: 'agent_key' },
  }),
] satisfies ExternalRuntimeSessionListItem[];

describe('ExternalRuntimeSessionsPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sessions }),
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
    const { ExternalRuntimeSessionsPanel } = await import('../ExternalRuntimeSessionsPanel');
    await act(async () => {
      root.render(React.createElement(ExternalRuntimeSessionsPanel, props));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }

  it('loads recent Antigravity runtime sessions on mount', async () => {
    await renderPanel();

    expect(mocks.apiFetch).toHaveBeenCalledWith('/api/external-runtime-sessions?runtime=antigravity-desktop&limit=20');
  });

  it('renders active and sealed runtime-session evidence fields', async () => {
    await renderPanel();

    expect(container.textContent).toContain('Antigravity Desktop');
    expect(container.textContent).toContain('IDE active session');
    expect(container.textContent).toContain('进行中');
    expect(container.textContent).toContain('cascade-a');
    expect(container.textContent).toContain('conversation-active');
    expect(container.textContent).toContain('antigravity');
    expect(container.textContent).toContain('gemini-3.1-pro');
    expect(container.textContent).toContain('IDE 直连');
    expect(container.textContent).toContain('已封存');
    expect(container.textContent).toContain('Runtime 断开');
    expect(container.textContent).toContain('Thread 绑定');
    // F211-REG1: surface must be visible so dispatched vs IDE-direct is distinguishable.
    expect(container.textContent).toContain('Café 派发');
  });

  it('renders a concise empty state without exposing hidden anchor thread ids', async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ sessions: [] }),
    });

    await renderPanel();

    expect(container.textContent).toContain('没有 runtime 会话');
    expect(container.textContent).not.toContain('external-runtime:');
  });

  it('renders a retryable error state', async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ error: 'unavailable' }),
    });

    await renderPanel();

    expect(container.textContent).toContain('unavailable');
    expect(Array.from(container.querySelectorAll('button')).some((button) => button.textContent === '刷新')).toBe(true);
  });

  it('calls onViewSession when opening a session', async () => {
    const onViewSession = vi.fn();
    await renderPanel({ onViewSession });

    const viewButton = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === '查看');
    expect(viewButton).toBeTruthy();

    await act(async () => {
      viewButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onViewSession).toHaveBeenCalledWith('session-active', 'antigravity');
  });

  it('filters visible rows locally without refetching', async () => {
    await renderPanel();
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);

    const sealedFilter = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === '封存',
    );
    expect(sealedFilter).toBeTruthy();

    await act(async () => {
      sealedFilter?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain('IDE active session');
    expect(container.textContent).toContain('antig-opus · claude-opus-4-6');
  });
});
