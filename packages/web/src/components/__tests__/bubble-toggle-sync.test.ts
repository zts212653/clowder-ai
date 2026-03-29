/**
 * P1/P2 regression: BubbleToggle must sync chatStore after success
 * and clear optimistic state.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ConfigData, SystemTab } from '../config-viewer-tabs';

// ── Mocks ─────────────────────────────────────────────────────
const mockApiFetch = vi.fn();
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

const mockFetchGlobalBubbleDefaults = vi.fn();
vi.mock('@/stores/chatStore', () => ({
  useChatStore: { getState: () => ({ fetchGlobalBubbleDefaults: mockFetchGlobalBubbleDefaults }) },
}));

function jsonOk(data: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
}

const CONFIG: ConfigData = {
  cats: {},
  perCatBudgets: {},
  a2a: { enabled: true, maxDepth: 2 },
  memory: { enabled: true, maxKeysPerThread: 50 },
  governance: { degradationEnabled: true, doneTimeoutMs: 300000, heartbeatIntervalMs: 30000 },
  ui: { bubbleDefaults: { thinking: 'collapsed', cliOutput: 'collapsed' } },
};

describe('BubbleToggle sync (P1/P2)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    mockApiFetch.mockReset();
    mockFetchGlobalBubbleDefaults.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function flush() {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  it('P1: calls fetchGlobalBubbleDefaults after successful toggle', async () => {
    mockApiFetch.mockImplementation(() => jsonOk({}));
    const onConfigChange = vi.fn();

    act(() => {
      root.render(React.createElement(SystemTab, { config: CONFIG, onConfigChange }));
    });
    await flush();

    // Find the first bubble toggle button (Thinking)
    const toggleBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === '折叠' || b.textContent === '展开',
    )!;
    expect(toggleBtn).toBeTruthy();

    await act(async () => {
      toggleBtn.click();
    });
    await flush();

    expect(mockFetchGlobalBubbleDefaults).toHaveBeenCalled();
  });

  it('P2: clears optimistic state after successful toggle so external refresh wins', async () => {
    mockApiFetch.mockImplementation(() => jsonOk({}));
    const onConfigChange = vi.fn();

    act(() => {
      root.render(React.createElement(SystemTab, { config: CONFIG, onConfigChange }));
    });
    await flush();

    const toggleBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === '折叠' || b.textContent === '展开',
    )!;

    // Click toggle — optimistic sets to 'expanded'
    await act(async () => {
      toggleBtn.click();
    });
    await flush();

    // After success, if we re-render with the SAME original config (server hasn't refreshed yet),
    // the button should show the server value (collapsed), not the stale optimistic value,
    // because optimistic should be cleared.
    act(() => {
      root.render(React.createElement(SystemTab, { config: CONFIG, onConfigChange }));
    });
    await flush();

    // The button should show '折叠' (collapsed) because optimistic was cleared
    // and config still says 'collapsed'
    const btn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === '折叠' || b.textContent === '展开',
    )!;
    expect(btn.textContent).toBe('折叠');
  });
});
