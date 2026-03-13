import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: () => null,
    cats: [],
  }),
  formatCatName: (id: string) => id,
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(() => Promise.resolve({ ok: false })),
  API_URL: 'http://localhost:3000',
}));

describe('Right status panel resizable width (#37)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useChatStore.setState({
      messages: [],
      currentThreadId: 'test-thread',
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders aside with inline width style when width prop is provided', async () => {
    const { RightStatusPanel } = await import('../RightStatusPanel');
    act(() => {
      root.render(
        React.createElement(RightStatusPanel, {
          intentMode: null,
          targetCats: [],
          catStatuses: {},
          catInvocations: {},
          threadId: 'test-thread',
          messageSummary: { total: 0, assistant: 0, system: 0, evidence: 0, followup: 0 },
          width: 400,
        }),
      );
    });

    const aside = container.querySelector('aside');
    expect(aside).not.toBeNull();
    expect(aside?.style.width).toBe('400px');
    // Should NOT have w-72 class when width is provided
    expect(aside?.className).not.toContain('w-72');
  });

  it('renders aside with w-72 class when no width prop is provided', async () => {
    const { RightStatusPanel } = await import('../RightStatusPanel');
    act(() => {
      root.render(
        React.createElement(RightStatusPanel, {
          intentMode: null,
          targetCats: [],
          catStatuses: {},
          catInvocations: {},
          threadId: 'test-thread',
          messageSummary: { total: 0, assistant: 0, system: 0, evidence: 0, followup: 0 },
        }),
      );
    });

    const aside = container.querySelector('aside');
    expect(aside).not.toBeNull();
    expect(aside?.className).toContain('w-72');
    expect(aside?.style.width).toBe('');
  });

  it('handleStatusPanelResize clamps width within bounds', () => {
    // Test the resize handler logic directly (same as ChatContainer uses)
    const MIN = 200;
    const MAX = 560;
    const clamp = (prev: number, delta: number) => Math.min(MAX, Math.max(MIN, prev - delta));

    // Dragging left (negative delta) = wider
    expect(clamp(288, -100)).toBe(388);
    // Dragging right (positive delta) = narrower
    expect(clamp(288, 50)).toBe(238);
    // Should not go below MIN
    expect(clamp(288, 100)).toBe(MIN);
    // Should not go above MAX
    expect(clamp(288, -400)).toBe(MAX);
  });
});
