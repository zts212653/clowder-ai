import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecentThreadsPage } from '@/components/recent/RecentThreadsPage';

const push = vi.fn();
const refetch = vi.fn();
const loadMore = vi.fn();

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: (catId: string) => ({ id: catId, name: '宪宪' }) }),
  formatCatName: (cat: { name: string }) => cat.name,
}));
vi.mock('@/hooks/useRecentThreadBriefs', () => ({
  useRecentThreadBriefs: () => ({
    current: [
      brief('thread-needs', '会话进度视图', 'needs_user'),
      brief('thread-running', 'Runtime Harness 深入学习', 'running'),
      brief('thread-unknown', 'Agent eval 方法论', 'unknown'),
      brief('thread-wait', 'Pi session 接续机制', 'waiting_external'),
    ],
    recent: [brief('thread-recent', 'Codex 开源范围调研', 'idle')],
    nextCursor: 'cursor-1',
    loading: false,
    loadingMore: false,
    error: false,
    refetch,
    loadMore,
  }),
}));

describe('RecentThreadsPage', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    push.mockClear();
    refetch.mockClear();
    loadMore.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('renders all current partitions and recent progress in human language', async () => {
    await act(async () => root.render(<RecentThreadsPage />));

    for (const label of ['需要你', '正在推进', '状态确认中', '等待外部', '最近有进展']) {
      expect(container.textContent).toContain(label);
    }
    expect(container.textContent).toContain('Runtime Harness 深入学习');
    expect(container.textContent).toContain('宪宪正在推进');
    expect(container.textContent).toContain('完成一个关键阶段');
    expect(container.textContent).not.toContain('thread-running');
  });

  it('enters a thread and loads older recent pages', async () => {
    await act(async () => root.render(<RecentThreadsPage />));
    const enterButtons = [...container.querySelectorAll('button')].filter((button) =>
      button.textContent?.includes('进入会话'),
    );
    await act(async () => enterButtons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(push).toHaveBeenCalledWith('/thread/thread-running');

    const more = [...container.querySelectorAll('button')].find((button) => button.textContent === '加载更早近况');
    await act(async () => more?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(loadMore).toHaveBeenCalledOnce();
  });
});

function brief(
  threadId: string,
  title: string,
  state: 'needs_user' | 'running' | 'waiting_external' | 'idle' | 'unknown',
) {
  return {
    v: 1 as const,
    thread: { id: threadId, title },
    contextHeading: { label: '会话' as const, text: title },
    availability: 'ok' as const,
    presentationState: state,
    currentExecutions:
      state === 'running' || state === 'unknown'
        ? [
            {
              catId: 'cat-vjdun65e',
              startedAt: Date.now(),
              confidence: state === 'running' ? ('confirmed' as const) : ('degraded' as const),
            },
          ]
        : [],
    attention: state === 'needs_user' ? [{ kind: 'approval' as const, label: '请确认范围', createdAt: 1 }] : [],
    waits:
      state === 'waiting_external' ? [{ kind: 'external' as const, label: '等待 runtime 样本', createdAt: 1 }] : [],
    recentProgress: [
      {
        id: `receipt-${threadId}`,
        kind: 'milestone' as const,
        headline: '完成一个关键阶段',
        actor: { kind: 'cat' as const, catId: 'cat-vjdun65e' },
        occurredAt: Date.now(),
      },
    ],
    lastProgressAt: Date.now(),
    nextStep: '继续验证',
    openWorkTaskCount: 0,
    hasHistory: true,
    generatedAt: Date.now(),
  };
}
