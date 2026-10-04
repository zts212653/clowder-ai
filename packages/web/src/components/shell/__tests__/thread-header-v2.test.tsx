import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const data = vi.hoisted(() => ({ mode: vi.fn(), tasks: [] as { status: string }[], participants: [] as string[] }));
vi.mock('@/stores/chatStore', () => ({
  useChatStore: (s: (v: { setWorkspaceMode: typeof data.mode }) => unknown) => s({ setWorkspaceMode: data.mode }),
}));
vi.mock('@/stores/taskStore', () => ({
  useTaskStore: (s: (v: { tasks: typeof data.tasks }) => unknown) => s({ tasks: data.tasks }),
}));
vi.mock('@/stores/sidebarProjectionStore', () => ({
  useSidebarProjectionStore: (s: (v: { rows: { id: string; participants: string[] }[] }) => unknown) =>
    s({ rows: [{ id: 'current', participants: data.participants }] }),
}));
vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    getCatById: (id: string) =>
      id.startsWith('cat-') ? { displayName: `伙伴${id.slice(4)}`, color: { primary: '#777777' } } : undefined,
  }),
}));

import { ThreadTasksButton, ThreadWorksButton } from '../HeaderCounts';
import { HeaderParticipants } from '../HeaderParticipants';

describe('F322 thread-scoped header facts', () => {
  let host: HTMLDivElement;
  let root: Root;
  function render() {
    act(() =>
      root.render(
        <>
          <ThreadWorksButton />
          <ThreadTasksButton />
          <HeaderParticipants threadId="current" />
        </>,
      ),
    );
  }
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    data.tasks = [];
    data.participants = [];
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
  it('twelve participants remain named, including the six beyond the visible avatars', () => {
    data.participants = Array.from({ length: 12 }, (_, i) => `cat-${i + 1}`);
    render();
    const group = host.querySelector<HTMLElement>('[data-testid="header-participants"]');
    if (!group) throw new Error('Participant group is missing');
    expect(group.textContent).toContain('+6');
    expect(group.querySelectorAll('img')).toHaveLength(6);
    for (let i = 1; i <= 12; i++) expect(group.getAttribute('aria-label')).toContain(`伙伴${i}`);
    act(() => group.focus());
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('伙伴12');
    expect(group.getAttribute('title')).toBeNull();
  });
  it('unknown participant IDs are not exposed as human-facing header names', () => {
    data.participants = ['cat-1', 'private-runtime-id-unknown'];
    render();
    expect(host.querySelector('[data-testid="header-participants"]')?.getAttribute('aria-label')).not.toContain(
      'private-runtime-id-unknown',
    );
    expect([...host.querySelectorAll('img')].map((el) => el.alt).join(' ')).not.toContain('private-runtime-id-unknown');
  });
});
