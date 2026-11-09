import EventEmitter from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { CatId } from '@cat-cafe/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThreadChatHistoryAdmissionProvider } from '@/components/thread-chat/ThreadChatRuntimeProvider';
import { DEFAULT_THREAD_STATE, useChatStore } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import Fastify from '../../../../api/node_modules/fastify/fastify.js';
import { useThreadHistoryReconciliation } from '../thread-history-watermark';
import { useChatHistory } from '../useChatHistory';
import { useSocket } from '../useSocket';

// Load the built server natively: Vite's browser Worker transform cannot run its OS modules.
const apiRequire = createRequire(resolve(__dirname, '../../../../api/package.json'));
const { MessageStore } = apiRequire(
  './dist/domains/cats/services/stores/ports/MessageStore.js',
) as typeof import('../../../../api/dist/domains/cats/services/stores/ports/MessageStore.js');
const { ThreadStore } = apiRequire(
  './dist/domains/cats/services/stores/ports/ThreadStore.js',
) as typeof import('../../../../api/dist/domains/cats/services/stores/ports/ThreadStore.js');
const { messagesRoutes } = apiRequire(
  './dist/routes/messages.js',
) as typeof import('../../../../api/dist/routes/messages.js');

const socket = Object.assign(new EventEmitter(), {
  id: 'quiet-test-socket',
  connected: true,
  disconnect: vi.fn(),
  io: { engine: { transport: { name: 'websocket' }, on: vi.fn() } },
});
vi.mock('socket.io-client', () => ({ io: () => socket }));
vi.mock('@/utils/userId', () => ({ getUserId: () => 'owner' }));
vi.mock('@/utils/api-client', () => ({ apiFetch: vi.fn(), API_URL: '', refreshApiSession: vi.fn() }));
vi.mock('@/utils/offline-store', () => ({
  loadThreadMessages: vi.fn().mockResolvedValue(null),
  loadThreadActiveState: vi.fn().mockResolvedValue(null),
  loadThreadWorkspaceState: vi.fn().mockResolvedValue(null),
  saveThreadMessages: vi.fn().mockResolvedValue(undefined),
  saveThreadActiveState: vi.fn().mockResolvedValue(undefined),
}));

function History({ threadId, live = false }: { threadId: string; live?: boolean }) {
  const history = useChatHistory(threadId);
  useThreadHistoryReconciliation(threadId);
  return (
    <>
      <div data-testid="history" ref={history.scrollContainerRef} onScroll={history.handleScroll} />
      {live && <Socket threadId={threadId} />}
    </>
  );
}
function Socket({ threadId }: { threadId: string }) {
  useSocket({ onMessage: () => {} }, threadId);
  return null;
}

describe('quiet recovery with the actual History route and chat store', () => {
  let app: ReturnType<typeof Fastify>;
  let store: InstanceType<typeof MessageStore>;
  let root: Root;
  let container: HTMLDivElement;
  let threadId: string;
  let serial = 0;
  const fetch = vi.mocked(apiFetch);

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    threadId = `actual-quiet-${++serial}`;
    socket.removeAllListeners();
    store = new MessageStore();
    const threads = new ThreadStore();
    threads.ensureThread(threadId, 'Fixture').createdBy = 'owner';
    app = Fastify();
    await app.register(messagesRoutes, {
      messageStore: store,
      threadStore: threads,
      router: {} as never,
      registry: {} as never,
      socketManager: {} as never,
    });
    fetch.mockImplementation(async (url) => {
      const path = String(url);
      if (path.startsWith('/api/messages?') || path.includes('/watermark')) {
        const response = await app.inject({ url: path, headers: { 'x-cat-cafe-user': 'owner' } });
        return new Response(response.body, { status: response.statusCode });
      }
      return new Response(JSON.stringify({ activeInvocations: [], queue: [], tasks: [] }));
    });
    useChatStore.setState({
      ...DEFAULT_THREAD_STATE,
      currentThreadId: threadId,
      threadStates: {},
      streamCatchUpVersionByThread: {},
      lastConsumedCatchUpVersionByThread: {},
    });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    act(() => root.unmount());
    await app.close();
    container.remove();
    fetch.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const append = (content: string, timestamp = Date.now()) =>
    store.append({
      threadId,
      from: { kind: 'user', userId: 'owner' },
      userId: 'owner',
      content,
      mentions: [],
      timestamp,
    });
  const render = async (live = false) =>
    act(async () =>
      root.render(
        <ThreadChatHistoryAdmissionProvider>
          <History threadId={threadId} live={live} />
        </ThreadChatHistoryAdmissionProvider>,
      ),
    );

  it('applies both finals outside the latest 50 and retains the older-page boundary', async () => {
    const responses = [1, 2].map(
      (n) =>
        store.appendAndObservePriorFrontier({
          threadId,
          userId: 'owner',
          from: { kind: 'agent', catId: 'opus' as CatId },
          content: '',
          mentions: [],
          timestamp: 1100 + n,
          origin: 'stream',
          lifecycle: {
            kind: 'response',
            orderKey: `order-${n}`,
            invocationId: `child-${n}`,
            targetId: 'opus',
            inputEntryIds: ['entry'],
            inputMessageIds: ['input'],
            status: 'processing',
            startedAt: 1100 + n,
          },
        }).message,
    );
    Array.from({ length: 60 }, (_, n) => append(`newer ${n}`, 2000 + n));
    await render();
    expect(useChatStore.getState().messages).toHaveLength(50);
    responses.forEach((response, n) =>
      store.commitLifecycleResponseTerminal(response.id, {
        invocationId: `child-${n + 1}`,
        status: 'completed',
        completedAt: Date.now(),
        content: `complete ${n + 1}`,
        mentions: [],
        origin: 'stream',
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(31_000));
    expect(useChatStore.getState().streamCatchUpVersionByThread[threadId]).toBeGreaterThan(0);
    // React commits the version effect at the act boundary; then its 600ms debounce runs.
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    responses.forEach((response, n) =>
      expect(
        useChatStore.getState().messages.filter((m) => m.id === response.id && m.content === `complete ${n + 1}`),
      ).toHaveLength(1),
    );
    await act(async () => {
      container.querySelector('[data-testid="history"]')!.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    Array.from({ length: 60 }, (_, n) =>
      expect(useChatStore.getState().messages.some((m) => m.content === `newer ${n}`)).toBe(true),
    );
    const consumed = useChatStore.getState().streamCatchUpVersionByThread[threadId];
    await act(async () => vi.advanceTimersByTimeAsync(90_000));
    expect(useChatStore.getState().streamCatchUpVersionByThread[threadId]).toBe(consumed);
  });

  it('recovers a processing event followed by a queue 503 without creating a slot', async () => {
    append('waiting');
    await render(true);
    const normalFetch = fetch.getMockImplementation()!;
    let failed = false;
    fetch.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith('/queue') && !failed) {
        failed = true;
        return new Response('', { status: 503 });
      }
      return normalFetch(...args);
    });
    await act(async () => {
      socket.emit('queue_updated', { threadId, action: 'processing', queue: [] });
    });
    expect(failed).toBe(true);
    expect(useChatStore.getState().hasActiveInvocation).toBe(true);
    expect(useChatStore.getState().activeInvocations).toEqual({});
    const before = fetch.mock.calls.filter(([url]) => String(url).endsWith('/queue')).length;
    await act(async () => vi.advanceTimersByTimeAsync(31_000));
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('/queue')).length).toBeGreaterThan(before);
    expect(useChatStore.getState().hasActiveInvocation).toBe(false);
    expect(useChatStore.getState().streamCatchUpVersionByThread[threadId]).toBeGreaterThan(0);
  });
});
