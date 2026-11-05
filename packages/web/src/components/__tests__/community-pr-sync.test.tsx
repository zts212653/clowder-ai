// Component interaction fixtures; direct transport is covered by community-direct-api.test.tsx.
vi.mock('@/utils/api-client', () => ({
  apiFetch: (path: string, init?: RequestInit) => globalThis.fetch(path, init),
}));

import React from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

vi.mock('@/hooks/useCatNameResolver', () => ({ useCatNameResolver: () => (id: string) => id }));
vi.mock('@/components/ThreadSidebar/thread-navigation', () => ({ pushThreadRouteWithHistory: vi.fn() }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: Record<string, unknown>) => unknown) => selector({}),
}));

import { CommunityPanel } from '@/components/CommunityPanel';

it('shows incomplete and failed PR sync honestly and continues only on operator action', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let status = 'incomplete';
  let syncs = 0;
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    let data: unknown = {};
    if (url.startsWith('/api/plugins/official.github-operations/github/community-repos'))
      data = { repos: ['owner/repo'] };
    if (url.startsWith('/api/plugins/official.github-operations/github/community-board'))
      data = {
        repo: 'owner/repo',
        issues: [],
        prItems: [],
        prIndex: { publishedGeneration: 'g1', observedAt: 1, refreshStatus: status, failedSubjects: [] },
      };
    if (url.startsWith('/api/plugins/official.github-operations/github/community-decision-queue'))
      data = { items: [], warnings: [] };
    if (url.startsWith('/api/plugins/official.github-operations/github/community-findings')) data = { findings: [] };
    if (url.startsWith('/api/plugins/official.github-operations/github/community-issues/sync-prs')) {
      syncs++;
      status = 'failed';
      data = { status, complete: false, hasMore: true };
    }
    return { ok: true, json: async () => data } as Response;
  });
  try {
    await React.act(async () => {
      root.render(<CommunityPanel />);
    });
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(container.textContent).toContain('PR 同步尚未完成');
    expect(container.textContent).toContain('上次完整结果');
    expect(syncs).toBe(0);
    const button = [...container.querySelectorAll('button')].find((item) => item.textContent === '继续同步 PR');
    expect(button).toBeDefined();
    await React.act(async () => {
      button?.click();
    });
    expect(syncs).toBe(1);
    expect(container.textContent).toContain('PR 同步失败');
    expect(container.textContent).toContain('重试 PR');
  } finally {
    await React.act(async () => root.unmount());
    container.remove();
    fetch.mockRestore();
  }
});

for (const mode of ['unavailable-empty', 'http-error']) {
  it(`reports initial repository discovery failure without requiring a selected repo: ${mode}`, async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let boardReads = 0;
    let discoveryReads = 0;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.startsWith('/api/plugins/official.github-operations/github/community-repos')) discoveryReads++;
      if (url.startsWith('/api/plugins/official.github-operations/github/community-board')) boardReads++;
      return {
        ok: mode !== 'http-error',
        json: async () => ({ repos: [], prSourceStatus: 'unavailable', findings: [] }),
      } as Response;
    });
    try {
      await React.act(async () => {
        root.render(<CommunityPanel />);
      });
      await React.act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(container.textContent).toContain('无法读取 PR 仓库');
      expect(container.textContent).toContain('GitHub 插件');
      expect(boardReads).toBe(0);
      const retry = [...container.querySelectorAll('button')].find((item) => item.textContent === '重新读取仓库');
      expect(retry).toBeDefined();
      await React.act(async () => {
        retry?.click();
      });
      expect(discoveryReads).toBe(2);
      expect(boardReads).toBe(0);
    } finally {
      await React.act(async () => root.unmount());
      container.remove();
      fetch.mockRestore();
    }
  });
}
