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

function snapshot(id: string, etag?: string): Response {
  return new Response(
    JSON.stringify({
      threads: [{ id, title: id, projectPath: 'default', participants: [], lastActiveAt: Date.now() }],
    }),
    { status: 200, headers: etag ? { etag } : undefined },
  );
}

function notModified(etag: string): Response {
  return new Response(null, { status: 304, headers: { etag } });
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

  it('keeps conditional invalidations to one active and one trailing observation', async () => {
    const etag = '"sidebar-seed"';
    const unchanged = [deferred<Response>(), deferred<Response>()];
    const conditionalHeaders: Array<string | null> = [];
    let businessCalls = 0;
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response('{}'));
      conditionalHeaders.push(new Headers(init?.headers).get('if-none-match'));
      businessCalls += 1;
      if (businessCalls === 1) return Promise.resolve(snapshot('seed', etag));
      return unchanged[businessCalls - 2]?.promise ?? Promise.reject(new Error('unexpected generation'));
    }) as typeof fetch;

    await expect(refreshSidebarThreadSnapshot()).resolves.toBe(true);
    const current = invalidateSidebarProjection();
    await vi.waitFor(() => expect(businessCalls).toBe(2));
    const firstTrailing = invalidateSidebarProjection();
    const secondTrailing = invalidateSidebarProjection();

    unchanged[0]?.resolve(notModified(etag));
    await vi.waitFor(() => expect(businessCalls).toBe(3));
    unchanged[1]?.resolve(notModified(etag));

    await expect(Promise.all([current, firstTrailing, secondTrailing])).resolves.toEqual([true, true, true]);
    expect(conditionalHeaders).toEqual([null, etag, etag]);
    expect(mockSetThreads).toHaveBeenCalledTimes(1);
    expect(useSidebarProjectionStore.getState().rows[0]?.id).toBe('seed');
  });

  it('keeps one coordination key while the conditional validator rolls forward', async () => {
    const etag1 = '"sidebar-e1"';
    const etag2 = '"sidebar-e2"';
    const generations = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
    const conditionalHeaders: Array<string | null> = [];
    let businessCalls = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    globalThis.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('/api/session')) return Promise.resolve(new Response('{}'));
      const callIndex = businessCalls++;
      conditionalHeaders.push(new Headers(init?.headers).get('if-none-match'));
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const response =
        callIndex === 0
          ? Promise.resolve(snapshot('seed', etag1))
          : (generations[callIndex - 1]?.promise ?? Promise.reject(new Error('unexpected generation')));
      return response.finally(() => {
        inFlight -= 1;
      });
    }) as typeof fetch;

    await expect(refreshSidebarThreadSnapshot()).resolves.toBe(true);

    const changing = invalidateSidebarProjection();
    await vi.waitFor(() => expect(businessCalls).toBe(2));
    const firstTrailing = invalidateSidebarProjection();
    generations[0]?.resolve(snapshot('changed', etag2));
    await vi.waitFor(() => expect(businessCalls).toBe(3));

    const secondTrailing = invalidateSidebarProjection();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const callsBeforeCurrentSettled = businessCalls;

    const currentValidator = conditionalHeaders[2];
    generations[1]?.resolve(currentValidator === etag2 ? notModified(etag2) : snapshot('changed', etag2));
    await vi.waitFor(() => expect(businessCalls).toBe(4));
    generations[2]?.resolve(notModified(etag2));

    await expect(Promise.all([changing, firstTrailing, secondTrailing])).resolves.toEqual([true, true, true]);
    expect(callsBeforeCurrentSettled).toBe(3);
    expect(maxInFlight).toBe(1);
    expect(conditionalHeaders).toEqual([null, etag1, etag1, etag2]);
    expect(mockSetThreads).toHaveBeenCalledTimes(2);
    expect(useSidebarProjectionStore.getState().rows[0]?.id).toBe('changed');
  });
});
