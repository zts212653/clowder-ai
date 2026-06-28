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
      assignedCatId: 'codex',
      assignedThreadName: '社区运维',
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
      assignedCatId: null,
      assignedThreadName: null,
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
      group: 'unreplied',
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

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes('/api/community-repos')) {
        return { ok: true, json: async () => ({ repos: ['test/repo'] }) } as Response;
      }
      if (requestUrl.includes('/api/community-decision-queue')) {
        return { ok: true, json: async () => ({ items: [], warnings: [] }) } as Response;
      }
      if (requestUrl.includes('/api/community-findings')) {
        return { ok: true, json: async () => ({ findings: [] }) } as Response;
      }
      return { ok: true, json: async () => MOCK_BOARD } as Response;
    });
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

  it('AC-F6: assigned issue shows assignment chip with cat + thread name', async () => {
    await React.act(async () => {
      root.render(React.createElement(CommunityPanel));
    });
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const chip = container.querySelector('[data-testid="assignment-chip-iss-1"]') as HTMLElement;
    expect(chip).toBeTruthy();
    expect(chip.textContent).toContain('codex');
    expect(chip.textContent).toContain('社区运维');
    expect(chip.textContent).toContain('→');
    expect(chip.title).toBe('codex → 社区运维');

    // KD-9 / INV-E4.3: SVG icons only, no emoji
    expect(chip.textContent).not.toMatch(/[\u{1F000}-\u{1FFFF}]/u);
    const svgIcon = chip.querySelector('[data-testid="icon-user-assign"]');
    expect(svgIcon).toBeTruthy();
  });

  it('AC-F6: unassigned issue does not show assignment chip', async () => {
    await React.act(async () => {
      root.render(React.createElement(CommunityPanel));
    });
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const chip = container.querySelector('[data-testid="assignment-chip-iss-2"]');
    expect(chip).toBeFalsy();
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
