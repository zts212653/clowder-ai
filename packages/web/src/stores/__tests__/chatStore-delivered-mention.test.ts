import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChatStore } from '../chatStore';

const NOW = 1700000000000;

function serverMsg(id: string, opts?: { catId?: string; mentionsUser?: boolean }) {
  return {
    id,
    content: `msg-${id}`,
    catId: opts?.catId ?? null,
    timestamp: NOW,
    ...(opts?.mentionsUser ? { mentionsUser: true } : {}),
  };
}

describe('markMessagesDelivered mentionsUser notification', () => {
  let notifySpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    notifySpy = vi.fn();
    vi.stubGlobal('Notification', Object.assign(notifySpy, { permission: 'granted' }));
    useChatStore.setState({
      currentThreadId: 'thread-1',
      messages: [],
      threadStates: {},
    });
  });

  it('active thread + blurred: fires notification for new mention', () => {
    vi.stubGlobal('document', { hasFocus: () => false });

    useChatStore
      .getState()
      .markMessagesDelivered('thread-1', ['m1'], NOW + 1, [serverMsg('m1', { catId: 'opus', mentionsUser: true })]);

    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0][0]).toContain('@');
  });

  it('active thread + focused: does NOT fire notification', () => {
    vi.stubGlobal('document', { hasFocus: () => true });

    useChatStore
      .getState()
      .markMessagesDelivered('thread-1', ['m1'], NOW + 1, [serverMsg('m1', { catId: 'opus', mentionsUser: true })]);

    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('background thread: fires notification for new mention', () => {
    useChatStore
      .getState()
      .markMessagesDelivered('thread-bg', ['m1'], NOW + 1, [serverMsg('m1', { catId: 'opus', mentionsUser: true })]);

    expect(notifySpy).toHaveBeenCalledTimes(1);
    const ts = useChatStore.getState().threadStates['thread-bg'];
    expect(ts?.hasUserMention).toBe(true);
  });

  it('background thread: duplicate delivery does NOT re-light badge', () => {
    useChatStore.setState({
      threadStates: {
        'thread-bg': {
          messages: [
            {
              id: 'm1',
              type: 'assistant' as const,
              content: 'msg-m1',
              timestamp: NOW,
              catId: 'opus',
              mentionsUser: true,
              deliveredAt: NOW,
            },
          ],
          isLoading: false,
          isLoadingHistory: false,
          hasMore: true,
          hasActiveInvocation: false,
          catStatuses: {},
          catInvocations: {},
          hasDraft: false,
          intentMode: null,
          targetCats: [],
          queue: [],
          queuePaused: false,
          queueFull: false,
          hasUserMention: false,
        },
      },
    });

    useChatStore
      .getState()
      .markMessagesDelivered('thread-bg', ['m1'], NOW + 1, [serverMsg('m1', { catId: 'opus', mentionsUser: true })]);

    expect(notifySpy).not.toHaveBeenCalled();
    expect(useChatStore.getState().threadStates['thread-bg']?.hasUserMention).toBe(false);
  });
});
