import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatSocketCallbacks } from '@/hooks/useChatSocketCallbacks';

const clearThreadStateMock = vi.hoisted(() => vi.fn());
const updateThreadTitleMock = vi.hoisted(() => vi.fn());
const setLoadingMock = vi.hoisted(() => vi.fn());
const setHasActiveInvocationMock = vi.hoisted(() => vi.fn());
const setIntentModeMock = vi.hoisted(() => vi.fn());
const setTargetCatsMock = vi.hoisted(() => vi.fn());
const addMessageMock = vi.hoisted(() => vi.fn());
const removeMessageMock = vi.hoisted(() => vi.fn());
const addTaskMock = vi.hoisted(() => vi.fn());
const updateTaskMock = vi.hoisted(() => vi.fn());
const setGameViewMock = vi.hoisted(() => vi.fn());

vi.mock('@/stores/chatStore', () => {
  const state = {
    updateThreadTitle: updateThreadTitleMock,
    setLoading: setLoadingMock,
    setHasActiveInvocation: setHasActiveInvocationMock,
    setIntentMode: setIntentModeMock,
    setTargetCats: setTargetCatsMock,
    addMessage: addMessageMock,
    removeMessage: removeMessageMock,
    clearThreadState: clearThreadStateMock,
  };

  const useChatStore = () => state;
  useChatStore.getState = () => state;

  return { useChatStore };
});

vi.mock('@/stores/taskStore', () => ({
  useTaskStore: () => ({
    addTask: addTaskMock,
    updateTask: updateTaskMock,
  }),
}));

vi.mock('@/stores/gameStore', () => {
  const state = { setGameView: setGameViewMock };
  const useGameStore = () => state;
  useGameStore.getState = () => state;
  return { useGameStore };
});

describe('useChatSocketCallbacks', () => {
  let container: HTMLDivElement;
  let root: Root;
  let callbacks: ReturnType<typeof useChatSocketCallbacks> | null = null;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    clearThreadStateMock.mockReset();
    updateThreadTitleMock.mockReset();
    setLoadingMock.mockReset();
    setHasActiveInvocationMock.mockReset();
    setIntentModeMock.mockReset();
    setTargetCatsMock.mockReset();
    addMessageMock.mockReset();
    removeMessageMock.mockReset();
    addTaskMock.mockReset();
    updateTaskMock.mockReset();
    setGameViewMock.mockReset();

    callbacks = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  function renderHarness(overrides: Partial<Parameters<typeof useChatSocketCallbacks>[0]> = {}) {
    const deps = {
      threadId: 'thread-source',
      userId: 'user-1',
      handleAgentMessage: vi.fn(),
      resetTimeout: vi.fn(),
      clearDoneTimeout: vi.fn(),
      handleAuthRequest: vi.fn(),
      handleAuthResponse: vi.fn(),
      onNavigateToThread: vi.fn(),
      ...overrides,
    };

    function Harness() {
      callbacks = useChatSocketCallbacks(deps);
      return null;
    }

    act(() => {
      root.render(React.createElement(Harness));
    });

    return deps;
  }

  it('clears stale cache before navigating to an initiator game thread', () => {
    const deps = renderHarness();

    act(() => {
      callbacks?.onGameThreadCreated?.({
        gameThreadId: 'thread-reused',
        initiatorUserId: 'user-1',
      } as never);
    });

    expect(clearThreadStateMock).toHaveBeenCalledWith('thread-reused');
    expect(deps.onNavigateToThread).toHaveBeenCalledWith('thread-reused');
  });

  it('does not clear or navigate for non-initiator game thread events', () => {
    const deps = renderHarness();

    act(() => {
      callbacks?.onGameThreadCreated?.({
        gameThreadId: 'thread-reused',
        initiatorUserId: 'someone-else',
      } as never);
    });

    expect(clearThreadStateMock).not.toHaveBeenCalled();
    expect(deps.onNavigateToThread).not.toHaveBeenCalled();
  });
});
