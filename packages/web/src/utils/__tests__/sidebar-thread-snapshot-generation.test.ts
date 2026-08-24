import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSetThreads = vi.fn();
const mockInitThreadUnread = vi.fn();
const mockSetLoadingThreads = vi.fn();

vi.mock('@/utils/offline-store', () => ({
  loadSidebarSnapshot: () => Promise.resolve(null),
  saveSidebarSnapshot: () => Promise.resolve(),
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      setThreads: mockSetThreads,
      initThreadUnread: mockInitThreadUnread,
      setLoadingThreads: mockSetLoadingThreads,
    }),
  },
}));

import { useSidebarProjectionStore } from '@/stores/sidebarProjectionStore';
import {
  __resetSidebarRefreshForTests,
  invalidateSidebarProjection,
  refreshSidebarThreadSnapshot,
} from '../sidebar-thread-snapshot';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function snapshot(id: string): Response {
  return new Response(
    JSON.stringify({
      threads: [{ id, title: id, projectPath: 'default', participants: [], lastActiveAt: Date.now() }],
    }),
    { status: 200 },
  );
}

describe('sidebar snapshot callers sharing a real apiFetch generation', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetSidebarRefreshForTests();
    useSidebarProjectionStore.setState({
      rows: [],
      appliedGeneration: 0,
      hasCanonicalSnapshot: false,
      pendingThreadCommands: {},
      refreshing: false,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('reports success to every ordinary caller sharing one applied generation', async () => {
    const business = deferred<Response>();
    let businessCalls = 0;
    globalThis.fetch = vi.fn((url: string) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response('{}'));
      businessCalls += 1;
      return business.promise;
    }) as typeof fetch;

    const first = refreshSidebarThreadSnapshot();
    const second = refreshSidebarThreadSnapshot();
    await vi.waitFor(() => expect(businessCalls).toBe(1));
    business.resolve(snapshot('ordinary'));

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(useSidebarProjectionStore.getState().rows[0]?.id).toBe('ordinary');
  });

  it('reports success to every invalidator sharing one trailing generation', async () => {
    const generations = [deferred<Response>(), deferred<Response>()];
    let businessCalls = 0;
    globalThis.fetch = vi.fn((url: string) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response('{}'));
      return generations[businessCalls++]?.promise ?? Promise.reject(new Error('unexpected generation'));
    }) as typeof fetch;

    const current = refreshSidebarThreadSnapshot();
    await vi.waitFor(() => expect(businessCalls).toBe(1));
    const firstInvalidation = invalidateSidebarProjection();
    const secondInvalidation = invalidateSidebarProjection();

    generations[0]?.resolve(snapshot('current'));
    await vi.waitFor(() => expect(businessCalls).toBe(2));
    generations[1]?.resolve(snapshot('trailing'));

    await expect(Promise.all([current, firstInvalidation, secondInvalidation])).resolves.toEqual([true, true, true]);
    expect(useSidebarProjectionStore.getState().rows[0]?.id).toBe('trailing');
  });
});
