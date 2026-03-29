/**
 * F109 Phase A — Socket callback wiring tests:
 * - onMessageDeleted must use removeThreadMessage (thread-scoped), not removeMessage (flat-only)
 * - onMessageRestored must call requestStreamCatchUp (not no-op)
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const removeMessageMock = vi.fn();
const removeThreadMessageMock = vi.fn();
const requestStreamCatchUpMock = vi.fn();

vi.mock('@/stores/chatStore', () => ({
  useChatStore: () => ({
    updateThreadTitle: vi.fn(),
    setLoading: vi.fn(),
    setHasActiveInvocation: vi.fn(),
    setIntentMode: vi.fn(),
    setTargetCats: vi.fn(),
    addMessage: vi.fn(),
    removeMessage: removeMessageMock,
    removeThreadMessage: removeThreadMessageMock,
    requestStreamCatchUp: requestStreamCatchUpMock,
  }),
}));

vi.mock('@/stores/gameStore', () => ({
  useGameStore: { getState: () => ({ setGameView: vi.fn() }) },
}));

vi.mock('@/stores/taskStore', () => ({
  useTaskStore: () => ({
    addTask: vi.fn(),
    updateTask: vi.fn(),
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

describe('F109: onMessageDeleted uses removeThreadMessage', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    removeMessageMock.mockClear();
    removeThreadMessageMock.mockClear();
    requestStreamCatchUpMock.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    captured = null;
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('calls removeThreadMessage with threadId and messageId (not removeMessage)', () => {
    act(() => {
      root.render(React.createElement(HookHost, { threadId: 'thread-1' }));
    });

    captured!.onMessageDeleted!({
      messageId: 'msg-42',
      threadId: 'thread-1',
      deletedBy: 'user-1',
    });

    expect(removeThreadMessageMock).toHaveBeenCalledWith('thread-1', 'msg-42');
    expect(removeMessageMock).not.toHaveBeenCalled();
  });

  it('works for background thread deletion (different threadId)', () => {
    act(() => {
      root.render(React.createElement(HookHost, { threadId: 'thread-1' }));
    });

    captured!.onMessageDeleted!({
      messageId: 'msg-99',
      threadId: 'thread-bg-5',
      deletedBy: 'user-1',
    });

    expect(removeThreadMessageMock).toHaveBeenCalledWith('thread-bg-5', 'msg-99');
    expect(removeMessageMock).not.toHaveBeenCalled();
  });
});

describe('F109: onMessageRestored calls requestStreamCatchUp', () => {
  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    requestStreamCatchUpMock.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    captured = null;
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('triggers catch-up for the restored message thread', () => {
    act(() => {
      root.render(React.createElement(HookHost, { threadId: 'thread-1' }));
    });

    captured!.onMessageRestored!({
      messageId: 'msg-50',
      threadId: 'thread-1',
    });

    expect(requestStreamCatchUpMock).toHaveBeenCalledWith('thread-1');
  });

  it('triggers catch-up for a background thread restore', () => {
    act(() => {
      root.render(React.createElement(HookHost, { threadId: 'thread-1' }));
    });

    captured!.onMessageRestored!({
      messageId: 'msg-51',
      threadId: 'thread-bg-3',
    });

    expect(requestStreamCatchUpMock).toHaveBeenCalledWith('thread-bg-3');
  });
});
