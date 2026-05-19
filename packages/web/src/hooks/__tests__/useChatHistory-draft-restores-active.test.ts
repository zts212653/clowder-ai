/**
 * Fix: /queue idle + /messages returns isDraft assistant → hasActiveInvocation must be restored.
 *
 * Root cause: /queue (lightweight) returns before /messages (heavier). When /queue
 * reports idle, it clears hasActiveInvocation and persists to IDB. Then /messages
 * returns draft messages with isStreaming: true but never restores hasActiveInvocation.
 * Result: cancel button disappears because ChatInputActionButton sees
 * hasActiveInvocation=false even though a cat is actively streaming.
 */
import 'fake-indexeddb/auto';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { _resetDBForTest } from '@/utils/offline-store';
import { useChatHistory } from '../useChatHistory';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

function HookHost({ threadId }: { threadId: string }) {
  useChatHistory(threadId);
  return null;
}

describe('/queue idle + /messages draft → hasActiveInvocation restored (cancel button fix)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const apiFetchMock = vi.mocked(apiFetch);

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(async () => {
    await _resetDBForTest();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    useChatStore.setState({
      messages: [],
      isLoading: false,
      isLoadingHistory: false,
      hasMore: true,
      hasActiveInvocation: false,
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      catInvocations: {},
      currentGame: null,
      activeInvocations: {},

      threadStates: {},
      currentThreadId: 'thread-draft',
      viewMode: 'single',
      splitPaneThreadIds: [],
      splitPaneTargetId: null,
      currentProjectPath: 'default',
      threads: [],
      isLoadingThreads: false,
      queue: [],
      queuePaused: false,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    apiFetchMock.mockReset();
  });

  it('/queue returns idle, /messages returns draft assistant → hasActiveInvocation=true + synthetic slot', async () => {
    const draftMessage = {
      id: 'draft-msg-1',
      threadId: 'thread-draft',
      role: 'assistant',
      content: 'I am thinking about...',
      catId: 'opus-47',
      isDraft: true,
      timestamp: Date.now(),
    };

    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/queue')) {
        // /queue returns idle — no active invocations
        return Promise.resolve(
          new Response(JSON.stringify({ queue: [], paused: false, activeInvocations: [] }), { status: 200 }),
        );
      }
      if (typeof url === 'string' && url.includes('/messages')) {
        // /messages returns a draft assistant message — cat is still streaming
        return Promise.resolve(
          new Response(
            JSON.stringify({
              messages: [draftMessage],
              hasMore: false,
              tasks: [],
            }),
            { status: 200 },
          ),
        );
      }
      // task-progress, tasks, etc.
      return Promise.resolve(new Response(JSON.stringify({ tasks: [] }), { status: 200 }));
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-draft' }));
    });

    // Settle async work: fetchQueue + fetchHistory + IDB restore
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    const state = useChatStore.getState();

    // The draft message should have been hydrated with isStreaming: true
    expect(state.messages.some((m) => m.isStreaming)).toBe(true);

    // hasActiveInvocation must be restored despite /queue saying idle
    expect(state.hasActiveInvocation).toBe(true);

    // A synthetic active invocation slot must exist for the drafting cat
    const slots = Object.values(state.activeInvocations);
    expect(slots.length).toBeGreaterThanOrEqual(1);
    expect(slots.some((s) => s.catId === 'opus-47')).toBe(true);
  });

  it('P1 regression: draft-restored slot is clearable by terminal cleanup (hydrated-* orphan sweep)', async () => {
    const draftMessage = {
      id: 'draft-msg-2',
      threadId: 'thread-draft',
      role: 'assistant',
      content: 'Working on it...',
      catId: 'opus-47',
      isDraft: true,
      timestamp: Date.now(),
    };

    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/queue')) {
        return Promise.resolve(
          new Response(JSON.stringify({ queue: [], paused: false, activeInvocations: [] }), { status: 200 }),
        );
      }
      if (typeof url === 'string' && url.includes('/messages')) {
        return Promise.resolve(
          new Response(JSON.stringify({ messages: [draftMessage], hasMore: false, tasks: [] }), { status: 200 }),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ tasks: [] }), { status: 200 }));
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-draft' }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    // Precondition: draft restored an active slot
    const before = useChatStore.getState();
    expect(before.hasActiveInvocation).toBe(true);
    const slotEntries = Object.entries(before.activeInvocations);
    expect(slotEntries.length).toBe(1);
    const [slotKey] = slotEntries[0]!;

    // Simulate terminal cleanup: find orphan for catId, check hydrated-* prefix, remove.
    // This mirrors useAgentMessages.ts lines 3888-3893.
    expect(slotKey.startsWith('hydrated-')).toBe(true);
    useChatStore.getState().removeActiveInvocation(slotKey);

    const after = useChatStore.getState();
    expect(Object.keys(after.activeInvocations).length).toBe(0);
  });

  it('control: /queue idle + /messages returns NO drafts → hasActiveInvocation stays false', async () => {
    const normalMessage = {
      id: 'msg-1',
      threadId: 'thread-draft',
      role: 'assistant',
      content: 'Completed response.',
      catId: 'opus-47',
      isDraft: false,
      timestamp: Date.now(),
    };

    apiFetchMock.mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/queue')) {
        return Promise.resolve(
          new Response(JSON.stringify({ queue: [], paused: false, activeInvocations: [] }), { status: 200 }),
        );
      }
      if (typeof url === 'string' && url.includes('/messages')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              messages: [normalMessage],
              hasMore: false,
              tasks: [],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify({ tasks: [] }), { status: 200 }));
    });

    await act(async () => {
      root.render(React.createElement(HookHost, { threadId: 'thread-draft' }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    const state = useChatStore.getState();

    // No drafts → no streaming
    expect(state.messages.some((m) => m.isStreaming)).toBe(false);

    // hasActiveInvocation must remain false
    expect(state.hasActiveInvocation).toBe(false);
    expect(Object.keys(state.activeInvocations)).toEqual([]);
  });
});
