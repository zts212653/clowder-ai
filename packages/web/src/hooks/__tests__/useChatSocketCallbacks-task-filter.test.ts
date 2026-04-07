/**
 * Regression test: TaskPanel must only receive work tasks for the active thread.
 * Bug: #320 intake caused pr_tracking tasks to leak into 毛线球 (TaskPanel).
 * Guard: socket callbacks filter by both threadId and kind.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const addTaskMock = vi.fn();
const updateTaskMock = vi.fn();

vi.mock('@/stores/chatStore', () => ({
  useChatStore: () => ({
    updateThreadTitle: vi.fn(),
    setLoading: vi.fn(),
    setHasActiveInvocation: vi.fn(),
    setIntentMode: vi.fn(),
    setTargetCats: vi.fn(),
    addMessage: vi.fn(),
    removeMessage: vi.fn(),
    removeThreadMessage: vi.fn(),
    requestStreamCatchUp: vi.fn(),
  }),
}));

vi.mock('@/stores/gameStore', () => ({
  useGameStore: { getState: () => ({ setGameView: vi.fn() }) },
}));

vi.mock('@/stores/taskStore', () => ({
  useTaskStore: () => ({
    addTask: addTaskMock,
    updateTask: updateTaskMock,
  }),
}));

const { useChatSocketCallbacks } = await import('../useChatSocketCallbacks');

import type { SocketCallbacks } from '../useSocket';

let captured: SocketCallbacks | null = null;

function HookHost({ threadId }: { threadId: string }) {
  captured = useChatSocketCallbacks({
    threadId,
    userId: 'user-1',
    handleAgentMessage: vi.fn(() => true) as unknown as SocketCallbacks['onMessage'],
    resetTimeout: vi.fn(),
    clearDoneTimeout: vi.fn(),
    handleAuthRequest: vi.fn(),
    handleAuthResponse: vi.fn(),
  });
  return null;
}

let root: Root;
let container: HTMLDivElement;

describe('TaskPanel socket filter: kind + threadId guard', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    addTaskMock.mockClear();
    updateTaskMock.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(React.createElement(HookHost, { threadId: 'thread-1' }));
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    captured = null;
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  // --- kind filter ---

  it('blocks pr_tracking task_created from entering taskStore', () => {
    captured!.onTaskCreated!({ id: 't1', threadId: 'thread-1', kind: 'pr_tracking', title: 'PR #42' });
    expect(addTaskMock).not.toHaveBeenCalled();
  });

  it('blocks pr_tracking task_updated from entering taskStore', () => {
    captured!.onTaskUpdated!({ id: 't1', threadId: 'thread-1', kind: 'pr_tracking', status: 'done' });
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  // --- threadId filter ---

  it('blocks task_created from a different thread', () => {
    captured!.onTaskCreated!({ id: 't2', threadId: 'thread-other', kind: 'work', title: 'review' });
    expect(addTaskMock).not.toHaveBeenCalled();
  });

  it('blocks task_updated from a different thread', () => {
    captured!.onTaskUpdated!({ id: 't2', threadId: 'thread-other', kind: 'work', status: 'doing' });
    expect(updateTaskMock).not.toHaveBeenCalled();
  });

  // --- happy path ---

  it('allows work task_created for the active thread', () => {
    captured!.onTaskCreated!({ id: 't3', threadId: 'thread-1', kind: 'work', title: 'fix bug' });
    expect(addTaskMock).toHaveBeenCalledTimes(1);
  });

  it('allows work task_updated for the active thread', () => {
    captured!.onTaskUpdated!({ id: 't3', threadId: 'thread-1', kind: 'work', status: 'done' });
    expect(updateTaskMock).toHaveBeenCalledTimes(1);
  });
});
