import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const data = vi.hoisted(() => ({
  mode: vi.fn(),
  tasks: [] as { status: string }[],
  threadId: 'thread-current',
  readWorks: vi.fn(),
  works: { total: null as number | null, complete: false, loading: true, error: false },
}));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (s: (v: { setWorkspaceMode: typeof data.mode; currentThreadId: string }) => unknown) =>
    s({ setWorkspaceMode: data.mode, currentThreadId: data.threadId }),
}));
vi.mock('@/hooks/useThreadArtifacts', () => ({
  useThreadArtifacts: (threadId: string, view: string) => {
    data.readWorks(threadId, view);
    return data.works;
  },
}));
vi.mock('@/stores/taskStore', () => ({
  useTaskStore: (s: (v: { tasks: typeof data.tasks }) => unknown) => s({ tasks: data.tasks }),
}));

import { ThreadTasksButton, ThreadWorksButton } from '../HeaderCounts';
import { writeShellLanguage } from '../shell-language';

describe('F322 thread-scoped header facts', () => {
  let host: HTMLDivElement;
  let root: Root;
  function render() {
    act(() =>
      root.render(
        <>
          <ThreadWorksButton threadId={data.threadId} />
          <ThreadTasksButton />
        </>,
      ),
    );
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    writeShellLanguage('zh');
    data.tasks = [];
    data.works = { total: null, complete: false, loading: true, error: false };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const matches = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, selector: string) {
      return selector === ':focus-visible' || matches.call(this, selector);
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    writeShellLanguage('zh');
    vi.restoreAllMocks();
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });
  it('counts only unfinished tasks; works does not invent a number; actions retain original modes', () => {
    data.tasks = ['todo', 'doing', 'blocked', 'done', 'done'].map((status) => ({ status }));
    render();
    const tasks = host.querySelector<HTMLButtonElement>('[data-testid="header-tasks"]');
    const works = host.querySelector<HTMLButtonElement>('[data-testid="header-works"]');
    if (!tasks || !works) throw new Error('Thread header actions are missing');
    expect(tasks.textContent).toBe('任务3');
    expect(tasks.getAttribute('aria-label')).toBe('任务 3，这条对话的任务');
    expect(works.textContent).toBe('作品');
    expect(works.getAttribute('aria-label')).not.toMatch(/\d/);
    act(() => {
      tasks.click();
      works.click();
    });
    expect(data.mode.mock.calls).toEqual([['tasks'], ['artifacts']]);
    expect(host.querySelector('[title]')).toBeNull();
  });
  it('all-done or unread initial tasks do not claim a numeric zero', () => {
    data.tasks = [{ status: 'done' }];
    render();
    expect(host.querySelector('[data-testid="header-tasks"]')?.textContent).toBe('任务');
  });
  it('uses the original works catalogue total rather than the displayed row count', () => {
    data.works = { total: 774, complete: true, loading: false, error: false };
    render();
    expect(data.readWorks).toHaveBeenCalledWith('thread-current', 'works');
    expect(host.querySelector('[data-testid="header-works"]')?.textContent).toBe('作品774');
    act(() => writeShellLanguage('en'));
    expect(host.querySelector('[data-testid="header-works"]')?.getAttribute('aria-label')).toBe(
      'Works 774, Works in this conversation',
    );
  });
  it('shows a verified empty catalogue as zero, but leaves partial or failed reads unnumbered', () => {
    data.works = { total: 0, complete: true, loading: false, error: false };
    render();
    expect(host.querySelector('[data-testid="header-works"]')?.textContent).toBe('作品0');
    for (const state of [
      { total: 774, complete: false, loading: false, error: false },
      { total: 774, complete: true, loading: false, error: true },
    ]) {
      data.works = state;
      render();
      expect(host.querySelector('[data-testid="header-works"]')?.textContent).toBe('作品');
    }
  });
  it('keeps a confirmed Works count during a same-thread background read', () => {
    data.works = { total: 1, complete: true, loading: false, error: false };
    render();
    data.works = { ...data.works, loading: true };
    render();
    expect(host.querySelector('[data-testid="header-works"]')?.textContent).toBe('作品1');
  });
  it('switches both labels and accessible descriptions to English without changing counts or destinations', () => {
    data.tasks = [{ status: 'doing' }, { status: 'done' }];
    render();
    act(() => writeShellLanguage('en'));
    const works = host.querySelector<HTMLButtonElement>('[data-testid="header-works"]');
    const tasks = host.querySelector<HTMLButtonElement>('[data-testid="header-tasks"]');
    expect(works?.textContent).toBe('Works');
    expect(tasks?.textContent).toBe('Tasks1');
    expect(works?.getAttribute('aria-label')).toBe('Works, Works in this conversation');
    expect(tasks?.getAttribute('aria-label')).toBe('Tasks 1, Tasks in this conversation');
    act(() => {
      works?.click();
      tasks?.click();
    });
    expect(data.mode.mock.calls).toEqual([['artifacts'], ['tasks']]);
  });
});
