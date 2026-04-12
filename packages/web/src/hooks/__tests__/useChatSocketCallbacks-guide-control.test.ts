import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/stores/chatStore', () => ({
  useChatStore: () => ({
    updateThreadTitle: vi.fn(),
    updateThreadParticipants: vi.fn(),
    setLoading: vi.fn(),
    setHasActiveInvocation: vi.fn(),
    setIntentMode: vi.fn(),
    setTargetCats: vi.fn(),
    removeThreadMessage: vi.fn(),
    requestStreamCatchUp: vi.fn(),
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

describe('useChatSocketCallbacks guide control bridge', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
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

  it('dispatches guide:control with action, guideId, and threadId', () => {
    let detail: Record<string, unknown> | undefined;
    const handler = (event: Event) => {
      detail = (event as CustomEvent<Record<string, unknown>>).detail;
    };
    window.addEventListener('guide:control', handler);

    try {
      captured!.onGuideControl!({
        action: 'exit',
        guideId: 'add-member',
        threadId: 'thread-1',
        timestamp: Date.now(),
      });
    } finally {
      window.removeEventListener('guide:control', handler);
    }

    expect(detail).toEqual({
      action: 'exit',
      guideId: 'add-member',
      threadId: 'thread-1',
    });
  });

  it('dispatches guide:complete with guideId and threadId', () => {
    let detail: Record<string, unknown> | undefined;
    const handler = (event: Event) => {
      detail = (event as CustomEvent<Record<string, unknown>>).detail;
    };
    window.addEventListener('guide:complete', handler);

    try {
      captured!.onGuideComplete!({
        guideId: 'add-member',
        threadId: 'thread-1',
        timestamp: Date.now(),
      });
    } finally {
      window.removeEventListener('guide:complete', handler);
    }

    expect(detail).toEqual({
      guideId: 'add-member',
      threadId: 'thread-1',
    });
  });
});
