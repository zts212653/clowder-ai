import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAuthorizationCacheForTest, type AuthPendingRequest, useAuthorization } from '@/hooks/useAuthorization';
import { apiFetch } from '@/utils/api-client';

vi.mock('@/utils/api-client', () => ({
  apiFetch: vi.fn(),
}));

Object.assign(globalThis as Record<string, unknown>, { React });

describe('useAuthorization per-thread cache', () => {
  let container: HTMLDivElement;
  let root: Root;
  let pendingSnapshot: AuthPendingRequest[] = [];
  const apiFetchMock = vi.mocked(apiFetch);

  beforeAll(() => {
    (globalThis as { React?: typeof React }).React = React;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const MockNotification = vi.fn().mockImplementation(function (this: Record<string, unknown>) {
      this.onclick = null;
      this.close = vi.fn();
    });
    Object.assign(MockNotification, {
      permission: 'denied',
      requestPermission: vi.fn().mockResolvedValue('denied'),
    });
    Object.defineProperty(globalThis, 'Notification', {
      value: MockNotification,
      writable: true,
      configurable: true,
    });
  });

  afterAll(() => {
    delete (globalThis as { React?: typeof React }).React;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    pendingSnapshot = [];
    __resetAuthorizationCacheForTest();
    apiFetchMock.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.removeChild(container);
  });

  function HookCapture({ threadId }: { threadId: string }) {
    const { pending } = useAuthorization(threadId);
    pendingSnapshot = pending;
    return null;
  }

  it('reuses cached pending requests immediately when revisiting a thread', async () => {
    let resolveThreadARevisit!: (value: {
      ok: boolean;
      json: () => Promise<{ pending: AuthPendingRequest[] }>;
    }) => void;
    const threadARevisit = new Promise<{ ok: boolean; json: () => Promise<{ pending: AuthPendingRequest[] }> }>(
      (resolve) => {
        resolveThreadARevisit = resolve;
      },
    );
    const pendingByThread = new Map<string, AuthPendingRequest[][]>([
      [
        'thread-a',
        [
          [
            {
              requestId: 'req-a',
              catId: 'opus',
              threadId: 'thread-a',
              action: 'file_write',
              reason: 'Need to write file A',
              createdAt: 1,
            },
          ],
        ],
      ],
      [
        'thread-b',
        [
          [
            {
              requestId: 'req-b',
              catId: 'codex',
              threadId: 'thread-b',
              action: 'file_write',
              reason: 'Need to write file B',
              createdAt: 2,
            },
          ],
        ],
      ],
    ]);
    const requestCounts = new Map<string, number>();

    apiFetchMock.mockImplementation((url: string) => {
      const parsed = new URL(url, 'http://localhost');
      const nextThreadId = parsed.searchParams.get('threadId');
      if (!nextThreadId) {
        throw new Error(`missing threadId in mock url: ${url}`);
      }
      const nextCount = (requestCounts.get(nextThreadId) ?? 0) + 1;
      requestCounts.set(nextThreadId, nextCount);

      if (nextThreadId === 'thread-a' && nextCount === 2) {
        return threadARevisit as never;
      }

      const pending = pendingByThread.get(nextThreadId)?.[0] ?? [];
      return Promise.resolve({
        ok: true,
        json: async () => ({ pending }),
      }) as never;
    });

    await act(async () => {
      root.render(React.createElement(HookCapture, { threadId: 'thread-a' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pendingSnapshot.map((req) => req.requestId)).toEqual(['req-a']);

    await act(async () => {
      root.render(React.createElement(HookCapture, { threadId: 'thread-b' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pendingSnapshot.map((req) => req.requestId)).toEqual(['req-b']);

    await act(async () => {
      root.render(React.createElement(HookCapture, { threadId: 'thread-a' }));
      await Promise.resolve();
    });
    expect(pendingSnapshot.map((req) => req.requestId)).toEqual(['req-a']);

    resolveThreadARevisit({
      ok: true,
      json: async () => ({
        pending: [
          {
            requestId: 'req-a2',
            catId: 'opus',
            threadId: 'thread-a',
            action: 'file_write',
            reason: 'Need to write file A2',
            createdAt: 3,
          },
        ],
      }),
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pendingSnapshot.map((req) => req.requestId)).toEqual(['req-a2']);
  });
});
