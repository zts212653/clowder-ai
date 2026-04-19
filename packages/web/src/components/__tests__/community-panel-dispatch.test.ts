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
      id: 'iss-unassigned',
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
      id: 'iss-assigned',
      repo: 'test/repo',
      issueNumber: 42,
      issueType: 'bug',
      title: 'Fix login',
      state: 'discussing',
      replyState: 'replied',
      assignedThreadId: 'thread-abc',
      assignedCatId: 'opus',
      updatedAt: Date.now(),
    },
  ],
  prItems: [],
};

describe('CommunityPanel dispatch (B5)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => MOCK_BOARD,
    } as Response);
  });

  afterEach(() => {
    root.unmount();
    container.remove();
    vi.restoreAllMocks();
  });

  it('shows dispatch button only for unreplied issues', async () => {
    await React.act(async () => {
      root.render(React.createElement(CommunityPanel));
    });
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const dispatchBtns = container.querySelectorAll('[data-testid^="dispatch-btn-"]');
    expect(dispatchBtns.length).toBe(1);
    expect(dispatchBtns[0].getAttribute('data-testid')).toBe('dispatch-btn-iss-unassigned');
  });

  it('clicking dispatch button calls POST /api/community-issues/:id/dispatch', async () => {
    await React.act(async () => {
      root.render(React.createElement(CommunityPanel));
    });
    await React.act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ...MOCK_BOARD.issues[0], state: 'discussing' }),
    } as Response);

    const btn = container.querySelector('[data-testid="dispatch-btn-iss-unassigned"]') as HTMLButtonElement;
    await React.act(async () => {
      btn.click();
    });

    const dispatchCall = fetchSpy.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && c[0].includes('/dispatch'),
    );
    expect(dispatchCall).toBeTruthy();
    expect(dispatchCall![0]).toContain('/api/community-issues/iss-unassigned/dispatch');
    expect((dispatchCall![1] as RequestInit)?.method).toBe('POST');
  });
});
