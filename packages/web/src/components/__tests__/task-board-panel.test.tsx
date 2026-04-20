import type { TaskItem } from '@cat-cafe/shared';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

Object.assign(globalThis as Record<string, unknown>, { React });

function makeTasks(): TaskItem[] {
  const base = {
    kind: 'work' as const,
    threadId: 't1',
    subjectKey: null,
    why: 'test reason',
    createdBy: 'user' as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ownerCatId: null,
  };
  return [
    { ...base, id: '1', title: 'Doing task', status: 'doing' },
    { ...base, id: '2', title: 'Blocked task', status: 'blocked' },
    { ...base, id: '3', title: 'Todo task', status: 'todo' },
    { ...base, id: '4', title: 'Done task', status: 'done' },
  ];
}

let mockTasks: TaskItem[] = [];

vi.mock('@/stores/taskStore', () => ({
  useTaskStore: (selector: (s: { tasks: TaskItem[] }) => unknown) => selector({ tasks: mockTasks }),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: (selector: (s: { currentThreadId: string | null }) => unknown) =>
    selector({ currentThreadId: 'thread-1' }),
}));

vi.mock('../TaskComposer', () => ({
  TaskComposer: () => <div data-testid="task-composer" />,
}));

describe('TaskBoardPanel', () => {
  beforeEach(() => {
    mockTasks = [];
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('taskboard-collapsed');
    }
  });

  it('renders four status sections in correct order: doing, blocked, todo, done', async () => {
    mockTasks = makeTasks();
    const { TaskBoardPanel } = await import('../TaskBoardPanel');
    const html = renderToStaticMarkup(<TaskBoardPanel />);
    const sections = ['进行中', '阻塞中', '待办', '已完成'];
    for (const label of sections) {
      expect(html).toContain(label);
    }
    const positions = sections.map((s) => html.indexOf(s));
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  it('shows doing and blocked task items (expanded by default)', async () => {
    mockTasks = makeTasks();
    const { TaskBoardPanel } = await import('../TaskBoardPanel');
    const html = renderToStaticMarkup(<TaskBoardPanel />);
    expect(html).toContain('Doing task');
    expect(html).toContain('Blocked task');
  });

  it('hides todo and done task items (collapsed by default)', async () => {
    mockTasks = makeTasks();
    const { TaskBoardPanel } = await import('../TaskBoardPanel');
    const html = renderToStaticMarkup(<TaskBoardPanel />);
    expect(html).not.toContain('Todo task');
    expect(html).not.toContain('Done task');
  });

  it('renders header with stats badge', async () => {
    mockTasks = makeTasks();
    const { TaskBoardPanel } = await import('../TaskBoardPanel');
    const html = renderToStaticMarkup(<TaskBoardPanel />);
    expect(html).toContain('毛线球');
  });

  it('renders blocked section with red highlight', async () => {
    mockTasks = makeTasks();
    const { TaskBoardPanel } = await import('../TaskBoardPanel');
    const html = renderToStaticMarkup(<TaskBoardPanel />);
    expect(html).toContain('bg-red-50');
  });

  it('shows empty state with guidance when no tasks', async () => {
    mockTasks = [];
    const { TaskBoardPanel } = await import('../TaskBoardPanel');
    const html = renderToStaticMarkup(<TaskBoardPanel />);
    expect(html).toContain('把长期事项挂在线上');
    expect(html).toContain('创建第一颗毛线球');
    expect(html).toContain('何时该用毛线球');
  });

  it('respects localStorage collapse preference on render', async () => {
    mockTasks = makeTasks();
    // Simulate user having previously expanded todo section
    localStorage.setItem(
      'taskboard-collapsed',
      JSON.stringify({ todo: false, done: true, doing: false, blocked: false }),
    );
    const { TaskBoardPanel } = await import('../TaskBoardPanel');
    const html = renderToStaticMarkup(<TaskBoardPanel />);
    // todo section was set to not-collapsed, so its task should be visible
    expect(html).toContain('Todo task');
    // done section is still collapsed
    expect(html).not.toContain('Done task');
  });
});
