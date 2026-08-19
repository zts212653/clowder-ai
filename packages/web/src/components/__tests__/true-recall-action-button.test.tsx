import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const requestTrueRecallMock = vi.hoisted(() => vi.fn());
const composerInsertFromRecallMock = vi.hoisted(() => vi.fn());
const setQueueMock = vi.hoisted(() => vi.fn());
const setPendingChatInsertMock = vi.hoisted(() => vi.fn());
const removeThreadMessageMock = vi.hoisted(() => vi.fn());
const patchThreadMessageMock = vi.hoisted(() => vi.fn());
const addToastMock = vi.hoisted(() => vi.fn());

vi.mock('@/utils/true-recall', () => ({
  requestTrueRecall: requestTrueRecallMock,
  composerInsertFromRecall: composerInsertFromRecallMock,
  TrueRecallRequestError: class TrueRecallRequestError extends Error {
    code?: string;
  },
}));

vi.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: () => ({
      setQueue: setQueueMock,
      setPendingChatInsert: setPendingChatInsertMock,
      removeThreadMessage: removeThreadMessageMock,
      patchThreadMessage: patchThreadMessageMock,
    }),
  },
}));

vi.mock('@/stores/toastStore', () => ({
  useToastStore: { getState: () => ({ addToast: addToastMock }) },
}));

const { TrueRecallActionButton } = await import('../TrueRecallActionButton');

describe('TrueRecallActionButton', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    for (const mock of [
      requestTrueRecallMock,
      composerInsertFromRecallMock,
      setQueueMock,
      setPendingChatInsertMock,
      removeThreadMessageMock,
      patchThreadMessageMock,
      addToastMock,
    ]) {
      mock.mockReset();
    }
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  });

  it('disables duplicate controls while one authoritative recall mutation is pending', async () => {
    let resolveRecall!: (value: Record<string, unknown>) => void;
    requestTrueRecallMock.mockReturnValue(
      new Promise((resolve) => {
        resolveRecall = resolve;
      }),
    );
    composerInsertFromRecallMock.mockReturnValue({ threadId: 'thread-1', text: 'recalled body' });
    const message = {
      id: 'message-1',
      type: 'user' as const,
      content: 'recalled body',
      timestamp: 1,
      extra: {
        queueReceipt: { version: 1 as const, entryId: 'entry-1', targets: [], reminderAttempts: [] },
      },
    };

    act(() => root.render(<TrueRecallActionButton message={message} threadId="thread-1" />));
    const button = container.querySelector<HTMLButtonElement>('button[title="撤回并重新编辑"]');
    expect(button).not.toBeNull();

    act(() => button?.click());
    expect(button?.disabled).toBe(true);
    act(() => button?.click());
    expect(requestTrueRecallMock).toHaveBeenCalledOnce();

    await act(async () => {
      resolveRecall({
        verdict: 'zero_exposure',
        message: { id: message.id },
        draft: { threadId: 'thread-1', text: 'recalled body', revision: 1 },
        insertedRange: { start: 0, end: 13 },
        queue: [],
      });
      await Promise.resolve();
    });

    expect(setQueueMock).toHaveBeenCalledWith('thread-1', []);
    expect(setPendingChatInsertMock).toHaveBeenCalledWith({ threadId: 'thread-1', text: 'recalled body' });
    expect(removeThreadMessageMock).toHaveBeenCalledWith('thread-1', message.id);
    expect(patchThreadMessageMock).not.toHaveBeenCalled();
    expect(button?.disabled).toBe(false);
  });

  it('does not offer true recall without queue custody or after recall is terminal', () => {
    const base = { id: 'message-2', type: 'user' as const, content: 'body', timestamp: 2 };
    act(() => root.render(<TrueRecallActionButton message={base} threadId="thread-1" />));
    expect(container.querySelector('button')).toBeNull();

    act(() =>
      root.render(
        <TrueRecallActionButton
          message={{
            ...base,
            extra: {
              queueReceipt: { version: 1, entryId: 'entry-2', targets: [], reminderAttempts: [] },
              recall: { version: 1, exposure: 'seen', recalledAt: 3 },
            },
          }}
          threadId="thread-1"
        />,
      ),
    );
    expect(container.querySelector('button')).toBeNull();
  });
});
