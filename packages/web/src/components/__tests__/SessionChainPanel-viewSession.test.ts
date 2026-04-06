import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  (globalThis as { React?: typeof React }).React = React;
});
afterAll(() => {
  delete (globalThis as { React?: typeof React }).React;
});

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mocks.apiFetch(...args),
}));

// Stub child components that are irrelevant to this test
vi.mock('../BindNewSessionSection', () => ({
  BindNewSessionSection: () => null,
}));
vi.mock('../ContextHealthBar', () => ({
  ContextHealthBar: () => null,
}));
vi.mock('../SessionChainInputs', () => ({
  BindSessionInput: () => null,
  SessionIdTag: ({ id }: { id: string }) => React.createElement('span', null, id),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (id: string) => {
      const cats: Record<string, { id: string; displayName: string }> = {
        opus: { id: 'opus', displayName: '布偶猫' },
      };
      return cats[id];
    },
  }),
}));

const sealedSession = {
  id: 'sess-abc',
  cliSessionId: 'cli-abc',
  catId: 'opus',
  seq: 2,
  status: 'sealed' as const,
  messageCount: 15,
  sealReason: 'compact',
  createdAt: Date.now() - 3600_000,
  sealedAt: Date.now() - 1800_000,
};

describe('SessionChainPanel onViewSession', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.apiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ sessions: [] }),
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
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ sessions: [sealedSession] }),
    });

    const { SessionChainPanel } = await import('../SessionChainPanel');
    const defaultProps = {
      threadId: 't1',
      catInvocations: {},
      onViewSession: vi.fn(),
      ...props,
    };
    await act(async () => {
      root.render(React.createElement(SessionChainPanel, defaultProps));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    return defaultProps;
  }

  it('renders a "查看" button on sealed sessions when onViewSession is provided', async () => {
    await renderPanel();

    const viewBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '查看');
    expect(viewBtn).toBeTruthy();
  });

  it('calls onViewSession with sessionId when "查看" is clicked', async () => {
    const props = await renderPanel();

    const viewBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '查看');
    expect(viewBtn).toBeTruthy();

    await act(async () => {
      viewBtn?.click();
    });

    expect(props.onViewSession).toHaveBeenCalledWith('sess-abc', 'opus');
  });
});
