import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { DEFAULT_THREAD_STATE, useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { acknowledgeThreadHistoryWatermark, useThreadHistoryReconciliation } from '../thread-history-watermark';
import { __resetTaskCacheForTest, useChatHistory } from '../useChatHistory';

vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn() }));
vi.mock('@/utils/offline-store', () => ({
  loadThreadMessages: vi.fn().mockResolvedValue(null),
  loadThreadActiveState: vi.fn().mockResolvedValue(null),
  loadThreadWorkspaceState: vi.fn().mockResolvedValue(null),
  saveThreadMessages: vi.fn().mockResolvedValue(undefined),
  saveThreadActiveState: vi.fn().mockResolvedValue(undefined),
}));

function Probe({ threads }: { threads: string }) {
  useThreadHistoryReconciliation(threads);
  return null;
}

function History({ threadId }: { threadId: string }) {
  useChatHistory(threadId);
  return <Probe threads={threadId} />;
}

describe('quiet foreground History reconciliation', () => {
  let root: Root;
  let container: HTMLDivElement;
  let threadId: string;
  let counter = 0;
  const fetch = vi.mocked(apiFetch);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    threadId = `watermark-${++counter}`;
    __resetTaskCacheForTest();
    acknowledgeThreadHistoryWatermark(threadId, null);
    useChatStore.setState({
      currentThreadId: threadId,
      messages: [],
      hasActiveInvocation: false,
      isLoadingHistory: false,
      intentMode: null,
      targetCats: [],
      catStatuses: {},
      threadStates: {},
      streamCatchUpVersionByThread: {},
    });
    fetch.mockImplementation(async () => new Response(JSON.stringify({ watermark: 'position-1' })));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    fetch.mockReset();
  });

  const render = async (threads = threadId) => {
    await act(async () => root.render(<Probe threads={threads} />));
  };
  const tick = async () => {
    // Each request owns its response body.
    fetch.mockImplementation(async () => new Response(JSON.stringify({ watermark: 'position-1' })));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
  };
  const catchUps = (id = threadId) => useChatStore.getState().streamCatchUpVersionByThread[id] ?? 0;

  it('checks a revisited cached thread immediately and keeps unchanged watermarks quiet', async () => {
    acknowledgeThreadHistoryWatermark(threadId, 'position-1');
    await render('another-thread');
    await render();
    expect(fetch.mock.calls.some(([url]) => String(url).includes(threadId))).toBe(true);
    expect(catchUps()).toBe(0);
    await tick();
    expect(catchUps()).toBe(0);
  });

  it('finds a missed final on the next 30s tick without local active or unread state', async () => {
    acknowledgeThreadHistoryWatermark(threadId, 'position-1');
    await render();
    fetch.mockResolvedValue(new Response(JSON.stringify({ watermark: 'position-2' })));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(catchUps()).toBe(1);
  });

  it('only a successfully applied History watermark stops repeated recovery requests', async () => {
    acknowledgeThreadHistoryWatermark(threadId, 'position-0');
    await render();
    expect(catchUps()).toBe(1);
    await tick();
    expect(catchUps()).toBe(2);
    acknowledgeThreadHistoryWatermark(threadId, undefined);
    await tick();
    expect(catchUps()).toBe(3);
    acknowledgeThreadHistoryWatermark(threadId, 'position-1');
    await tick();
    expect(catchUps()).toBe(3);
  });

  it('does not poll a hidden page or a thread whose History or live response is loading', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await render();
    await tick();
    expect(fetch).not.toHaveBeenCalled();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    useChatStore.setState({ isLoadingHistory: true });
    await tick();
    expect(fetch).not.toHaveBeenCalled();
    useChatStore.setState({ isLoadingHistory: false, hasActiveInvocation: true });
    await tick();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('checks only foreground panes, leaving cached background threads alone', async () => {
    useChatStore.setState({ threadStates: { background: { ...DEFAULT_THREAD_STATE } } });
    acknowledgeThreadHistoryWatermark('second-pane', null);
    await render(`${threadId}\0second-pane`);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.some(([url]) => String(url).includes('background'))).toBe(false);
    expect(catchUps(threadId)).toBe(1);
    expect(catchUps('second-pane')).toBe(1);
  });

  it('leaves failed probes retryable on the next tick', async () => {
    fetch.mockResolvedValue(new Response('', { status: 503 }));
    await render();
    expect(catchUps()).toBe(0);
    await tick();
    expect(catchUps()).toBe(1);
  });

  it('leaves an unknown baseline to initial History hydration', async () => {
    await render(`${threadId}-unknown`);
    await tick();
    expect(fetch).not.toHaveBeenCalled();
    expect(catchUps(`${threadId}-unknown`)).toBe(0);
  });

  it('acknowledges a successful History page even when its semantic tail is suppressed', async () => {
    fetch.mockImplementation(async (url) => {
      if (String(url).endsWith('/watermark')) return new Response(JSON.stringify({ watermark: 'position-1' }));
      return new Response(
        JSON.stringify({
          messages: [
            {
              id: 'hidden-goal',
              type: 'system',
              content: 'raw goal',
              timestamp: 100,
              extra: {
                semanticEvent: {
                  v: 1,
                  id: 'goal-1',
                  kind: 'goal',
                  occurredAt: 100,
                  state: 'updated',
                  revision: 1,
                  objective: 'Ship',
                  source: 'codex_app_server',
                  observedAt: 100,
                },
              },
            },
          ],
          historyWatermark: 'position-1',
          hasMore: false,
          queue: [],
          activeInvocations: [],
          tasks: [],
        }),
      );
    });
    await act(async () => {
      root.render(
        <ThreadChatHistoryAdmissionProvider>
          <History threadId={threadId} />
        </ThreadChatHistoryAdmissionProvider>,
      );
    });
    expect(useChatStore.getState().messages).toEqual([]);
    expect(useChatStore.getState().isLoadingHistory).toBe(false);
    const beforeTick = catchUps();
    await tick();
    expect(catchUps()).toBe(beforeTick);
  });
});
