import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis as Record<string, unknown>, { React });

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: (catId: string) => ({ displayName: catId }) }),
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (state: { threadStates: Record<string, never> }) => unknown) =>
    selector({ threadStates: {} }),
}));
vi.mock('@/stores/label-store', () => ({ useLabelStore: () => ({ labels: [] }) }));
vi.mock('@/utils/api-client', () => ({ API_URL: 'http://example.test', apiFetch: vi.fn() }));
vi.mock('@/components/CatAvatar', () => ({
  CatAvatar: ({ catId }: { catId: string }) => React.createElement('span', { 'data-cat-id': catId }, 'avatar'),
}));
vi.mock('@/components/ThreadCatStatus', () => ({
  ThreadCatStatus: ({ hasUserMention }: { hasUserMention: boolean }) =>
    React.createElement('span', { 'data-has-user-mention': String(hasUserMention) }),
}));
vi.mock('@/components/icons/HubIcon', () => ({ HubIcon: () => null }));
vi.mock('@/components/icons/PawIcon', () => ({ PawIcon: () => null }));
vi.mock('@/components/ThreadSidebar/thread-utils', () => ({
  formatRelativeTime: () => '3时',
  formatSidebarStatusTime: () => '3时',
}));

import { F277AttentionPreview } from '../preview';

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
  if (!setter) throw new Error('native input value setter is unavailable');
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('F277 real-shell attention preview', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderPreview() {
    await act(async () => root.render(<F277AttentionPreview />));
  }

  it('expands the current cluster and compresses the other clusters into summaries', async () => {
    await renderPreview();

    const f296 = container.querySelector<HTMLElement>('[data-cluster-id="f296"]');
    const f277 = container.querySelector<HTMLElement>('[data-cluster-id="f277"]');
    expect(f277?.dataset.expanded).toBe('true');
    expect(f277?.querySelectorAll('[data-thread-id]')).toHaveLength(4);
    expect(f296?.dataset.expanded).toBe('false');
    expect(f296?.querySelectorAll('[data-thread-id]')).toHaveLength(0);
    expect(f296?.textContent).toContain('7 个对话');
    expect(f296?.textContent).toContain('1 个 @你');
  });

  it('uses production ThreadItem rows and keeps Group anchors status-free', async () => {
    await renderPreview();

    const row = container.querySelector<HTMLElement>('[data-thread-id="thread_mslbd9ghs8rdoxui"]');
    expect(row?.className).toContain('py-2.5');
    expect(row?.querySelector('[data-testid="thread-participant-metadata"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-group-anchor="true"]')).toHaveLength(4);
    expect(container.querySelector('[data-thread-state-node]')).toBeNull();
  });

  it('exposes the complete production thread action menu in the acceptance preview', async () => {
    await renderPreview();

    const row = container.querySelector<HTMLElement>('[data-thread-id="thread_mslbd9ghs8rdoxui"]');
    await act(async () => row?.querySelector<HTMLButtonElement>('button[title="更多操作"]')?.click());

    const menuText = row?.querySelector<HTMLElement>('[role="menu"]')?.textContent ?? '';
    for (const action of ['对话设置', '整理 Group', '重命名对话', '导出对话', '回放剧场', '收藏', '删除对话']) {
      expect(menuText).toContain(action);
    }
  });

  it('enters the production arrangement mode after a deliberate 450ms long press', async () => {
    await renderPreview();
    vi.useFakeTimers();

    const row = container.querySelector<HTMLElement>('[data-attention-draggable-thread="thread_mslbd9ghs8rdoxui"]');
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
      vi.advanceTimersByTime(500);
    });

    expect(row?.dataset.attentionArranging).toBe('true');
    expect(container.querySelector('[data-testid="attention-arrange-toolbar"]')?.textContent).toContain('完成');
    vi.useRealTimers();
  });

  it('executes rename, pin, favorite, replay, and delete actions against the preview state', async () => {
    await renderPreview();
    const threadId = 'thread_mslbd9ghs8rdoxui';
    const row = container.querySelector<HTMLElement>(`[data-thread-id="${threadId}"]`);
    const openMenu = async () => {
      await act(async () => row?.querySelector<HTMLButtonElement>('button[title="更多操作"]')?.click());
    };
    const clickAction = async (label: string) => {
      const action = [...(row?.querySelectorAll<HTMLButtonElement>('[role="menu"] button') ?? [])].find(
        (button) => button.textContent?.trim() === label,
      );
      await act(async () => action?.click());
    };

    await openMenu();
    await clickAction('重命名对话');
    const titleInput = row?.querySelector<HTMLInputElement>('input');
    await act(async () => setInputValue(titleInput as HTMLInputElement, 'F277 验收中的对话'));
    await act(async () =>
      titleInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })),
    );
    expect(row?.textContent).toContain('F277 验收中的对话');

    await act(async () => row?.querySelector<HTMLButtonElement>('[data-testid="thread-pin-button"]')?.click());
    expect(row?.querySelector('[aria-label^="置顶 F277 验收中的对话"]')).not.toBeNull();

    await openMenu();
    await clickAction('收藏');
    expect(row?.querySelector('[data-testid="thread-favorite-mark"]')).not.toBeNull();

    await openMenu();
    await clickAction('回放剧场');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('回放剧场 · F277 验收中的对话');

    await openMenu();
    await clickAction('删除对话');
    expect(container.querySelector(`[data-thread-id="${threadId}"]`)).toBeNull();
  });

  it('uses the production organizer dialog to create a visible saved conversation group', async () => {
    await renderPreview();

    const row = container.querySelector<HTMLElement>('[data-thread-id="thread_f297_snapshot"]');
    await act(async () => row?.querySelector<HTMLButtonElement>('button[title="更多操作"]')?.click());
    const organize = [...(row?.querySelectorAll<HTMLButtonElement>('[role="menu"] button') ?? [])].find(
      (button) => button.textContent?.trim() === '整理 Group',
    );
    await act(async () => organize?.click());

    const dialog = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog?.textContent).toContain('与另一条对话新建 Group');
    const create = [...(dialog?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
      (button) => button.textContent?.trim() === '新建 Group',
    );
    await act(async () => create?.click());

    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).toContain('Group');
    expect(container.textContent).not.toContain('我的组');
  });

  it('recalls a collapsed cluster and its matching member through search', async () => {
    await renderPreview();

    const search = container.querySelector<HTMLInputElement>('input[aria-label="搜索对话"]');
    expect(search).not.toBeNull();
    await act(async () => setInputValue(search as HTMLInputElement, '视觉裁决'));

    const f277 = container.querySelector<HTMLElement>('[data-cluster-id="f277"]');
    expect(f277?.dataset.expanded).toBe('true');
    expect(f277?.querySelector('[data-thread-id="thread_mslbd9ghs8rdoxui"]')).not.toBeNull();
    expect(container.querySelector('[data-cluster-id="f296"]')).toBeNull();
  });

  it('uses the exact title and the production rename interaction without a parallel demo-only shell', async () => {
    await renderPreview();

    const f296 = container.querySelector<HTMLElement>('[data-cluster-id="f296"]');
    expect(f296?.textContent).toContain('F296 · Continuity-Aware Context Injection');
    const rename = f296?.querySelector<HTMLButtonElement>('button[aria-label^="重命名"]');
    await act(async () => rename?.click());
    const input = f296?.querySelector<HTMLInputElement>('input[aria-label="对话组名称"]');
    expect(input).not.toBeNull();
    await act(async () => setInputValue(input as HTMLInputElement, '接续工程'));
    const save = Array.from(f296?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (button) => button.textContent === '保存',
    );
    await act(async () => save?.click());
    expect(f296?.textContent).toContain('接续工程');

    const reopen = f296?.querySelector<HTMLButtonElement>('button[aria-label="重命名 接续工程"]');
    await act(async () => reopen?.click());
    const reset = Array.from(f296?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (button) => button.textContent === '恢复名称',
    );
    await act(async () => reset?.click());
    expect(f296?.textContent).toContain('P1 F296 B4c');
  });

  it('returns a selected message to the main draft with an exact source reference', async () => {
    await renderPreview();

    const quote = container.querySelector<HTMLButtonElement>('button[data-quote-to-main]');
    await act(async () => quote?.click());
    const draft = container.querySelector<HTMLTextAreaElement>('[data-testid="main-draft"]');
    expect(draft?.value).toContain('thread_mslbd9ghs8rdoxui#message_f277_preview_oxui');
    expect(draft?.value).toContain('真实 Sidebar');
  });

  it('persists a manual collapse preference without changing membership', async () => {
    await renderPreview();

    const toggle = container.querySelector<HTMLButtonElement>('[data-cluster-id="f277"] button[aria-expanded="true"]');
    await act(async () => toggle?.click());
    expect(container.querySelector('[data-cluster-id="f277"]')?.getAttribute('data-expanded')).toBe('false');
    expect(JSON.parse(localStorage.getItem('cat-cafe:f277-preview:cluster-open') ?? '{}')).toEqual({ f277: false });
  });
});
