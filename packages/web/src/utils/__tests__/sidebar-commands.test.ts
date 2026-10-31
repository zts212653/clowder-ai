import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockBegin = vi.fn();
const mockFail = vi.fn();
const mockInvalidate = vi.fn(() => Promise.resolve(true));

vi.mock('@/stores/sidebarProjectionStore', () => ({
  useSidebarProjectionStore: {
    getState: () => ({ beginSidebarCommand: mockBegin, failSidebarCommand: mockFail }),
  },
}));

vi.mock('@/utils/sidebar-thread-snapshot', () => ({
  invalidateSidebarProjection: () => mockInvalidate(),
}));

import { __resetSidebarCommandQueuesForTests, executeSidebarFieldCommand } from '../sidebar-commands';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('sidebar field command execution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetSidebarCommandQueuesForTests();
    mockBegin.mockImplementation((_threadId, field) => `command-${field}-${mockBegin.mock.calls.length}`);
  });

  it('serializes the same field so server completion order matches client command order', async () => {
    const firstResponse = deferred<{ ok: boolean }>();
    const callOrder: string[] = [];
    const first = executeSidebarFieldCommand({
      threadId: 'thread-1',
      field: 'pinned',
      value: true,
      request: () => {
        callOrder.push('first');
        return firstResponse.promise;
      },
    });
    const second = executeSidebarFieldCommand({
      threadId: 'thread-1',
      field: 'pinned',
      value: false,
      request: async () => {
        callOrder.push('second');
        return { ok: true };
      },
    });

    await vi.waitFor(() => expect(callOrder).toEqual(['first']));
    firstResponse.resolve({ ok: true });
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(callOrder).toEqual(['first', 'second']);
    expect(mockFail).not.toHaveBeenCalled();
    expect(mockInvalidate).toHaveBeenCalledTimes(2);
  });

  it('removes only the failed command and never rolls canonical rows back', async () => {
    mockBegin.mockReturnValue('failed-command');
    await expect(
      executeSidebarFieldCommand({
        threadId: 'thread-1',
        field: 'title',
        value: 'new title',
        request: async () => ({ ok: false }),
      }),
    ).resolves.toBe(false);

    expect(mockFail).toHaveBeenCalledWith('failed-command');
    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  it('aborts a timed-out command, removes its overlay, and refreshes canonical truth once', async () => {
    mockBegin.mockReturnValue('timed-out-command');
    let requestSignal: AbortSignal | undefined;

    await expect(
      executeSidebarFieldCommand({
        threadId: 'thread-1',
        field: 'pinned',
        value: true,
        timeoutMs: 1,
        request: (signal) => {
          requestSignal = signal;
          return new Promise(() => {});
        },
      }),
    ).resolves.toBe(false);

    expect(requestSignal?.aborted).toBe(true);
    expect(mockFail).toHaveBeenCalledWith('timed-out-command');
    expect(mockInvalidate).toHaveBeenCalledTimes(1);
  });
});
