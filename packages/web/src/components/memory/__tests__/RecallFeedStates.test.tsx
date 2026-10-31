import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecallEvent } from '@/hooks/recall-types';
import type { ChatMessage } from '@/stores/chat-types';
import { RecallFeed } from '../RecallFeed';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const read = vi.hoisted(() => ({
  events: [] as RecallEvent[],
  historyCount: 0,
  hasOlderReplies: false,
  messages: [] as ChatMessage[],
  threadId: 't',
  historyStatus: 'ready',
  cuesFailed: false,
  cuesLoading: false,
  retainedHistory: false,
  retry: vi.fn(),
}));
vi.mock('@/hooks/useRecallEvents', () => ({ useThreadRecall: () => read }));
vi.mock('@/hooks/useCatData', () => ({ useCatData: () => ({ getCatById: () => undefined }) }));
describe('F321 loading/empty/partial/error surfaces', () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    Object.assign(read, {
      events: [],
      historyCount: 0,
      hasOlderReplies: false,
      historyStatus: 'ready',
      cuesFailed: false,
      cuesLoading: false,
      retainedHistory: false,
      messages: [],
    });
    read.retry.mockClear();
    window.history.replaceState({}, '', '/');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  it.each([
    ['loading', '正在读取'],
    ['ready', '还没有召回记录'],
    ['error', '记忆记录读取失败'],
  ] as const)('shows %s honestly', async (status, label) => {
    read.historyStatus = status;
    await act(async () => root.render(<RecallFeed />));
    expect(container.textContent).toContain(label);
  });
  it('preserves live rows in partial state and retries the failed read', async () => {
    read.historyStatus = 'error';
    read.events = [{ id: 'e', query: 'sentinel', timestamp: 1 }];
    await act(async () => root.render(<RecallFeed />));
    expect(container.textContent).toContain('只读到实时记录');
    expect(container.textContent).toContain('sentinel');
    await act(async () =>
      [...container.querySelectorAll('button')].find((button) => button.textContent === '重试')?.click(),
    );
    expect(read.retry).toHaveBeenCalledOnce();
    expect(container.textContent).not.toMatch(/忽略|ign\./);
  });
  it('does not report empty while the delivery producer is unavailable', async () => {
    read.cuesFailed = true;
    await act(async () => root.render(<RecallFeed />));
    expect(container.textContent).toContain('点名递送记录暂时无法读取');
    expect(container.textContent).not.toContain('还没有召回记录');
  });
  it('only labels a capped history and keeps the delivery number and unit together', async () => {
    read.events = [{ id: 'summary', query: 'F322', timestamp: 1 }];
    await act(async () => root.render(<RecallFeed />));
    expect(container.textContent).not.toContain('已读到：');
    expect(container.textContent).not.toContain('最近 100 次召回里：');
    read.historyCount = 100;
    await act(async () => root.render(<RecallFeed />));
    expect(container.textContent).toContain('最近 100 次召回里：');
    const delivery = [...container.querySelectorAll('span')].find((node) => node.textContent === '系统递送 0 条');
    expect(delivery?.classList.contains('whitespace-nowrap')).toBe(true);
  });
  it('distinguishes pending older coordinates from records without a reply binding', async () => {
    read.hasOlderReplies = true;
    read.events = [{ id: 'older', query: 'F322', timestamp: 1, catId: 'sonnet', invocationId: 'old-turn' }];
    await act(async () => root.render(<RecallFeed />));
    expect(container.textContent).toContain('较早的回复');
    read.events = [{ id: 'unbound', query: 'F322', timestamp: 1 }];
    await act(async () => root.render(<RecallFeed />));
    expect(container.textContent).toContain('没有记录是哪一次回复');
  });

  it('opens the exact requested turn, collapses the other groups, and marks the target', async () => {
    window.history.replaceState({}, '', '/?recallThread=t&recallInv=turn-two&recallCat=sonnet');
    read.messages = [
      {
        id: 'reply-one',
        type: 'assistant',
        catId: 'sonnet',
        content: 'one',
        timestamp: 1,
        extra: { stream: { turnInvocationId: 'turn-one' } },
      },
      {
        id: 'reply-two',
        type: 'assistant',
        catId: 'sonnet',
        content: 'two',
        timestamp: 2,
        extra: { stream: { turnInvocationId: 'turn-two' } },
      },
    ];
    read.events = [
      { id: 'one', query: 'one', timestamp: 1, catId: 'sonnet', invocationId: 'turn-one' },
      { id: 'two', query: 'two', timestamp: 2, catId: 'sonnet', invocationId: 'turn-two' },
    ];

    await act(async () => root.render(<RecallFeed />));

    const target = container.querySelector('[data-recall-target="true"]');
    expect(target?.getAttribute('data-recall-group')).toContain('turn-two');
    expect(target?.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
    const other = [...container.querySelectorAll('[data-recall-group]')].find((group) => group !== target);
    expect(other?.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
  });

  it('says the requested turn was not found instead of silently opening the newest group', async () => {
    window.history.replaceState({}, '', '/?recallThread=t&recallInv=missing&recallCat=sonnet');
    read.events = [{ id: 'one', query: 'one', timestamp: 1, catId: 'sonnet', invocationId: 'turn-one' }];
    read.messages = [];

    await act(async () => root.render(<RecallFeed />));

    expect(container.querySelector('[data-testid="recall-target-missing"]')?.textContent).toContain(
      '没找到这一轮的召回记录',
    );
    expect(container.querySelector('[data-recall-target="true"]')).toBeNull();
  });

  it('reveals an exact search turn after the mounted feed was filtered to system delivery', async () => {
    read.events = [
      {
        id: 'only-search',
        query: 'known-search',
        timestamp: 1,
        catId: 'sonnet',
        invocationId: 'search-turn',
        toolName: 'search_evidence',
      },
    ];
    await act(async () => root.render(<RecallFeed />));
    await act(async () =>
      [...container.querySelectorAll('button')].find((button) => button.textContent === '系统递送')?.click(),
    );

    await act(async () =>
      window.dispatchEvent(
        new CustomEvent('cat-cafe:open-reply-recall', {
          detail: { threadId: 't', invocationId: 'search-turn', catId: 'sonnet' },
        }),
      ),
    );

    expect(container.querySelector('[data-recall-target="true"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="recall-target-missing"]')).toBeNull();
    expect(container.textContent).toContain('known-search');
  });
});
