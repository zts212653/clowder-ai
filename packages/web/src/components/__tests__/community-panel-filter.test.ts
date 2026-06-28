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

const STALE_QUEUE_ITEM = {
  id: 'decision:external-followup:issue:test/repo#42:stale',
  repo: 'test/repo',
  subjectKey: 'issue:test/repo#42',
  subjectType: 'issue',
  number: 42,
  kind: 'external-followup',
  priority: 'normal',
  actor: 'case-owner',
  status: 'open',
  title: 'Reply to stale issue',
  ask: 'Follow up on the previous repo issue.',
  why: 'The previous repo queue should disappear once the repo input is blank.',
  recommendedActions: [],
  evidenceRefs: [],
  source: {},
  firstSeenAt: Date.now(),
  lastUpdatedAt: Date.now(),
};

function deferredResponse<T>(body: T): { promise: Promise<Response>; resolve: () => void } {
  let resolvePromise: () => void = () => {
    throw new Error('Deferred response resolver was not initialized');
  };
  const promise = new Promise<Response>((resolve) => {
    resolvePromise = () => resolve({ ok: true, json: async () => body } as Response);
  });
  return { promise, resolve: resolvePromise };
}

describe('CommunityPanel filtering (C7)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

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

  it('renders repo as a free-form input with suggestions from /api/community-repos', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
      if (String(url).includes('/api/community-repos')) {
        return { ok: true, json: async () => ({ repos: ['org/alpha', 'org/beta'] }) } as Response;
      }
      if (String(url).includes('/api/community-decision-queue')) {
        return { ok: true, json: async () => ({ items: [], warnings: [] }) } as Response;
      }
      if (String(url).includes('/api/community-findings')) {
        return { ok: true, json: async () => ({ findings: [] }) } as Response;
      }
      return { ok: true, json: async () => MOCK_BOARD } as Response;
    });

    await React.act(async () => {
      root.render(React.createElement(CommunityPanel));
    });
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const repoInput = container.querySelector('[data-testid="repo-filter"]') as HTMLInputElement;
    expect(repoInput).toBeTruthy();
    expect(repoInput.tagName).toBe('INPUT');
    const suggestions = container.querySelector('[data-testid="repo-suggestions"]') as HTMLDataListElement;
    const values = Array.from(suggestions.options).map((o) => o.value);
    expect(values).toContain('org/alpha');
    expect(values).toContain('org/beta');
  });

  it('allows syncing a repo before it appears in /api/community-repos', async () => {
    const fetchSpy = vi.mocked(globalThis.fetch);
    fetchSpy.mockImplementation(async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes('/api/community-repos')) {
        return { ok: true, json: async () => ({ repos: [] }) } as Response;
      }
      if (requestUrl.includes('/api/community-decision-queue')) {
        return { ok: true, json: async () => ({ items: [], warnings: [] }) } as Response;
      }
      if (requestUrl.includes('/api/community-findings')) {
        return { ok: true, json: async () => ({ findings: [] }) } as Response;
      }
      return { ok: true, json: async () => ({ ...MOCK_BOARD, repo: 'fresh/repo' }) } as Response;
    });

    await React.act(async () => {
      root.render(React.createElement(CommunityPanel));
    });
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const repoInput = container.querySelector('[data-testid="repo-filter"]') as HTMLInputElement;
    const syncButton = container.querySelector('[data-testid="community-sync-button"]') as HTMLButtonElement;
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

    await React.act(async () => {
      valueSetter?.call(repoInput, 'fresh/repo');
      repoInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await React.act(async () => {
      syncButton.click();
    });

    expect(
      fetchSpy.mock.calls.some(
        ([url, init]) =>
          typeof url === 'string' &&
          url.includes('/api/community-issues/sync?repo=fresh%2Frepo') &&
          (init as RequestInit | undefined)?.method === 'POST',
      ),
    ).toBe(true);
    expect(
      fetchSpy.mock.calls.some(
        ([url, init]) =>
          typeof url === 'string' &&
          url.includes('/api/community-issues/sync-prs?repo=fresh%2Frepo') &&
          (init as RequestInit | undefined)?.method === 'POST',
      ),
    ).toBe(true);
  });

  it('clears stale board and decision queue when the repo input is empty', async () => {
    vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes('/api/community-repos')) {
        return { ok: true, json: async () => ({ repos: ['test/repo'] }) } as Response;
      }
      if (requestUrl.includes('/api/community-decision-queue')) {
        return { ok: true, json: async () => ({ items: [STALE_QUEUE_ITEM], warnings: ['stale warning'] }) } as Response;
      }
      if (requestUrl.includes('/api/community-findings')) {
        return { ok: true, json: async () => ({ findings: [] }) } as Response;
      }
      return { ok: true, json: async () => MOCK_BOARD } as Response;
    });

    await React.act(async () => {
      root.render(React.createElement(CommunityPanel));
    });
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container.querySelector('[data-testid="issue-row-iss-1"]')).toBeTruthy();
    expect(container.textContent).toContain('Reply to stale issue');

    const repoInput = container.querySelector('[data-testid="repo-filter"]') as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;

    await React.act(async () => {
      valueSetter?.call(repoInput, '');
      repoInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container.querySelector('[data-testid="issue-row-iss-1"]')).toBeNull();
    expect(container.textContent).toContain('社区管理看板');
    expect(container.textContent).toContain('Queue: 0');
    expect(container.textContent).not.toContain('Reply to stale issue');
    expect(container.textContent).not.toContain('stale warning');
  });

  it('ignores stale board responses after the repo input is cleared', async () => {
    const staleBoardResponse = deferredResponse(MOCK_BOARD);
    const staleQueueResponse = deferredResponse({ items: [STALE_QUEUE_ITEM], warnings: ['stale warning'] });

    vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
      const requestUrl = String(url);
      if (requestUrl.includes('/api/community-repos')) {
        return { ok: true, json: async () => ({ repos: ['test/repo'] }) } as Response;
      }
      if (requestUrl.includes('/api/community-decision-queue?repo=test%2Frepo')) {
        return staleQueueResponse.promise;
      }
      if (requestUrl.includes('/api/community-findings')) {
        return { ok: true, json: async () => ({ findings: [] }) } as Response;
      }
      if (requestUrl.includes('/api/community-board?repo=test%2Frepo')) {
        return staleBoardResponse.promise;
      }
      return { ok: true, json: async () => MOCK_BOARD } as Response;
    });

    await React.act(async () => {
      root.render(React.createElement(CommunityPanel));
    });
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const repoInput = container.querySelector('[data-testid="repo-filter"]') as HTMLInputElement;
    const valueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    expect(repoInput.value).toBe('test/repo');

    await React.act(async () => {
      valueSetter?.call(repoInput, '');
      repoInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container.querySelector('[data-testid="issue-row-iss-1"]')).toBeNull();
    expect(container.textContent).toContain('Queue: 0');

    await React.act(async () => {
      staleBoardResponse.resolve();
      staleQueueResponse.resolve();
      await staleBoardResponse.promise;
      await staleQueueResponse.promise;
    });
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    expect(container.querySelector('[data-testid="issue-row-iss-1"]')).toBeNull();
    expect(container.textContent).not.toContain('Reply to stale issue');
    expect(container.textContent).not.toContain('stale warning');
    expect(container.textContent).not.toContain('Fix login bug');
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
      if (String(url).includes('/api/community-decision-queue')) {
        return { ok: true, json: async () => ({ items: [], warnings: [] }) } as Response;
      }
      if (String(url).includes('/api/community-findings')) {
        return { ok: true, json: async () => ({ findings: [] }) } as Response;
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
