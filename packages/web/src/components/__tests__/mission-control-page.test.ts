import type { CatId } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissionControlPage } from '@/components/mission-control/MissionControlPage';
import { useChatStore } from '@/stores/chatStore';
import { useMissionControlStore } from '@/stores/missionControlStore';
import {
  createMissionControlMockBackend,
  flush,
  type MissionControlMockBackend,
  type MutableBacklogItem,
  mockResponse,
  setNativeValue,
} from './mission-control-page.test-helpers';

const mockApiFetch = vi.hoisted(() => vi.fn());

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) =>
    React.createElement('a', { href, ...rest }, children),
}));

vi.mock('@/components/ThreadSidebar', () => ({
  ThreadSidebar: () => React.createElement('aside', { 'data-testid': 'thread-sidebar' }),
}));

describe('MissionControlPage', () => {
  let container: HTMLDivElement;
  let root: Root;
  let backend: MissionControlMockBackend;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    useMissionControlStore.setState({
      items: [],
      loading: false,
      submitting: false,
      selectedItemId: null,
      selectedPhase: 'coding',
      error: null,
    });

    backend = createMissionControlMockBackend();
    mockApiFetch.mockReset();
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => backend.handleRequest(path, init));
  });

  afterEach(() => {
    vi.useRealTimers();
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders back-to-chat link with href="/"', async () => {
    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const backLink = container.querySelector('[data-testid="mc-back-to-chat"]') as HTMLAnchorElement | null;
    expect(backLink).not.toBeNull();
    expect(backLink?.getAttribute('href')).toBe('/');
  });

  it('does not render the thread sidebar inside mission hub layout', async () => {
    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    expect(container.querySelector('[data-testid="thread-sidebar"]')).toBeNull();
  });

  it('creates backlog items from quick create form', async () => {
    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    expect(container.textContent).toContain('Mission Hub');

    const titleInput = container.querySelector('[data-testid="mc-create-title"]') as HTMLInputElement | null;
    const summaryInput = container.querySelector('[data-testid="mc-create-summary"]') as HTMLInputElement | null;
    const submitButton = container.querySelector('[data-testid="mc-create-submit"]') as HTMLButtonElement | null;

    expect(titleInput).not.toBeNull();
    expect(summaryInput).not.toBeNull();
    expect(submitButton).not.toBeNull();
    if (!titleInput || !summaryInput || !submitButton) return;

    await act(async () => {
      setNativeValue(titleInput, '新增任务');
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      setNativeValue(summaryInput, '用于验证快速创建流程');
      summaryInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      submitButton.click();
    });
    await flush(act);

    expect(container.textContent).toContain('新增任务');
    expect(backend.getItems().some((item) => item.title === '新增任务')).toBe(true);
  });

  it('imports active docs backlog items via manual refresh button', async () => {
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/backlog/import-active-features' && init?.method === 'POST') {
        backend.setItems([
          {
            id: 'imported-f010',
            userId: 'u_test',
            title: 'F010 手机端猫猫',
            summary: '来自 docs/ROADMAP.md',
            priority: 'p1',
            tags: ['source:docs-backlog', 'feature:f010'],
            status: 'open',
            createdBy: 'user',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            audit: [
              {
                id: 'a-imported',
                action: 'created',
                actor: { kind: 'user', id: 'u_test' },
                timestamp: Date.now(),
              },
            ],
          } satisfies MutableBacklogItem,
        ]);
        return Promise.resolve(mockResponse(200, { imported: 1, skipped: 0, totalActive: 1 }));
      }
      return backend.handleRequest(path, init);
    });

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const importButton = container.querySelector('[data-testid="mc-import-docs"]') as HTMLButtonElement | null;
    expect(importButton).not.toBeNull();
    expect(importButton?.textContent).toContain('导入 Backlog');
    if (!importButton) return;

    await act(async () => {
      importButton.click();
    });
    await flush(act);

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/backlog/import-active-features',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(container.textContent).toContain('F010 手机端猫猫');
  });

  it('moves item from open to dispatched through suggest and approve flow', async () => {
    const now = Date.now();
    backend.setItems([
      {
        id: 'seed-1',
        userId: 'u_test',
        title: '种子任务',
        summary: '先建议，再批准',
        priority: 'p1',
        tags: ['f049'],
        status: 'open',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        audit: [{ id: 'a-seed', action: 'created', actor: { kind: 'user', id: 'u_test' }, timestamp: now }],
      } satisfies MutableBacklogItem,
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const card = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('种子任务'),
    );
    expect(card).toBeTruthy();
    if (!card) return;

    await act(async () => {
      card.click();
    });

    const whyInput = container.querySelector('[data-testid="mc-suggest-why"]') as HTMLTextAreaElement | null;
    const planInput = container.querySelector('[data-testid="mc-suggest-plan"]') as HTMLTextAreaElement | null;
    const suggestButton = container.querySelector('[data-testid="mc-suggest-submit"]') as HTMLButtonElement | null;

    expect(whyInput).not.toBeNull();
    expect(planInput).not.toBeNull();
    expect(suggestButton).not.toBeNull();
    if (!whyInput || !planInput || !suggestButton) return;

    await act(async () => {
      setNativeValue(whyInput, '这个任务适合先由 codex 领');
      whyInput.dispatchEvent(new Event('input', { bubbles: true }));
      setNativeValue(planInput, '先拆分接口与页面，再执行验收');
      planInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const suggestForm = suggestButton.closest('form');
    expect(suggestForm).not.toBeNull();
    if (!suggestForm) return;

    await act(async () => {
      suggestForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush(act);
    await flush(act);

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/backlog/items/seed-1/suggest-claim',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(container.textContent).toContain('种子任务');

    const approveButton = container.querySelector('[data-testid="mc-approve-submit"]') as HTMLButtonElement | null;
    expect(approveButton).not.toBeNull();
    if (!approveButton) return;

    await act(async () => {
      approveButton.click();
    });
    await flush(act);

    expect(container.textContent).toContain('种子任务');
    const threadLink = container.querySelector('[data-testid="mc-open-thread-link"]') as HTMLAnchorElement | null;
    expect(threadLink?.getAttribute('href')).toBe('/thread/thread-1');
  });

  it('renders thread situational summary for dispatched backlog items', async () => {
    const now = Date.now();
    backend.setItems([
      {
        id: 'seed-situation',
        userId: 'u_test',
        title: '态势任务',
        summary: '应展示 thread 态势',
        priority: 'p1',
        tags: ['situation'],
        status: 'dispatched',
        createdBy: 'user',
        createdAt: now - 10_000,
        updatedAt: now - 1_000,
        dispatchedAt: now - 5_000,
        dispatchedThreadId: 'thread-situation-1',
        dispatchedThreadPhase: 'coding',
        audit: [
          { id: 'a-situation', action: 'dispatched', actor: { kind: 'user', id: 'u_test' }, timestamp: now - 5_000 },
        ],
      } satisfies MutableBacklogItem,
    ]);
    backend.setThreads([
      {
        id: 'thread-situation-1',
        title: 'Thread Alpha',
        createdBy: 'u_test',
        lastActiveAt: now - 500,
        participants: ['codex' as CatId],
        backlogItemId: 'seed-situation',
      },
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    // Switch to threads tab
    const threadsTab = container.querySelector('[data-testid="mc-right-tab-threads"]') as HTMLButtonElement;
    if (threadsTab) {
      await act(async () => {
        threadsTab.click();
      });
      await flush(act);
    }

    const panel = container.querySelector('[data-testid="mc-thread-situation"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('Thread Alpha');
    expect(panel?.textContent).toContain('codex');
    expect(panel?.textContent).toContain('态势任务');
    expect(panel?.textContent).toContain('最近活跃');
  });

  it('shows fallback message when dispatched item has no mapped thread', async () => {
    const now = Date.now();
    backend.setItems([
      {
        id: 'seed-no-thread',
        userId: 'u_test',
        title: '待映射任务',
        summary: '应显示降级提示',
        priority: 'p2',
        tags: ['situation'],
        status: 'dispatched',
        createdBy: 'user',
        createdAt: now - 10_000,
        updatedAt: now - 1_000,
        dispatchedAt: now - 5_000,
        dispatchedThreadId: 'thread-missing',
        dispatchedThreadPhase: 'coding',
        audit: [
          { id: 'a-no-thread', action: 'dispatched', actor: { kind: 'user', id: 'u_test' }, timestamp: now - 5_000 },
        ],
      } satisfies MutableBacklogItem,
    ]);
    backend.setThreads([]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    // Switch to threads tab
    const threadsTab = container.querySelector('[data-testid="mc-right-tab-threads"]') as HTMLButtonElement;
    if (threadsTab) {
      await act(async () => {
        threadsTab.click();
      });
      await flush(act);
    }

    const panel = container.querySelector('[data-testid="mc-thread-situation"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('待映射任务');
    expect(panel?.textContent).toContain('暂无关联 thread');
  });

  it('ignores stale thread-situation responses and keeps latest mapping', async () => {
    const now = Date.now();
    const itemA: MutableBacklogItem = {
      id: 'seed-stale-a',
      userId: 'u_test',
      title: '旧任务',
      summary: '旧请求应被丢弃',
      priority: 'p1',
      tags: ['situation'],
      status: 'dispatched',
      createdBy: 'user',
      createdAt: now - 10_000,
      updatedAt: now - 1_000,
      dispatchedAt: now - 5_000,
      dispatchedThreadId: 'thread-old',
      dispatchedThreadPhase: 'coding',
      audit: [{ id: 'a-stale-a', action: 'dispatched', actor: { kind: 'user', id: 'u_test' }, timestamp: now - 5_000 }],
    };
    const itemB: MutableBacklogItem = {
      ...itemA,
      id: 'seed-stale-b',
      title: '新任务',
      dispatchedThreadId: 'thread-new',
      audit: [{ id: 'a-stale-b', action: 'dispatched', actor: { kind: 'user', id: 'u_test' }, timestamp: now - 3_000 }],
    };

    backend.setItems([itemA]);
    backend.setThreads([]);

    let resolveFirstThreads: ((response: Response) => void) | null = null;

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path.startsWith('/api/threads?') && (!init?.method || init.method === 'GET')) {
        const url = new URL(path, 'http://localhost');
        const backlogIds = url.searchParams.get('backlogItemIds') ?? '';
        if (backlogIds.includes(itemA.id)) {
          return new Promise<Response>((resolve) => {
            resolveFirstThreads = resolve;
          });
        }
        if (backlogIds.includes(itemB.id)) {
          return Promise.resolve(
            mockResponse(200, {
              threads: [
                {
                  id: 'thread-new',
                  title: 'Thread New',
                  createdBy: 'u_test',
                  lastActiveAt: now - 200,
                  participants: ['codex'],
                  backlogItemId: itemB.id,
                },
              ],
            }),
          );
        }
      }
      return backend.handleRequest(path, init);
    });

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    expect(resolveFirstThreads).not.toBeNull();
    if (!resolveFirstThreads) return;

    await act(async () => {
      useMissionControlStore.setState({
        items: [itemB],
        selectedItemId: itemB.id,
      });
    });
    await flush(act);

    (resolveFirstThreads as (response: Response) => void)(
      mockResponse(200, {
        threads: [
          {
            id: 'thread-old',
            title: 'Thread Old',
            createdBy: 'u_test',
            lastActiveAt: now - 1_000,
            participants: ['codex' as CatId],
            backlogItemId: itemA.id,
          },
        ],
      }),
    );
    await flush(act);

    // Switch to threads tab
    const threadsTab = container.querySelector('[data-testid="mc-right-tab-threads"]') as HTMLButtonElement;
    if (threadsTab) {
      await act(async () => {
        threadsTab.click();
      });
      await flush(act);
    }

    const panel = container.querySelector('[data-testid="mc-thread-situation"]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('新任务');
    expect(panel?.textContent).toContain('Thread New');
    expect(panel?.textContent).not.toContain('Thread Old');
  });

  it('rejects suggested item back to open lane', async () => {
    const now = Date.now();
    backend.setItems([
      {
        id: 'seed-reject',
        userId: 'u_test',
        title: '驳回路径',
        summary: '建议后应可退回 open',
        priority: 'p2',
        tags: ['f049'],
        status: 'suggested',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        audit: [{ id: 'a-reject', action: 'created', actor: { kind: 'user', id: 'u_test' }, timestamp: now }],
        suggestion: {
          catId: 'codex' as CatId,
          why: '先给建议',
          plan: '再驳回',
          requestedPhase: 'coding',
          status: 'pending',
          suggestedAt: now,
        },
      } satisfies MutableBacklogItem,
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const card = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('驳回路径'),
    );
    expect(card).toBeTruthy();
    if (!card) return;

    await act(async () => {
      card.click();
    });

    const rejectButton = container.querySelector('[data-testid="mc-reject-submit"]') as HTMLButtonElement | null;
    expect(rejectButton).not.toBeNull();
    if (!rejectButton) return;

    await act(async () => {
      rejectButton.click();
    });
    await flush(act);

    expect(container.textContent).toContain('驳回路径');
  });

  it('shows retry action for approved item and dispatches on click', async () => {
    const now = Date.now();
    backend.setItems([
      {
        id: 'seed-approved',
        userId: 'u_test',
        title: '已批准待派发',
        summary: '模拟 approve 与 dispatch 之间中断',
        priority: 'p1',
        tags: ['recover'],
        status: 'approved',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        audit: [{ id: 'a-approved', action: 'approved', actor: { kind: 'user', id: 'u_test' }, timestamp: now }],
        suggestion: {
          catId: 'codex' as CatId,
          why: '可恢复',
          plan: '手动重试',
          requestedPhase: 'coding',
          status: 'approved',
          suggestedAt: now - 1_000,
          decidedAt: now,
          decidedBy: 'u_test',
        },
        approvedAt: now,
      } satisfies MutableBacklogItem,
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const card = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('已批准待派发'),
    );
    expect(card).toBeTruthy();
    if (!card) return;

    await act(async () => {
      card.click();
    });

    const retryButton = container.querySelector('[data-testid="mc-approve-submit"]') as HTMLButtonElement | null;
    expect(retryButton).not.toBeNull();
    if (!retryButton) return;

    await act(async () => {
      retryButton.click();
    });
    await flush(act);

    expect(container.textContent).toContain('已批准待派发');
  });

  it('renders loading hint while backlog list is pending', async () => {
    let resolveList: ((value: Response) => void) | null = null;
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/backlog/items' && (!init?.method || init.method === 'GET')) {
        return new Promise<Response>((resolve) => {
          resolveList = resolve;
        });
      }
      return backend.handleRequest(path, init);
    });

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });

    expect(container.textContent).toContain('加载 backlog 中...');
    (resolveList as unknown as (value: Response) => void)(mockResponse(200, { items: [] }));
    await flush(act);
  });

  it('renders API error in alert banner', async () => {
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/backlog/items' && (!init?.method || init.method === 'GET')) {
        return Promise.resolve(mockResponse(500, { error: 'load failed' }));
      }
      return backend.handleRequest(path, init);
    });

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const banner = container.querySelector('[data-testid="mc-error"]');
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute('role')).toBe('alert');
    expect(banner?.textContent).toContain('load failed');
  });

  it('shows self-claim button when policy allows global self-claim', async () => {
    const now = Date.now();
    backend.setSelfClaimScope('codex' as CatId, 'global');
    backend.setItems([
      {
        id: 'seed-self-claim',
        userId: 'u_test',
        title: '可直接自领',
        summary: 'policy=global 时应展示自领按钮',
        priority: 'p1',
        tags: ['ratchet'],
        status: 'open',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        audit: [{ id: 'a-self-claim', action: 'created', actor: { kind: 'user', id: 'u_test' }, timestamp: now }],
      } satisfies MutableBacklogItem,
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const card = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('可直接自领'),
    );
    expect(card).toBeTruthy();
    if (!card) return;

    await act(async () => {
      card.click();
    });

    const selfClaimButton = container.querySelector('[data-testid="mc-self-claim-submit"]') as HTMLButtonElement | null;
    expect(selfClaimButton).not.toBeNull();
  });

  it('hides self-claim button when policy is disabled', async () => {
    const now = Date.now();
    backend.setSelfClaimScope('codex' as CatId, 'disabled');
    backend.setItems([
      {
        id: 'seed-self-claim-disabled',
        userId: 'u_test',
        title: '禁用自领',
        summary: 'policy=disabled 时不展示直通按钮',
        priority: 'p2',
        tags: ['ratchet'],
        status: 'open',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        audit: [
          { id: 'a-self-claim-disabled', action: 'created', actor: { kind: 'user', id: 'u_test' }, timestamp: now },
        ],
      } satisfies MutableBacklogItem,
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const card = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('禁用自领'),
    );
    expect(card).toBeTruthy();
    if (!card) return;

    await act(async () => {
      card.click();
    });

    const selfClaimButton = container.querySelector('[data-testid="mc-self-claim-submit"]') as HTMLButtonElement | null;
    expect(selfClaimButton).toBeNull();
  });

  it('shows once policy blocker reason when self-claim API rejects with once scope conflict', async () => {
    const now = Date.now();
    backend.setSelfClaimScope('codex' as CatId, 'once');
    backend.setItems([
      {
        id: 'seed-self-claim-once',
        userId: 'u_test',
        title: 'once 策略阻断',
        summary: '触发 once 阻断文案',
        priority: 'p1',
        tags: ['ratchet'],
        status: 'open',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        audit: [{ id: 'a-self-claim-once', action: 'created', actor: { kind: 'user', id: 'u_test' }, timestamp: now }],
      } satisfies MutableBacklogItem,
    ]);

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/backlog/items/seed-self-claim-once/self-claim' && init?.method === 'POST') {
        return Promise.resolve(mockResponse(403, { error: 'Self-claim once policy already consumed for this cat' }));
      }
      return backend.handleRequest(path, init);
    });

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const card = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('once 策略阻断'),
    );
    expect(card).toBeTruthy();
    if (!card) return;

    await act(async () => {
      card.click();
    });

    const whyInput = container.querySelector('[data-testid="mc-suggest-why"]') as HTMLTextAreaElement | null;
    const planInput = container.querySelector('[data-testid="mc-suggest-plan"]') as HTMLTextAreaElement | null;
    const selfClaimButton = container.querySelector('[data-testid="mc-self-claim-submit"]') as HTMLButtonElement | null;
    expect(whyInput).not.toBeNull();
    expect(planInput).not.toBeNull();
    expect(selfClaimButton).not.toBeNull();
    if (!whyInput || !planInput || !selfClaimButton) return;

    await act(async () => {
      setNativeValue(whyInput, '触发 once 阻断');
      whyInput.dispatchEvent(new Event('input', { bubbles: true }));
      setNativeValue(planInput, '验证阻断提示');
      planInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      selfClaimButton.click();
    });
    await flush(act);

    const blocker = container.querySelector('[data-testid="mc-self-claim-blocker-once"]');
    expect(blocker).not.toBeNull();
    expect(container.querySelector('[data-testid="mc-error"]')?.textContent).toContain('once 策略阻断');
  });

  it('shows thread policy blocker reason when self-claim API rejects with active lease conflict', async () => {
    const now = Date.now();
    backend.setSelfClaimScope('codex' as CatId, 'thread');
    backend.setItems([
      {
        id: 'seed-self-claim-thread',
        userId: 'u_test',
        title: 'thread 策略阻断',
        summary: '触发 thread 阻断文案',
        priority: 'p1',
        tags: ['ratchet'],
        status: 'open',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        audit: [
          { id: 'a-self-claim-thread', action: 'created', actor: { kind: 'user', id: 'u_test' }, timestamp: now },
        ],
      } satisfies MutableBacklogItem,
    ]);

    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/backlog/items/seed-self-claim-thread/self-claim' && init?.method === 'POST') {
        return Promise.resolve(
          mockResponse(409, { error: 'Self-claim thread policy blocked by existing active leased thread' }),
        );
      }
      return backend.handleRequest(path, init);
    });

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const card = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('thread 策略阻断'),
    );
    expect(card).toBeTruthy();
    if (!card) return;

    await act(async () => {
      card.click();
    });

    const whyInput = container.querySelector('[data-testid="mc-suggest-why"]') as HTMLTextAreaElement | null;
    const planInput = container.querySelector('[data-testid="mc-suggest-plan"]') as HTMLTextAreaElement | null;
    const selfClaimButton = container.querySelector('[data-testid="mc-self-claim-submit"]') as HTMLButtonElement | null;
    expect(whyInput).not.toBeNull();
    expect(planInput).not.toBeNull();
    expect(selfClaimButton).not.toBeNull();
    if (!whyInput || !planInput || !selfClaimButton) return;

    await act(async () => {
      setNativeValue(whyInput, '触发 thread 阻断');
      whyInput.dispatchEvent(new Event('input', { bubbles: true }));
      setNativeValue(planInput, '验证活跃 lease 冲突提示');
      planInput.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      selfClaimButton.click();
    });
    await flush(act);

    const blocker = container.querySelector('[data-testid="mc-self-claim-blocker-thread"]');
    expect(blocker).not.toBeNull();
    expect(container.querySelector('[data-testid="mc-error"]')?.textContent).toContain('thread 策略阻断');
  });

  it('shows lease controls and sends heartbeat for active lease', async () => {
    const now = Date.now();
    backend.setItems([
      {
        id: 'seed-lease-ui',
        userId: 'u_test',
        title: '租约任务',
        summary: '已派发且 lease 激活',
        priority: 'p1',
        tags: ['lease'],
        status: 'dispatched',
        createdBy: 'user',
        createdAt: now - 3_000,
        updatedAt: now,
        dispatchedAt: now - 2_000,
        dispatchedThreadId: 'thread-lease-ui',
        dispatchedThreadPhase: 'coding',
        lease: {
          ownerCatId: 'codex' as CatId,
          state: 'active',
          acquiredAt: now - 2_000,
          heartbeatAt: now - 1_000,
          expiresAt: now + 30_000,
        },
        audit: [{ id: 'a-lease-ui', action: 'dispatched', actor: { kind: 'user', id: 'u_test' }, timestamp: now }],
      } satisfies MutableBacklogItem,
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const card = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('租约任务'),
    );
    expect(card).toBeTruthy();
    if (!card) return;

    await act(async () => {
      card.click();
    });

    const heartbeatButton = container.querySelector('[data-testid="mc-lease-heartbeat"]') as HTMLButtonElement | null;
    expect(heartbeatButton).not.toBeNull();
    if (!heartbeatButton) return;

    await act(async () => {
      heartbeatButton.click();
    });
    await flush(act);

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/backlog/items/seed-lease-ui/lease/heartbeat',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('hides heartbeat and shows reclaim for expired active lease', async () => {
    const now = Date.now();
    backend.setItems([
      {
        id: 'seed-lease-expired',
        userId: 'u_test',
        title: '过期租约任务',
        summary: 'active 但 expiresAt 已过期',
        priority: 'p1',
        tags: ['lease'],
        status: 'dispatched',
        createdBy: 'user',
        createdAt: now - 6_000,
        updatedAt: now - 1_000,
        dispatchedAt: now - 5_000,
        dispatchedThreadId: 'thread-lease-expired',
        dispatchedThreadPhase: 'coding',
        lease: {
          ownerCatId: 'codex' as CatId,
          state: 'active',
          acquiredAt: now - 5_000,
          heartbeatAt: now - 4_000,
          expiresAt: now - 500,
        },
        audit: [
          {
            id: 'a-lease-expired',
            action: 'dispatched',
            actor: { kind: 'user', id: 'u_test' },
            timestamp: now - 5_000,
          },
        ],
      } satisfies MutableBacklogItem,
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const card = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('过期租约任务'),
    );
    expect(card).toBeTruthy();
    if (!card) return;

    await act(async () => {
      card.click();
    });

    const heartbeatButton = container.querySelector('[data-testid="mc-lease-heartbeat"]') as HTMLButtonElement | null;
    const reclaimButton = container.querySelector('[data-testid="mc-lease-reclaim"]') as HTMLButtonElement | null;
    expect(heartbeatButton).toBeNull();
    expect(reclaimButton).not.toBeNull();
    if (!reclaimButton) return;

    await act(async () => {
      reclaimButton.click();
    });
    await flush(act);

    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/backlog/items/seed-lease-expired/lease/reclaim',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('switches heartbeat to reclaim after lease expiry without extra interaction', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    backend.setItems([
      {
        id: 'seed-lease-ticking',
        userId: 'u_test',
        title: '租约自动过期任务',
        summary: '打开后等待过期，应自动从 heartbeat 切到 reclaim',
        priority: 'p1',
        tags: ['lease'],
        status: 'dispatched',
        createdBy: 'user',
        createdAt: now - 4_000,
        updatedAt: now - 2_000,
        dispatchedAt: now - 3_000,
        dispatchedThreadId: 'thread-lease-ticking',
        dispatchedThreadPhase: 'coding',
        lease: {
          ownerCatId: 'codex' as CatId,
          state: 'active',
          acquiredAt: now - 3_000,
          heartbeatAt: now - 2_000,
          expiresAt: now + 1_000,
        },
        audit: [
          {
            id: 'a-lease-ticking',
            action: 'dispatched',
            actor: { kind: 'user', id: 'u_test' },
            timestamp: now - 3_000,
          },
        ],
      } satisfies MutableBacklogItem,
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await act(async () => {
      await Promise.resolve();
    });

    const card = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('租约自动过期任务'),
    );
    expect(card).toBeTruthy();
    if (!card) return;

    await act(async () => {
      card.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="mc-lease-heartbeat"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mc-lease-reclaim"]')).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(1_100);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="mc-lease-heartbeat"]')).toBeNull();
    expect(container.querySelector('[data-testid="mc-lease-reclaim"]')).not.toBeNull();
  });
});

describe('MissionControlPage — Done lane + dependencies', () => {
  let container: HTMLDivElement;
  let root: Root;
  let backend: MissionControlMockBackend;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    backend = createMissionControlMockBackend();
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => backend.handleRequest(path, init));
    useMissionControlStore.setState({
      items: [],
      loading: false,
      submitting: false,
      selectedItemId: null,
      selectedPhase: 'coding',
      error: null,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('renders Done section when done items exist', async () => {
    backend.setItems([
      {
        id: 'done1',
        userId: 'default-user',
        title: 'Done task',
        summary: 'S',
        priority: 'p2',
        tags: [],
        status: 'done',
        createdBy: 'user',
        createdAt: 1000,
        updatedAt: 2000,
        doneAt: 2000,
        audit: [],
      },
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const doneSection = container.querySelector('[data-testid="mc-feature-done-section"]');
    expect(doneSection).not.toBeNull();
    expect(doneSection?.textContent).toContain('已完成');
  });

  it('Done section is collapsed by default', async () => {
    backend.setItems([
      {
        id: 'done1',
        userId: 'default-user',
        title: 'Done task',
        summary: 'S',
        priority: 'p2',
        tags: [],
        status: 'done',
        createdBy: 'user',
        createdAt: 1000,
        updatedAt: 2000,
        doneAt: 2000,
        audit: [],
      },
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const doneSection = container.querySelector('[data-testid="mc-feature-done-section"]');
    expect(doneSection).not.toBeNull();
    // Feature details should not be visible when collapsed
    expect(doneSection?.textContent).not.toContain('Done task');
  });

  it('renders dependency labels when feature row is expanded', async () => {
    backend.setItems([
      {
        id: 'dep1',
        userId: 'default-user',
        title: 'Dep item',
        summary: 'S',
        priority: 'p2',
        tags: [],
        status: 'open',
        createdBy: 'user',
        createdAt: 1000,
        updatedAt: 2000,
        audit: [],
        dependencies: { evolvedFrom: ['f049'], related: ['f037'] },
      },
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    // Click the feature row to expand it and reveal dependency labels
    const featureRow = container.querySelector('[data-testid="mc-feature-row-Untagged"]');
    expect(featureRow).not.toBeNull();
    const expandButton = featureRow?.querySelector('button');
    expect(expandButton).not.toBeNull();
    await act(async () => {
      expandButton?.click();
    });

    expect(container.textContent).toContain('← F049');
    expect(container.textContent).toContain('↔ F037');
  });
});

describe('MissionControlPage — Tabs + Status bar + Dep graph', () => {
  let container: HTMLDivElement;
  let root: Root;
  let backend: MissionControlMockBackend;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    backend = createMissionControlMockBackend();
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => backend.handleRequest(path, init));
    useMissionControlStore.setState({
      items: [],
      loading: false,
      submitting: false,
      selectedItemId: null,
      selectedPhase: 'coding',
      error: null,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('renders tab buttons for 功能列表 and 依赖全景', async () => {
    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const featuresTab = container.querySelector('[data-testid="mc-tab-features"]');
    const depsTab = container.querySelector('[data-testid="mc-tab-dependencies"]');
    expect(featuresTab).not.toBeNull();
    expect(depsTab).not.toBeNull();
    expect(featuresTab?.textContent).toContain('功能列表');
    expect(depsTab?.textContent).toContain('依赖全景');
  });

  it('shows feature row list by default, dep graph after tab switch', async () => {
    const now = Date.now();
    backend.setItems([
      {
        id: 'tab-1',
        userId: 'default-user',
        title: '[F070] Tab test',
        summary: 'S',
        priority: 'p1',
        tags: ['feature:f070'],
        status: 'open',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        audit: [],
        dependencies: { evolvedFrom: ['F069'] },
      },
      {
        id: 'tab-2',
        userId: 'default-user',
        title: '[F069] Dep target',
        summary: 'S',
        priority: 'p1',
        tags: ['feature:f069'],
        status: 'done',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        audit: [],
      },
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    // Feature row list visible by default
    expect(container.querySelector('[data-testid="mc-feature-row-list"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mc-dep-graph"]')).toBeNull();

    // Switch to dep graph tab
    const depsTab = container.querySelector('[data-testid="mc-tab-dependencies"]') as HTMLButtonElement;
    await act(async () => {
      depsTab.click();
    });

    expect(container.querySelector('[data-testid="mc-feature-row-list"]')).toBeNull();
    expect(container.querySelector('[data-testid="mc-dep-graph"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mc-dep-node-F070"]')).not.toBeNull();
  });

  it('renders status summary bar with correct counts', async () => {
    const now = Date.now();
    backend.setItems([
      {
        id: 's1',
        userId: 'u',
        title: 'Suggested',
        summary: 'S',
        priority: 'p1',
        tags: [],
        status: 'suggested',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        audit: [],
        suggestion: {
          catId: 'codex' as CatId,
          why: 'w',
          plan: 'p',
          requestedPhase: 'coding',
          status: 'pending',
          suggestedAt: now,
        },
      },
      {
        id: 's2',
        userId: 'u',
        title: 'Dispatched',
        summary: 'S',
        priority: 'p1',
        tags: [],
        status: 'dispatched',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        dispatchedAt: now,
        dispatchedThreadId: 't1',
        dispatchedThreadPhase: 'coding',
        audit: [],
      },
      {
        id: 's3',
        userId: 'u',
        title: 'Done1',
        summary: 'S',
        priority: 'p2',
        tags: [],
        status: 'done',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        doneAt: now,
        audit: [],
      },
      {
        id: 's4',
        userId: 'u',
        title: 'Done2',
        summary: 'S',
        priority: 'p2',
        tags: [],
        status: 'done',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        doneAt: now,
        audit: [],
      },
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    expect(container.textContent).toContain('1 待审批');
    expect(container.textContent).toContain('1 执行中');
    expect(container.textContent).toContain('2 已完成');
  });

  it('dep graph shows empty state when no features exist', async () => {
    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    // Switch to dep graph
    const depsTab = container.querySelector('[data-testid="mc-tab-dependencies"]') as HTMLButtonElement;
    await act(async () => {
      depsTab.click();
    });

    expect(container.querySelector('[data-testid="mc-dep-graph-empty"]')).not.toBeNull();
    expect(container.textContent).toContain('暂无 Feature 依赖数据');
  });

  it('shows related edge even when only one side declares it (single-side dedup)', async () => {
    const now = Date.now();
    // F070 declares related: [F069], but F069 does NOT declare related: [F070]
    // Edge should still appear (P1-2 fix)
    backend.setItems([
      {
        id: 'rel-1',
        userId: 'u',
        title: '[F070] Feature A',
        summary: 'S',
        priority: 'p1',
        tags: ['feature:f070'],
        status: 'open',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        audit: [],
        dependencies: { related: ['F069'] },
      },
      {
        id: 'rel-2',
        userId: 'u',
        title: '[F069] Feature B',
        summary: 'S',
        priority: 'p1',
        tags: ['feature:f069'],
        status: 'dispatched',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        audit: [],
      },
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const depsTab = container.querySelector('[data-testid="mc-tab-dependencies"]') as HTMLButtonElement;
    await act(async () => {
      depsTab.click();
    });

    // Both nodes should be present — proves single-side related declaration doesn't prevent rendering
    expect(container.querySelector('[data-testid="mc-dep-node-F070"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mc-dep-node-F069"]')).not.toBeNull();
    // Click F070 to see its detail panel — should show the related dependency
    const node = container.querySelector('[data-testid="mc-dep-node-F070"]') as HTMLElement;
    await act(async () => {
      node.click();
    });
    const detail = container.querySelector('[data-testid="mc-dep-node-detail"]');
    expect(detail).not.toBeNull();
    expect(detail?.textContent).toContain('F069');
  });

  it('shows node detail panel when a node is clicked (AC-J5)', async () => {
    const now = Date.now();
    backend.setItems([
      {
        id: 'click-1',
        userId: 'u',
        title: '[F070] Clickable Feature',
        summary: 'S',
        priority: 'p1',
        tags: ['feature:f070'],
        status: 'dispatched',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        audit: [],
        dependencies: { evolvedFrom: ['F049'] },
      },
      {
        id: 'click-2',
        userId: 'u',
        title: '[F049] Dep Target',
        summary: 'S',
        priority: 'p1',
        tags: ['feature:f049'],
        status: 'done',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        audit: [],
      },
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const depsTab = container.querySelector('[data-testid="mc-tab-dependencies"]') as HTMLButtonElement;
    await act(async () => {
      depsTab.click();
    });

    // Detail panel should not be visible initially
    expect(container.querySelector('[data-testid="mc-dep-node-detail"]')).toBeNull();

    // Click the node
    const node = container.querySelector('[data-testid="mc-dep-node-F070"]') as HTMLElement;
    expect(node).not.toBeNull();
    await act(async () => {
      node.click();
    });

    // Detail panel should appear with feature info
    const detail = container.querySelector('[data-testid="mc-dep-node-detail"]');
    expect(detail).not.toBeNull();
    expect(detail?.textContent).toContain('F070');
    expect(detail?.textContent).toContain('Clickable Feature');
    expect(detail?.textContent).toContain('F049');
  });

  it('closes node detail panel when selected feature disappears from data', async () => {
    const now = Date.now();
    backend.setItems([
      {
        id: 'vanish-1',
        userId: 'u',
        title: '[F070] Will Vanish',
        summary: 'S',
        priority: 'p1',
        tags: ['feature:f070'],
        status: 'open',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        audit: [],
        dependencies: { evolvedFrom: ['F069'] },
      },
      {
        id: 'vanish-2',
        userId: 'u',
        title: '[F069] Stays',
        summary: 'S',
        priority: 'p1',
        tags: ['feature:f069'],
        status: 'dispatched',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        audit: [],
      },
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const depsTab = container.querySelector('[data-testid="mc-tab-dependencies"]') as HTMLButtonElement;
    await act(async () => {
      depsTab.click();
    });

    // Click F070 to open detail
    const node = container.querySelector('[data-testid="mc-dep-node-F070"]') as HTMLElement;
    await act(async () => {
      node.click();
    });
    expect(container.querySelector('[data-testid="mc-dep-node-detail"]')?.textContent).toContain('F070');

    // Close detail by clicking close button
    const closeBtn = container.querySelector('[data-testid="mc-dep-node-detail"] button') as HTMLElement;
    await act(async () => {
      closeBtn.click();
    });
    expect(container.querySelector('[data-testid="mc-dep-node-detail"]')).toBeNull();
  });

  it('defaults to connected scope, hides isolated nodes, shows stats', async () => {
    const now = Date.now();
    backend.setItems([
      {
        id: 'scope-1',
        userId: 'u',
        title: '[F070] Connected A',
        summary: 'S',
        priority: 'p1',
        tags: ['feature:f070'],
        status: 'dispatched',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        audit: [],
        dependencies: { evolvedFrom: ['F069'] },
      },
      {
        id: 'scope-2',
        userId: 'u',
        title: '[F069] Connected B',
        summary: 'S',
        priority: 'p1',
        tags: ['feature:f069'],
        status: 'done',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        audit: [],
      },
      {
        id: 'scope-3',
        userId: 'u',
        title: '[F001] Isolated',
        summary: 'S',
        priority: 'p3',
        tags: ['feature:f001'],
        status: 'open',
        createdBy: 'user',
        createdAt: now,
        updatedAt: now,
        audit: [],
      },
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const depsTab = container.querySelector('[data-testid="mc-tab-dependencies"]') as HTMLButtonElement;
    await act(async () => {
      depsTab.click();
    });

    // Default scope = connected: F070 + F069 visible, F001 hidden
    expect(container.querySelector('[data-testid="mc-dep-node-F070"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mc-dep-node-F069"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mc-dep-node-F001"]')).toBeNull();

    // Stats bar shows count
    const stats = container.querySelector('[data-testid="mc-dep-stats"]');
    expect(stats?.textContent).toContain('2 个 Feature');

    // Switch to "all" scope — isolated node appears
    const allBtn = container.querySelector('[data-testid="mc-dep-scope-all"]') as HTMLButtonElement;
    await act(async () => {
      allBtn.click();
    });
    expect(container.querySelector('[data-testid="mc-dep-node-F001"]')).not.toBeNull();
  });

  it('referrer-based back button links to referrer thread when ?from= present', async () => {
    // Set up window.location.search with ?from=thread-abc
    const originalSearch = window.location.search;
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, search: '?from=thread-abc' },
    });

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const backLink = container.querySelector('[data-testid="mc-back-to-chat"]') as HTMLAnchorElement;
    expect(backLink).not.toBeNull();
    expect(backLink.getAttribute('href')).toBe('/thread/thread-abc');

    // Restore
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, search: originalSearch },
    });
  });

  it('back button falls back to store currentThreadId when no ?from= param', async () => {
    // No ?from= in URL — simulate navigating to /mission-hub directly
    const originalSearch = window.location.search;
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, search: '' },
    });

    // Set the store's currentThreadId before render (inside act to avoid warning)
    await act(async () => {
      useChatStore.setState({ currentThreadId: 'thread-xyz' });
    });

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const backLink = container.querySelector('[data-testid="mc-back-to-chat"]') as HTMLAnchorElement;
    expect(backLink).not.toBeNull();
    expect(backLink.getAttribute('href')).toBe('/thread/thread-xyz');

    // Restore
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, search: originalSearch },
    });
    await act(async () => {
      useChatStore.setState({ currentThreadId: 'default' });
    });
  });

  it('back button goes to / when store has default thread and no ?from= param', async () => {
    const originalSearch = window.location.search;
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, search: '' },
    });

    await act(async () => {
      useChatStore.setState({ currentThreadId: 'default' });
    });

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const backLink = container.querySelector('[data-testid="mc-back-to-chat"]') as HTMLAnchorElement;
    expect(backLink).not.toBeNull();
    expect(backLink.getAttribute('href')).toBe('/');

    Object.defineProperty(window, 'location', {
      writable: true,
      value: { ...window.location, search: originalSearch },
    });
  });

  it('thread-situation falls back to title-matched threads when no backlogItemId link', async () => {
    const now = Date.now();
    backend.setItems([
      {
        id: 'seed-title-match',
        userId: 'u_test',
        title: '[F099] Title Match Test',
        summary: 'dispatched item without backlogItemId on thread',
        priority: 'p1',
        tags: ['feature:f099'],
        status: 'dispatched',
        createdBy: 'user',
        createdAt: now - 10_000,
        updatedAt: now - 1_000,
        dispatchedAt: now - 5_000,
        dispatchedThreadId: 'thread-unlinked',
        dispatchedThreadPhase: 'coding',
        audit: [{ id: 'a-tm', action: 'dispatched', actor: { kind: 'user', id: 'u_test' }, timestamp: now - 5_000 }],
      } satisfies MutableBacklogItem,
    ]);
    // Thread has F099 in title but NO backlogItemId → should match via title
    backend.setThreads([
      {
        id: 'thread-title-f099',
        title: '[F099] some related thread',
        createdBy: 'u_test',
        lastActiveAt: now - 200,
        participants: ['codex' as CatId],
        // no backlogItemId!
      },
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    // Switch to threads tab
    const threadsTab = container.querySelector('[data-testid="mc-right-tab-threads"]') as HTMLButtonElement;
    if (threadsTab) {
      await act(async () => {
        threadsTab.click();
      });
      await flush(act);
    }

    const panel = container.querySelector('[data-testid="mc-thread-situation"]');
    expect(panel).not.toBeNull();
    // Should show the title-matched thread instead of "暂无关联 thread"
    expect(panel?.textContent).toContain('[F099] some related thread');
    expect(panel?.textContent).toContain('通过标题匹配');
    expect(panel?.textContent).not.toContain('暂无关联 thread');
  });

  it('thread-situation prefers direct backlogItemId over title match', async () => {
    const now = Date.now();
    backend.setItems([
      {
        id: 'seed-direct-pref',
        userId: 'u_test',
        title: '[F088] Direct Preference Test',
        summary: 'has both direct link and title match',
        priority: 'p1',
        tags: ['feature:f088'],
        status: 'dispatched',
        createdBy: 'user',
        createdAt: now - 10_000,
        updatedAt: now - 1_000,
        dispatchedAt: now - 5_000,
        dispatchedThreadId: 'thread-direct',
        dispatchedThreadPhase: 'coding',
        audit: [{ id: 'a-dp', action: 'dispatched', actor: { kind: 'user', id: 'u_test' }, timestamp: now - 5_000 }],
      } satisfies MutableBacklogItem,
    ]);
    backend.setThreads([
      {
        id: 'thread-direct',
        title: 'Direct Linked Thread',
        createdBy: 'u_test',
        lastActiveAt: now - 100,
        participants: ['codex' as CatId],
        backlogItemId: 'seed-direct-pref', // direct link
      },
      {
        id: 'thread-title-f088',
        title: '[F088] title match thread',
        createdBy: 'u_test',
        lastActiveAt: now - 300,
        participants: ['codex' as CatId],
        // no backlogItemId — would match by title
      },
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    // Switch to threads tab
    const threadsTab = container.querySelector('[data-testid="mc-right-tab-threads"]') as HTMLButtonElement;
    if (threadsTab) {
      await act(async () => {
        threadsTab.click();
      });
      await flush(act);
    }

    const panel = container.querySelector('[data-testid="mc-thread-situation"]');
    expect(panel).not.toBeNull();
    // Direct link should show, title match should NOT show
    expect(panel?.textContent).toContain('Direct Linked Thread');
    expect(panel?.textContent).not.toContain('通过标题匹配');
    expect(panel?.textContent).not.toContain('[F088] title match thread');
  });
});

describe('Feature progress panel', () => {
  let container: HTMLDivElement;
  let root: Root;
  let backend: MissionControlMockBackend;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    backend = createMissionControlMockBackend();
    mockApiFetch.mockImplementation((path: string, init?: RequestInit) => backend.handleRequest(path, init));
    // Wire native fetch to the mock backend so useFeatureDocDetail (which uses fetch) is intercepted
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const path =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.pathname + input.search
            : (input as Request).url;
      return backend.handleRequest(path, init);
    });
    useMissionControlStore.setState({
      items: [],
      loading: false,
      submitting: false,
      selectedItemId: null,
      selectedPhase: 'coding',
      error: null,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('shows phase progress bars when feature row is expanded', async () => {
    const now = Date.now();
    backend.setItems([
      {
        id: 'fp-item-1',
        userId: 'u_test',
        title: '[F058] Phase Progress Test',
        summary: 'dispatched item with feature tag',
        priority: 'p1',
        tags: ['feature:f058'],
        status: 'dispatched',
        createdBy: 'user',
        createdAt: now - 5_000,
        updatedAt: now - 1_000,
        dispatchedAt: now - 4_000,
        dispatchedThreadId: 'thread-fp-1',
        dispatchedThreadPhase: 'coding',
        audit: [{ id: 'a-fp-1', action: 'dispatched', actor: { kind: 'user', id: 'u_test' }, timestamp: now - 4_000 }],
      } satisfies MutableBacklogItem,
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const featureRow = container.querySelector('[data-testid="mc-feature-row-F058"]');
    expect(featureRow).not.toBeNull();
    if (!featureRow) return;

    const toggleButton = featureRow.querySelector('button');
    expect(toggleButton).not.toBeNull();
    if (!toggleButton) return;

    await act(async () => {
      toggleButton.click();
    });
    await flush(act);
    await flush(act);

    const progressPanel = container.querySelector('[data-testid="mc-progress-panel"]');
    expect(progressPanel).not.toBeNull();

    const phaseA = container.querySelector('[data-testid="mc-phase-A"]');
    expect(phaseA).not.toBeNull();

    const phaseB = container.querySelector('[data-testid="mc-phase-B"]');
    expect(phaseB).not.toBeNull();
  });

  it('shows AC checklist when phase is expanded', async () => {
    const now = Date.now();
    backend.setItems([
      {
        id: 'fp-item-2',
        userId: 'u_test',
        title: '[F058] Phase Progress AC Test',
        summary: 'dispatched item for AC drilldown',
        priority: 'p1',
        tags: ['feature:f058'],
        status: 'dispatched',
        createdBy: 'user',
        createdAt: now - 5_000,
        updatedAt: now - 1_000,
        dispatchedAt: now - 4_000,
        dispatchedThreadId: 'thread-fp-2',
        dispatchedThreadPhase: 'coding',
        audit: [{ id: 'a-fp-2', action: 'dispatched', actor: { kind: 'user', id: 'u_test' }, timestamp: now - 4_000 }],
      } satisfies MutableBacklogItem,
    ]);

    await act(async () => {
      root.render(React.createElement(MissionControlPage));
    });
    await flush(act);

    const featureRow = container.querySelector('[data-testid="mc-feature-row-F058"]');
    expect(featureRow).not.toBeNull();
    if (!featureRow) return;

    const toggleButton = featureRow.querySelector('button');
    expect(toggleButton).not.toBeNull();
    if (!toggleButton) return;

    await act(async () => {
      toggleButton.click();
    });
    await flush(act);
    await flush(act);

    const progressPanel = container.querySelector('[data-testid="mc-progress-panel"]');
    expect(progressPanel).not.toBeNull();
    if (!progressPanel) return;

    const phaseToggleB = container.querySelector('[data-testid="mc-phase-toggle-B"]') as HTMLButtonElement | null;
    expect(phaseToggleB).not.toBeNull();
    if (!phaseToggleB) return;

    await act(async () => {
      phaseToggleB.click();
    });

    const phaseAcsB = container.querySelector('[data-testid="mc-phase-acs-B"]');
    expect(phaseAcsB).not.toBeNull();
    expect(phaseAcsB?.textContent).toContain('Progress dashboard');
  });
});
