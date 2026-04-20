import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pushThreadRouteWithHistory } = vi.hoisted(() => ({
  pushThreadRouteWithHistory: vi.fn(),
}));

vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({
  pushThreadRouteWithHistory,
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) => selector({}),
}));

import { CommunityPanel } from '@/components/CommunityPanel';

const MOCK_BOARD = {
  repo: 'test/repo',
  issues: [
    {
      id: 'iss-1',
      repo: 'test/repo',
      issueNumber: 42,
      issueType: 'bug',
      title: 'Fix login',
      state: 'discussing',
      replyState: 'replied',
      assignedThreadId: 'thread-abc',
      updatedAt: Date.now(),
    },
    {
      id: 'iss-2',
      repo: 'test/repo',
      issueNumber: 50,
      issueType: 'feature',
      title: 'Add dark mode',
      state: 'unreplied',
      replyState: 'unreplied',
      assignedThreadId: null,
      updatedAt: Date.now(),
    },
  ],
  prItems: [
    {
      taskId: 'pr-1',
      threadId: 'thread-xyz',
      repo: 'test/repo',
      prNumber: 58,
      title: 'Dark mode PR',
      status: 'open',
      group: 'in-review',
      ownerCatId: 'opus',
      updatedAt: Date.now(),
    },
  ],
};

describe('CommunityPanel navigation (C6)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    pushThreadRouteWithHistory.mockClear();

    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => MOCK_BOARD,
    } as Response);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    vi.restoreAllMocks();
  });

  it('clicking an issue row with assignedThreadId navigates to that thread', async () => {
    await React.act(async () => {
      root.render(React.createElement(CommunityPanel));
    });
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const issueRow = container.querySelector('[data-testid="issue-row-iss-1"]') as HTMLElement;
    expect(issueRow).toBeTruthy();

    React.act(() => {
      issueRow.click();
    });

    expect(pushThreadRouteWithHistory).toHaveBeenCalledWith('thread-abc', window);
  });

  it('clicking an issue row without assignedThreadId does not navigate', async () => {
    await React.act(async () => {
      root.render(React.createElement(CommunityPanel));
    });
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const issueRow = container.querySelector('[data-testid="issue-row-iss-2"]') as HTMLElement;
    expect(issueRow).toBeTruthy();

    React.act(() => {
      issueRow.click();
    });

    expect(pushThreadRouteWithHistory).not.toHaveBeenCalled();
  });

  it('clicking a PR row navigates to its thread', async () => {
    await React.act(async () => {
      root.render(React.createElement(CommunityPanel));
    });
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const prRow = container.querySelector('[data-testid="pr-row-pr-1"]') as HTMLElement;
    expect(prRow).toBeTruthy();

    React.act(() => {
      prRow.click();
    });

    expect(pushThreadRouteWithHistory).toHaveBeenCalledWith('thread-xyz', window);
  });
});
