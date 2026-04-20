import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => vi.fn());

vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({
  pushThreadRouteWithHistory: vi.fn(),
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
      title: 'Fix login bug',
      state: 'discussing',
      replyState: 'replied',
      assignedThreadId: 'thread-abc',
      assignedCatId: 'opus',
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
      updatedAt: Date.now(),
    },
    {
      id: 'iss-3',
      repo: 'test/repo',
      issueNumber: 55,
      issueType: 'bug',
      title: 'Crash on startup',
      state: 'accepted',
      replyState: 'replied',
      assignedThreadId: 'thread-xyz',
      assignedCatId: 'codex',
      updatedAt: Date.now(),
    },
  ],
  prItems: [],
};

describe('CommunityPanel filtering (C7)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

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

  it('renders state filter dropdown', async () => {
    await React.act(async () => {
      root.render(React.createElement(CommunityPanel));
    });
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const filter = container.querySelector('[data-testid="issue-state-filter"]') as HTMLSelectElement;
    expect(filter).toBeTruthy();
    expect(filter.value).toBe('all');
  });

  it('filtering by state shows only matching issues', async () => {
    await React.act(async () => {
      root.render(React.createElement(CommunityPanel));
    });
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const filter = container.querySelector('[data-testid="issue-state-filter"]') as HTMLSelectElement;

    await React.act(async () => {
      filter.value = 'unreplied';
      filter.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const issueRows = container.querySelectorAll('[data-testid^="issue-row-"]');
    expect(issueRows.length).toBe(1);
    expect(issueRows[0].getAttribute('data-testid')).toBe('issue-row-iss-2');
  });

  it('renders cat filter dropdown', async () => {
    await React.act(async () => {
      root.render(React.createElement(CommunityPanel));
    });
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const filter = container.querySelector('[data-testid="cat-filter"]') as HTMLSelectElement;
    expect(filter).toBeTruthy();
  });

  it("filtering by cat shows only that cat's issues", async () => {
    await React.act(async () => {
      root.render(React.createElement(CommunityPanel));
    });
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const filter = container.querySelector('[data-testid="cat-filter"]') as HTMLSelectElement;

    await React.act(async () => {
      filter.value = 'opus';
      filter.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const issueRows = container.querySelectorAll('[data-testid^="issue-row-"]');
    expect(issueRows.length).toBe(1);
    expect(issueRows[0].getAttribute('data-testid')).toBe('issue-row-iss-1');
  });

  it('renders repo as a select dropdown populated from /api/community-repos', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
      if (String(url).includes('/api/community-repos')) {
        return { ok: true, json: async () => ({ repos: ['org/alpha', 'org/beta'] }) } as Response;
      }
      return { ok: true, json: async () => MOCK_BOARD } as Response;
    });

    await React.act(async () => {
      root.render(React.createElement(CommunityPanel));
    });
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const repoSelect = container.querySelector('[data-testid="repo-filter"]') as HTMLSelectElement;
    expect(repoSelect).toBeTruthy();
    expect(repoSelect.tagName).toBe('SELECT');
    const values = Array.from(repoSelect.options).map((o) => o.value);
    expect(values).toContain('org/alpha');
    expect(values).toContain('org/beta');
  });

  it('time range filter shows only recent issues', async () => {
    const now = Date.now();
    const boardWithDates = {
      ...MOCK_BOARD,
      issues: [
        { ...MOCK_BOARD.issues[0], updatedAt: now - 2 * 86400000 },
        { ...MOCK_BOARD.issues[1], updatedAt: now - 14 * 86400000 },
        { ...MOCK_BOARD.issues[2], updatedAt: now - 60 * 86400000 },
      ],
    };

    vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
      if (String(url).includes('/api/community-repos')) {
        return { ok: true, json: async () => ({ repos: ['test/repo'] }) } as Response;
      }
      return { ok: true, json: async () => boardWithDates } as Response;
    });

    await React.act(async () => {
      root.render(React.createElement(CommunityPanel));
    });
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const timeFilter = container.querySelector('[data-testid="time-range-filter"]') as HTMLSelectElement;
    expect(timeFilter).toBeTruthy();

    await React.act(async () => {
      timeFilter.value = '7d';
      timeFilter.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const issueRows = container.querySelectorAll('[data-testid^="issue-row-"]');
    expect(issueRows.length).toBe(1);
  });
});
