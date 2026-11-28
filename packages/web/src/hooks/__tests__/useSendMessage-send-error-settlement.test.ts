// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

interface Row {
  id: string;
  type: string;
  variant?: string;
  content: string;
  timestamp: number;
}

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));

vi.mock('@/utils/api-client', () => ({ apiFetch }));
vi.mock('@/hooks/useChatCommands', () => ({ useChatCommands: () => ({ processCommand: async () => false }) }));

vi.mock('@/stores/chatStore', () => {
  const rows: Record<string, Row[]> = {};
  const state = {
    currentThreadId: 'thread-1',
    addMessageToThread: vi.fn((threadId: string, msg: Row) => {
      const list = (rows[threadId] ??= []);
      if (list.some((row) => row.id === msg.id)) return;
      list.push(msg);
    }),
    getThreadState: (threadId: string) => ({ messages: rows[threadId] ?? [] }),
    patchThreadMessage: vi.fn((threadId: string, id: string, patch: Partial<Row>) => {
      const list = rows[threadId] ?? [];
      const index = list.findIndex((row) => row.id === id);
      if (index >= 0) list[index] = { ...list[index]!, ...patch };
    }),
    removeThreadMessage: vi.fn((threadId: string, id: string) => {
      const list = rows[threadId];
      if (!list) return;
      rows[threadId] = list.filter((row) => row.id !== id);
    }),
    clearThreadMessageDeletion: vi.fn(),
    /** Test-only probe: what the owner would see in this conversation's history. */
    __rows: (threadId: string) => rows[threadId] ?? [],
    __reset: () => {
      for (const key of Object.keys(rows)) delete rows[key];
    },
  };
  return {
    useChatStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
  };
});

import { useSendMessage } from '@/hooks/useSendMessage';
import { useChatStore } from '@/stores/chatStore';

type ProbeStore = { __rows: (threadId: string) => Row[]; __reset: () => void };
const store = useChatStore.getState() as unknown as ProbeStore;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

let send: ReturnType<typeof useSendMessage>['handleSend'];
function Probe() {
  send = useSendMessage('thread-1').handleSend;
  return null;
}
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

beforeEach(async () => {
  apiFetch.mockReset();
  store.__reset();
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(React.createElement(Probe)));
});
afterEach(() => {
  if (root) act(() => root.unmount());
  host?.remove();
});

const timeout = () => Object.assign(new Error('网络请求超时，请重试。'), { name: 'TimeoutError' });
const queued = { ok: true, status: 202, json: async () => ({ status: 'queued', entryId: 'queue:1' }) };

function errorRows(): Row[] {
  return store.__rows('thread-1').filter((row) => row.variant === 'error');
}

describe('a send error notice belongs to the attempt that produced it', () => {
  it('removes the notice once the same attempt is retried under the same key and admitted', async () => {
    apiFetch.mockRejectedValueOnce(timeout());

    await act(async () => {
      expect(await send('hello', undefined, 'thread-1', undefined, undefined, undefined, undefined, {
        idempotencyKey: 'attempt-key',
      })).toBe(false);
    });
    expect(errorRows()).toHaveLength(1);
    expect(errorRows()[0]!.content).toContain('网络请求超时');

    apiFetch.mockResolvedValueOnce(queued);
    await act(async () => {
      expect(await send('hello', undefined, 'thread-1', undefined, undefined, undefined, undefined, {
        idempotencyKey: 'attempt-key',
      })).toBe(true);
    });

    expect(errorRows()).toHaveLength(0);
    expect(store.__rows('thread-1')).toHaveLength(0);
  });

  it('settles the notice rather than leaving a deletion tombstone behind', async () => {
    apiFetch.mockRejectedValueOnce(timeout());
    await act(async () => {
      await send('hello', undefined, 'thread-1', undefined, undefined, undefined, undefined, {
        idempotencyKey: 'attempt-key',
      });
    });
    const noticeId = errorRows()[0]!.id;

    apiFetch.mockResolvedValueOnce(queued);
    await act(async () => {
      await send('hello', undefined, 'thread-1', undefined, undefined, undefined, undefined, {
        idempotencyKey: 'attempt-key',
      });
    });

    expect(useChatStore.getState().removeThreadMessage).toHaveBeenCalledWith('thread-1', noticeId);
    expect(useChatStore.getState().clearThreadMessageDeletion).toHaveBeenCalledWith('thread-1', noticeId);
  });

  it('keeps the notice when a different attempt succeeds, so a real failure stays visible', async () => {
    apiFetch.mockRejectedValueOnce(timeout());
    await act(async () => {
      await send('hello', undefined, 'thread-1', undefined, undefined, undefined, undefined, {
        idempotencyKey: 'attempt-1',
      });
    });

    apiFetch.mockResolvedValueOnce(queued);
    await act(async () => {
      expect(await send('hello again', undefined, 'thread-1', undefined, undefined, undefined, undefined, {
        idempotencyKey: 'attempt-2',
      })).toBe(true);
    });

    expect(errorRows()).toHaveLength(1);
    expect(errorRows()[0]!.content).toContain('网络请求超时');
  });

  it('updates the same notice in place when the same attempt fails twice', async () => {
    apiFetch.mockRejectedValueOnce(timeout());
    await act(async () => {
      await send('hello', undefined, 'thread-1', undefined, undefined, undefined, undefined, {
        idempotencyKey: 'attempt-key',
      });
    });

    apiFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ detail: 'boom' }),
    });
    await act(async () => {
      await send('hello', undefined, 'thread-1', undefined, undefined, undefined, undefined, {
        idempotencyKey: 'attempt-key',
      });
    });

    expect(errorRows()).toHaveLength(1);
    expect(errorRows()[0]!.content).toContain('boom');
  });
});
