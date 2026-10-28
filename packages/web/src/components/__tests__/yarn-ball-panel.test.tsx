import { readFileSync } from 'node:fs';
import type { CatId, TaskItem } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTaskStore } from '@/stores/taskStore';
import { checkShellCopyParity } from '../shell/__tests__/shell-copy-parity-check';
import { YarnBallIcon } from '../shell/ShellIcons';
import { writeShellLanguage } from '../shell/shell-language';
import { ShellPresentationContext } from '../shell/shell-presentation';
import { TaskBoardPanel } from '../TaskBoardPanel';
import { yarnBallCopy } from '../yarn-ball/yarn-ball.shell-copy';

const mocks = vi.hoisted(() => ({ threadId: 't1', api: vi.fn(), close: vi.fn(), teleport: vi.fn() }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: Object.assign(
    (selector: (state: { currentThreadId: string }) => unknown) => selector({ currentThreadId: mocks.threadId }),
    { getState: () => ({ currentThreadId: mocks.threadId, closeRightPanel: mocks.close }) },
  ),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: (id: string) => ({ id, displayName: '宪宪', color: { primary: '#c46a4d' } }) }),
}));
vi.mock('@/hooks/useCoCreatorConfig', () => ({ useCoCreatorDisplay: () => ({ nickname: 'You' }) }));
vi.mock('@/utils/api-client', () => ({ apiFetch: mocks.api }));
vi.mock('@/utils/teleport', () => ({ planTeleport: mocks.teleport, kickTeleportResolve: vi.fn() }));
vi.mock('@/utils/scrollToMessage', () => ({ scrollToMessage: vi.fn() }));

const task = (id: string, status: TaskItem['status'], extra: Partial<TaskItem> = {}): TaskItem => ({
  id,
  status,
  kind: 'work',
  threadId: 't1',
  subjectKey: null,
  title: `真实工作 ${id}`,
  ownerCatId: 'opus55' as CatId,
  why: '这是内部长说明，不能变成给人看的进展',
  createdBy: 'user',
  createdAt: 1000,
  updatedAt: Date.now() - 120000,
  ...extra,
});

describe('v2 conversation yarn balls', () => {
  it('keeps every new label and template consistent in Chinese and English', () => {
    expect(checkShellCopyParity(yarnBallCopy)).toEqual([]);
  });
  let host: HTMLDivElement, root: Root;
  const render = () =>
    act(() =>
      root.render(
        <ShellPresentationContext.Provider value="v2">
          <TaskBoardPanel />
        </ShellPresentationContext.Provider>,
      ),
    );
  const button = (label: string) => {
    const node = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes(label));
    if (!node) throw new Error(`Missing button: ${label}`);
    return node;
  };
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    mocks.threadId = 't1';
    writeShellLanguage('zh');
    useTaskStore.setState({
      tasks: [task('a', 'doing'), task('b', 'blocked'), task('c', 'done'), task('other', 'doing', { threadId: 't2' })],
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useTaskStore.getState().clearTasks();
    writeShellLanguage('zh');
  });

  it('renders the selected C SVG without changing its shapes or colors', () => {
    const source = document.createElement('div');
    source.innerHTML = readFileSync('../../docs/evidence/2026-10-26-f322-undrawn/art/yarn-C.svg', 'utf8');
    const rendered = document.createElement('div');
    rendered.innerHTML = renderToStaticMarkup(<YarnBallIcon />);
    const shapes = (node: HTMLDivElement) =>
      [...node.querySelector('svg')!.children].map((child) =>
        child.outerHTML.replace(/\s+/g, ' ').replace(/> </g, '><').trim(),
      );
    expect(shapes(rendered)).toEqual(shapes(source));
  });

  it('uses the existing create payload and inserts only a confirmed response into this conversation', async () => {
    render();
    act(() => button('＋ 新毛线球').click());
    const input = host.querySelector('input');
    if (!input) throw new Error('missing task title');
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, '新毛线球');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    mocks.api.mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 503 }));
    await act(async () => button('创建毛线球').click());
    expect(host.textContent).toContain('创建失败');
    expect(host.querySelector('input')?.value).toBe('新毛线球');
    expect(useTaskStore.getState().tasks).toHaveLength(4);
    mocks.api.mockResolvedValueOnce(Response.json(task('new', 'todo', { title: '新毛线球' })));
    await act(async () => button('创建毛线球').click());
    expect(mocks.api.mock.calls[1][0]).toBe('/api/tasks');
    expect(JSON.parse(mocks.api.mock.calls[1][1].body)).toEqual({
      threadId: 't1',
      title: '新毛线球',
      createdBy: 'user',
    });
    expect(host.querySelector('input')).toBeNull();
    expect(host.textContent).toContain('3 颗没完成');
    expect(host.textContent).toContain('还没开始');
    expect(host.querySelector('[data-yarn-ball-id="new"]')).not.toBeNull();
  });

  it('uses the same conversation open count, hides empty groups and does not invent progress/history/source', () => {
    render();
    expect(host.textContent).toContain('这条对话的毛线球 · 2 颗没完成');
    expect(host.textContent).toContain('在等');
    expect(host.textContent).not.toMatch(/doing|blocked|总任务|还没开始|还没写进展|现在：|在等：/);
    expect(host.textContent).not.toContain('真实工作 other');
    expect(host.querySelector('details')?.open).toBe(false);
    act(() => button('真实工作 b').click());
    expect(host.textContent).not.toMatch(/这是内部|最近的经过|去原处/);
    expect(host.textContent).toContain('改状态');
    act(() => host.querySelector('summary')?.click());
    expect(host.querySelector('details')?.open).toBe(true);
    expect(host.textContent).toContain('真实工作 c');
  });

  it('changes the panel and controls to English while retaining real task titles', () => {
    render();
    act(() => writeShellLanguage('en'));
    expect(host.textContent).toContain('Tasks in this conversation · 2 open');
    expect(host.textContent).toContain('In progress');
    expect(host.textContent).toContain('Waiting');
    expect(host.textContent).toContain('New task');
    expect(host.textContent).toContain('真实工作 a');
  });

  it('uses the existing exact-message navigation only when a real source id exists', () => {
    useTaskStore.getState().setTasks([task('source', 'doing', { sourceMessageId: 'original-message' })], 't1');
    mocks.teleport.mockReturnValue({ scrollNow: 'original-message', navigateTo: null });
    render();
    act(() => button('真实工作 source').click());
    act(() => button('去原处').click());
    expect(mocks.teleport).toHaveBeenCalledWith({
      threadId: 't1',
      messageId: 'original-message',
      currentThreadId: 't1',
    });
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('keeps a rejected status change visible as unconfirmed and applies only a real successful task response', async () => {
    render();
    act(() => button('真实工作 a').click());
    const choose = async (label: string) => {
      const trigger = host.querySelector<HTMLButtonElement>('button[role="combobox"]');
      if (!trigger) throw new Error('missing shared status choice');
      await act(async () => trigger.click());
      const option = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((node) =>
        node.textContent?.endsWith(label),
      );
      if (!option) throw new Error(`missing status option: ${label}`);
      await act(async () => option.click());
    };
    mocks.api.mockResolvedValueOnce(Response.json({ error: 'typed closure required' }, { status: 409 }));
    await choose('已完成');
    expect(useTaskStore.getState().tasks.find((t) => t.id === 'a')?.status).toBe('doing');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('未能确认');
    mocks.api.mockResolvedValueOnce(Response.json(task('a', 'blocked', { updatedAt: Date.now() })));
    await choose('在等');
    expect(mocks.api.mock.calls[1][0]).toBe('/api/tasks/a');
    expect(JSON.parse(mocks.api.mock.calls[1][1].body)).toEqual({ status: 'blocked', expectedOwnerRevision: 0 });
    expect(useTaskStore.getState().tasks.find((t) => t.id === 'a')?.status).toBe('blocked');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('does not add an outgoing status response to a different current conversation', async () => {
    let finish: ((value: Response) => void) | undefined;
    mocks.api.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    render();
    act(() => button('真实工作 a').click());
    const choose = async (label: string) => {
      const trigger = host.querySelector<HTMLButtonElement>('button[role="combobox"]');
      if (!trigger) throw new Error('missing shared status choice');
      await act(async () => trigger.click());
      const option = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((node) =>
        node.textContent?.endsWith(label),
      );
      if (!option) throw new Error(`missing status option: ${label}`);
      await act(async () => option.click());
    };
    await choose('在等');
    mocks.threadId = 't2';
    act(() => useTaskStore.getState().setTasks([], 't2'));
    render();
    await act(async () => finish?.(Response.json(task('a', 'blocked'))));
    expect(useTaskStore.getState().tasks).toEqual([]);
    expect(host.textContent).toContain('0 颗没完成');
  });

  it('keeps an unread empty store unnumbered until its own thread read completes', () => {
    act(() => useTaskStore.getState().clearTasks());
    render();
    expect(host.textContent).toContain('尚未读到');
    expect(host.textContent).not.toContain('0 颗');
    act(() => useTaskStore.getState().setTasks([], 't1'));
    expect(host.textContent).toContain('0 颗没完成');
    expect(host.textContent).toContain('还没有毛线球');
  });
});
