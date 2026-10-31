/**
 * Tests that processCommand uses overrideThreadId when provided,
 * rather than falling back to currentThreadId from the store.
 *
 * Covers the R2 P1-2 fix: command path ignores split target thread.
 */
import React, { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Capture apiFetch calls ──
const mockApiFetch = vi.fn();

vi.mock('@/utils/api-client', () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({
    cats: [
      { id: 'opus', displayName: '布偶猫', mentionPatterns: ['@opus', '@布偶猫', '@布偶'] },
      { id: 'codex', displayName: '缅因猫', mentionPatterns: ['@codex', '@缅因猫', '@缅因'] },
      { id: 'gemini', displayName: '暹罗猫', mentionPatterns: ['@gemini', '@暹罗猫', '@暹罗'] },
    ],
    getCatById: () => undefined,
    getCatsByBreed: () => new Map(),
  }),
}));

vi.mock('@/utils/userId', () => ({
  getUserId: () => 'test-user',
}));

// ── Mock chatStore with a known currentThreadId ──
// Note: vi.mock is hoisted, so values must be inlined (no top-level refs)
vi.mock('@/stores/chatStore', () => {
  const addMessage = vi.fn();
  const addMessageToThread = vi.fn();
  const state = {
    currentThreadId: 'store-current-thread',
    addMessage,
    addMessageToThread,
  };
  const hook = Object.assign((selector?: (s: typeof state) => unknown) => (selector ? selector(state) : state), {
    getState: () => state,
  });
  return { useChatStore: hook };
});

import { useChatCommands } from '@/hooks/useChatCommands';
import { useChatStore } from '@/stores/chatStore';

/**
 * Thin component that extracts processCommand and invokes it
 * with the provided args on mount.
 */
function CommandRunner({
  input,
  overrideThreadId,
  onDone,
}: {
  input: string;
  overrideThreadId?: string;
  onDone: (result: boolean) => void;
}) {
  const { processCommand } = useChatCommands();
  const called = useRef(false);

  useEffect(() => {
    if (called.current) return;
    called.current = true;
    processCommand(input, overrideThreadId).then(onDone);
  }, [input, overrideThreadId, onDone, processCommand]);

  return null;
}

describe('processCommand overrideThreadId (P1-2 R2)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
  });

  beforeEach(() => {
    mockApiFetch.mockReset();
    const state = useChatStore.getState() as unknown as {
      currentThreadId: string;
      addMessage: ReturnType<typeof vi.fn>;
      addMessageToThread: ReturnType<typeof vi.fn>;
    };
    state.currentThreadId = 'store-current-thread';
    state.addMessage.mockClear();
    state.addMessageToThread.mockClear();
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

  it('/remember uses overrideThreadId in API call, not store currentThreadId', async () => {
    const OVERRIDE_THREAD = 'split-pane-target-thread';
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    let result: boolean | undefined;

    await act(async () => {
      root.render(
        React.createElement(CommandRunner, {
          input: '/remember mykey myvalue',
          overrideThreadId: OVERRIDE_THREAD,
          onDone: (r: boolean) => {
            result = r;
          },
        }),
      );
    });

    expect(result).toBe(true);
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/memory',
      expect.objectContaining({
        method: 'POST',
      }),
    );

    // Parse the body to verify threadId
    const callArgs = mockApiFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.threadId).toBe(OVERRIDE_THREAD);
    expect(body.threadId).not.toBe('store-current-thread');
    expect(body.key).toBe('mykey');
    expect(body.value).toBe('myvalue');
    const store = useChatStore.getState() as unknown as {
      addMessage: ReturnType<typeof vi.fn>;
      addMessageToThread: ReturnType<typeof vi.fn>;
    };
    expect(store.addMessageToThread).toHaveBeenCalledWith(OVERRIDE_THREAD, expect.objectContaining({ type: 'user' }));
    expect(store.addMessage).not.toHaveBeenCalled();
  });

  it('/remember keeps its async result on the captured override after the flat selection changes', async () => {
    let resolveFetch!: (value: { ok: true; json: () => Promise<object> }) => void;
    mockApiFetch.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const state = useChatStore.getState() as unknown as {
      currentThreadId: string;
      addMessage: ReturnType<typeof vi.fn>;
      addMessageToThread: ReturnType<typeof vi.fn>;
    };
    state.addMessage.mockClear();
    state.addMessageToThread.mockClear();

    await act(async () => {
      root.render(
        React.createElement(CommandRunner, {
          input: '/remember key value',
          overrideThreadId: 'thread-A',
          onDone: () => {},
        }),
      );
      await Promise.resolve();
    });
    state.currentThreadId = 'thread-B';

    await act(async () => {
      resolveFetch({ ok: true, json: async () => ({}) });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(state.addMessageToThread.mock.calls.every(([threadId]) => threadId === 'thread-A')).toBe(true);
    expect(state.addMessage).not.toHaveBeenCalled();
  });

  it('/remember without override falls back to store currentThreadId', async () => {
    mockApiFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    let result: boolean | undefined;

    await act(async () => {
      root.render(
        React.createElement(CommandRunner, {
          input: '/remember foo bar',
          onDone: (r: boolean) => {
            result = r;
          },
        }),
      );
    });

    expect(result).toBe(true);

    const callArgs = mockApiFetch.mock.calls[0];
    const body = JSON.parse(callArgs[1].body as string);
    expect(body.threadId).toBe('store-current-thread');
  });
});
