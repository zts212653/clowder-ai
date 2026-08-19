import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useVoiceInput', () => ({
  useVoiceInput: () => ({
    state: 'idle',
    transcript: '',
    partialTranscript: '',
    error: null,
    duration: 0,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
  }),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: () => ({
    targetCats: ['codex', 'gemini'],
    catStatuses: { codex: 'streaming', gemini: 'pending' },
    catInvocations: {},
    activeInvocations: { 'inv-exact': { catId: 'codex', mode: 'ideate' } },
    hasActiveInvocation: true,
    intentMode: 'ideate',
  }),
}));

vi.mock('@/hooks/useCatData', () => ({
  useCatData: () => ({ getCatById: () => undefined }),
}));

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

import { ChatInputActionButton } from '@/components/ChatInputActionButton';
import { ParallelStatusBar } from '@/components/ParallelStatusBar';
import { activeExecutionKey, useActiveExecutionStore } from '@/stores/activeExecutionStore';
import { apiFetch } from '@/utils/api-client';

describe('Stop event payload regression', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    useActiveExecutionStore.getState().reset();
    vi.mocked(apiFetch).mockReset();
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

  it('ChatInputActionButton invokes canonical cancellation without a legacy socket intent', () => {
    const onStop = vi.fn();

    act(() => {
      root.render(
        React.createElement(ChatInputActionButton, {
          onTranscript: vi.fn(),
          onSend: vi.fn(),
          onStop,
          disabled: true,
          hasActiveInvocation: true,
          hasText: false,
        }),
      );
    });

    const stopBtn = container.querySelector('button[aria-label="Stop generation"]');
    expect(stopBtn).toBeTruthy();

    act(() => {
      stopBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });

    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStop.mock.calls[0]).toEqual([]);
  });

  it('ParallelStatusBar cancels canonical executions once instead of emitting a legacy socket Stop', async () => {
    const execution = {
      executionId: 'inv-exact',
      threadId: 'thread-test',
      threadTitle: 'Parallel thread',
      catId: 'codex',
      kind: 'live_invocation' as const,
      startedAt: 1,
      cancelability: {
        state: 'cancelable' as const,
        target: {
          kind: 'live_invocation' as const,
          threadId: 'thread-test',
          catId: 'codex',
          executionId: 'inv-exact',
        },
      },
    };
    useActiveExecutionStore.setState({
      anchorThreadId: 'thread-test',
      projectPath: '/test',
      executionsByKey: { [activeExecutionKey(execution)]: execution },
      hydration: 'ready',
      hydrationError: null,
    });
    let releaseCancel: ((response: Response) => void) | undefined;
    const cancelResponse = new Promise<Response>((resolve) => {
      releaseCancel = resolve;
    });
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
      if (url.includes('/cancel')) return cancelResponse;
      return new Response(JSON.stringify({ projectPath: '/test', executions: [] }), { status: 200 });
    });

    act(() => {
      root.render(React.createElement(ParallelStatusBar, { threadId: 'thread-test' }));
    });

    const stopBtn = container.querySelector('[data-testid="parallel-stop-button"]') as HTMLButtonElement | null;
    expect(stopBtn).toBeTruthy();
    expect(stopBtn?.disabled).toBe(false);

    await act(async () => {
      stopBtn?.click();
      stopBtn?.click();
      await Promise.resolve();
    });

    expect(stopBtn?.disabled).toBe(true);
    expect(vi.mocked(apiFetch).mock.calls.filter(([url]) => String(url).includes('/cancel'))).toHaveLength(1);
    expect(apiFetch).toHaveBeenCalledWith('/api/threads/thread-test/executions/live/inv-exact/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ catId: 'codex' }),
    });

    releaseCancel?.(new Response('{}', { status: 200 }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('ParallelStatusBar exposes only a disabled state without an exact execution target', () => {
    act(() => {
      root.render(React.createElement(ParallelStatusBar, { threadId: 'thread-test' }));
    });

    const stopBtn = container.querySelector('[data-testid="parallel-stop-button"]') as HTMLButtonElement | null;
    expect(stopBtn?.disabled).toBe(true);
    expect(stopBtn?.textContent).toContain('暂不可停止');
    act(() => stopBtn?.click());
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
