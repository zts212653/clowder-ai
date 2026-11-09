import type { SuggestionView } from '@cat-cafe/shared';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis as Record<string, unknown>, { React });

const openWork = vi.fn();
const setWorkspaceMode = vi.fn();
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: (catId: string) => ({ avatar: `/avatars/${catId}.png` }) }),
}));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://example.test', apiFetch: vi.fn() }));
vi.mock('@/components/artifacts/useWorkCardOpen', () => ({ useWorkCardOpen: () => ({ open: openWork }) }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: { setWorkspaceMode: typeof setWorkspaceMode }) => unknown) =>
    selector({ setWorkspaceMode }),
}));
vi.mock('@/components/AppTooltip', () => ({
  AppTooltip: ({ children }: { children: React.ReactElement }) => children,
}));

import { apiFetch } from '@/utils/api-client';
import { HiddenSuggestionsCard } from '../HiddenSuggestionsCard';
import { SuggestionRow } from '../SuggestionRow';
import { useSuggestionStore } from '../suggestion-store';
import { useThreadSuggestionsSync } from '../useThreadSuggestions';

const fetchMock = vi.mocked(apiFetch);
const THREAD = 'thread_watch';

function row(overrides: Partial<SuggestionView> = {}): SuggestionView {
  return {
    id: 'sugg-1',
    threadId: THREAD,
    messageId: 'msg-282',
    catId: 'codex61-sol',
    byline: 'watcher',
    kind: 'video-comments',
    kindLabel: '添加视频批注',
    label: '添加 7 条视频批注',
    state: 'open',
    undo: 'undo',
    receiptOnly: false,
    revision: 0,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 999,
    ...overrides,
  };
}

const reply = (body: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => body }) as unknown as Response;

describe('F335 回话下面那一排', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    useSuggestionStore.setState({ byThread: {} });
    fetchMock.mockReset();
    openWork.mockReset();
    setWorkspaceMode.mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = async (node: React.ReactElement) => {
    await act(async () => root.render(node));
  };
  const seed = (view: SuggestionView) => act(() => useSuggestionStore.getState().upsert(view));
  const button = (name: string) =>
    [...container.querySelectorAll('button')].find(
      (element) => element.textContent?.trim() === name || element.getAttribute('aria-label') === name,
    ) as HTMLButtonElement;

  it('draws nothing for a message without a row', async () => {
    await render(<SuggestionRow threadId={THREAD} messageId="msg-282" />);
    expect(container.innerHTML).toBe('');
  });

  it('turns the pill into an undoable receipt in place when tapped', async () => {
    seed(row());
    await render(<SuggestionRow threadId={THREAD} messageId="msg-282" />);
    expect(container.querySelector('.w-sugg .pill')?.textContent).toBe('添加 7 条视频批注');
    expect(container.querySelector('.w-av .eye')).not.toBeNull();
    fetchMock.mockResolvedValueOnce(
      reply(
        row({
          state: 'applied',
          revision: 2,
          receipt: {
            text: '已添加 7 条批注',
            open: { kind: 'work', contentRef: 'work:1', ownerRevision: 4, title: '片子' },
          },
        }),
      ),
    );
    await act(async () => button('添加 7 条视频批注').click());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/suggestions/sugg-1/apply',
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ expectedRevision: 0 }) }),
    );
    const receipt = container.querySelector('.w-rcpt');
    expect(receipt?.querySelector('.ok')).not.toBeNull();
    expect(receipt?.querySelector('.link')?.textContent).toBe('已添加 7 条批注 ›');
    expect(button('撤销').className).toBe('ghost');
    await act(async () => button('已添加 7 条批注 ›').click());
    expect(openWork).toHaveBeenCalledWith('work-mode');
  });

  it('dismisses with ×, leaving 已忽略 · 撤销 in the same place', async () => {
    seed(row());
    await render(<SuggestionRow threadId={THREAD} messageId="msg-282" />);
    fetchMock.mockResolvedValueOnce(reply(row({ state: 'dismissed', revision: 1 })));
    await act(async () => button('忽略').click());
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/suggestions/sugg-1/dismiss');
    expect(container.querySelector('.w-rcpt span:not(.w-av):not(.eye)')?.textContent).toBe('已忽略');
    expect(button('撤销').className).toBe('ghost');
  });

  it('draws a cat’s own receipt under the person’s message on the right, with 恢复 as the action', async () => {
    seed(
      row({
        messageId: 'msg-operator',
        state: 'applied',
        receiptOnly: true,
        undo: 'resume',
        label: '已暂停至 02:10',
        receipt: { text: '已暂停至 02:10' },
      }),
    );
    await render(<SuggestionRow threadId={THREAD} messageId="msg-operator" align="end" />);
    const receipt = container.querySelector('.w-rcpt');
    expect(receipt?.classList.contains('w-row-end')).toBe(true);
    expect(receipt?.querySelector('.ok')).toBeNull();
    expect(receipt?.querySelector('span:not(.w-av):not(.eye)')?.textContent).toBe('已暂停至 02:10');
    expect(button('恢复').className).toBe('ghost primary');
  });

  it('says in place when a tap did not work, and keeps the pill', async () => {
    seed(row({ byline: 'cat' }));
    await render(<SuggestionRow threadId={THREAD} messageId="msg-282" />);
    expect(container.querySelector('.w-av .eye')).toBeNull();
    fetchMock.mockResolvedValueOnce(reply({ error: 'This version of the work can no longer take comments' }, 422));
    await act(async () => button('添加 7 条视频批注').click());
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      '没做成：This version of the work can no longer take comments',
    );
    expect(container.querySelector('.w-sugg .pill')).not.toBeNull();
  });

  it('never lets an older push overwrite a newer state', () => {
    useSuggestionStore.getState().upsert(row({ state: 'applied', revision: 2 }));
    useSuggestionStore.getState().upsert(row({ state: 'applying', revision: 1 }));
    expect(useSuggestionStore.getState().byThread[THREAD]?.['sugg-1']?.state).toBe('applied');
  });

  it('keeps the original action and watcher supplement together in the one shared row', async () => {
    seed(row({ byline: 'cat', watcherSupplement: { catId: 'codex61-sol', text: '已向宪宪补了一句' } }));
    await render(<SuggestionRow threadId={THREAD} messageId="msg-282" />);
    expect(container.querySelectorAll('[data-testid="suggestion-row"]')).toHaveLength(1);
    expect(button('添加 7 条视频批注')).toBeDefined();
    expect(container.textContent).toContain('已向宪宪补了一句');
    expect(container.querySelectorAll('.w-av .eye')).toHaveLength(1);

    fetchMock.mockResolvedValueOnce(
      reply(
        row({
          byline: 'cat',
          state: 'applied',
          revision: 2,
          receipt: { text: '已添加 7 条批注' },
          watcherSupplement: { catId: 'codex61-sol', text: '已向宪宪补了一句' },
        }),
      ),
    );
    await act(async () => button('添加 7 条视频批注').click());
    expect(container.querySelectorAll('[data-testid="suggestion-row"]')).toHaveLength(1);
    expect(container.textContent).toContain('已添加 7 条批注');
    expect(container.textContent).toContain('已向宪宪补了一句');
    expect(button('撤销')).toBeDefined();
  });

  it('retains the watcher receipt after the unanswered original proposal expires', async () => {
    seed(row({ state: 'ignored', watcherSupplement: { catId: 'codex61-sol', text: '已向宪宪补了一句' } }));
    await render(<SuggestionRow threadId={THREAD} messageId="msg-282" />);
    expect(container.querySelector('.pill')).toBeNull();
    expect(container.querySelectorAll('[data-testid="suggestion-row"]')).toHaveLength(1);
    expect(container.textContent).toBe('已向宪宪补了一句');
  });

  it('shows 已隐藏的建议 only when something is hidden, and restores a row', async () => {
    fetchMock.mockResolvedValueOnce(reply({ hidden: [] }));
    await render(<HiddenSuggestionsCard />);
    expect(container.querySelector('[data-testid="hidden-suggestions-card"]')).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    fetchMock.mockResolvedValueOnce(
      reply({
        hidden: [
          { catId: 'codex61-sol', byline: 'watcher', kind: 'video-comments', kindLabel: '添加视频批注', hiddenAt: 2 },
          { catId: 'codex61-sol', byline: 'watcher', kind: 'scheduled-task', kindLabel: '创建定时任务', hiddenAt: 1 },
        ],
      }),
    );
    await render(<HiddenSuggestionsCard />);
    expect([...container.querySelectorAll('.w-hidden-row .name')].map((name) => name.textContent)).toEqual([
      '添加视频批注',
      '创建定时任务',
    ]);
    fetchMock.mockResolvedValueOnce(reply({ restored: true }));
    await act(async () => (container.querySelector('.w-hidden-row .restore') as HTMLButtonElement).click());
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/suggestions/hidden-kinds/restore',
      expect.objectContaining({ body: JSON.stringify({ catId: 'codex61-sol', kind: 'video-comments' }) }),
    );
    expect([...container.querySelectorAll('.w-hidden-row .name')].map((name) => name.textContent)).toEqual([
      '创建定时任务',
    ]);
  });
  describe('while the page stays open', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    function Harness() {
      useThreadSuggestionsSync(THREAD);
      return <SuggestionRow threadId={THREAD} messageId="msg-282" />;
    }
    const flush = () => act(async () => {});

    it('reads the conversation again when a pill expires, so it leaves without a reload', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const start = Date.now();
      fetchMock.mockResolvedValueOnce(reply({ threadId: THREAD, suggestions: [row({ expiresAt: start + 5_000 })] }));
      fetchMock.mockResolvedValueOnce(reply({ threadId: THREAD, suggestions: [] }));
      await render(<Harness />);
      await flush();
      expect(container.querySelector('.w-sugg')).not.toBeNull();
      await act(async () => vi.advanceTimersByTime(4_000));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTime(7_000));
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(container.querySelector('[data-testid="suggestion-row"]')).toBeNull();
    });

    it('frees a stuck click after the server lets go of it', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const start = Date.now();
      const stuck = row({ state: 'applying', revision: 1, updatedAt: start });
      fetchMock.mockResolvedValueOnce(reply({ threadId: THREAD, suggestions: [stuck] }));
      fetchMock.mockResolvedValueOnce(reply({ threadId: THREAD, suggestions: [{ ...stuck, state: 'open' }] }));
      await render(<Harness />);
      await flush();
      expect((container.querySelector('.w-sugg .pill') as HTMLButtonElement).disabled).toBe(true);
      await act(async () => vi.advanceTimersByTime(2 * 60_000 + 1_000));
      await flush();
      expect((container.querySelector('.w-sugg .pill') as HTMLButtonElement).disabled).toBe(false);
    });
  });
});
