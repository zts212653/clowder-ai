// @vitest-environment jsdom
/**
 * PR-3a (contract 3.8): a stored message the owner may otherwise only hear about through its thread
 * room. The hint refreshes the Sidebar and carries the owner mention notification; it has no body.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetOwnerMentionNotificationsForTests, useChatStore } from '@/stores/chatStore';

const invalidateSidebarProjection = vi.fn(() => Promise.resolve(true));
vi.mock('@/utils/sidebar-thread-snapshot', () => ({
  invalidateSidebarProjection: () => invalidateSidebarProjection(),
}));

const { isThreadMessageAppendedHint, observeThreadMessageAppended } = await import(
  '../agent-messages/thread-message-appended'
);

const shown: Array<{ title: string; tag?: string }> = [];
class FakeNotification {
  static permission = 'granted';
  static requestPermission = vi.fn();
  onclick: (() => void) | null = null;
  constructor(title: string, options?: { tag?: string }) {
    shown.push({ title, tag: options?.tag });
  }
  close() {}
}

describe('thread_message_appended hint', () => {
  let originalNotification: unknown;
  beforeEach(() => {
    originalNotification = (window as unknown as { Notification?: unknown }).Notification;
    (window as unknown as { Notification: unknown }).Notification = FakeNotification;
    (globalThis as unknown as { Notification: unknown }).Notification = FakeNotification;
    shown.length = 0;
    invalidateSidebarProjection.mockClear();
    __resetOwnerMentionNotificationsForTests();
    useChatStore.setState({ currentThreadId: 'thread-open', threadStates: {} });
  });
  afterEach(() => {
    (window as unknown as { Notification: unknown }).Notification = originalNotification;
    (globalThis as unknown as { Notification: unknown }).Notification = originalNotification;
    vi.restoreAllMocks();
  });

  it('refreshes the Sidebar for a standalone message with no later Queue or lifecycle event', () => {
    observeThreadMessageAppended({ threadId: 'thread-bg', messageId: 'post-1', catId: 'opus' });
    expect(invalidateSidebarProjection).toHaveBeenCalledOnce();
    expect(shown).toHaveLength(0);
  });

  it('notifies an owner mention in a background thread once, however many carriers deliver it', () => {
    observeThreadMessageAppended({ threadId: 'thread-bg', messageId: 'post-1', catId: 'opus', mentionsUser: true });
    observeThreadMessageAppended({ threadId: 'thread-bg', messageId: 'post-1', catId: 'opus', mentionsUser: true });
    // The same message landing in the store through its room uses the same notifier.
    useChatStore.getState().addMessageToThread('thread-bg', {
      id: 'post-1',
      type: 'assistant',
      catId: 'opus',
      content: 'hi',
      timestamp: 1,
      mentionsUser: true,
    });

    expect(shown).toEqual([{ title: 'opus @ 了你', tag: 'cocreator-mention-post-1' }]);
  });

  it('does not notify the open thread while the page is focused', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    observeThreadMessageAppended({ threadId: 'thread-open', messageId: 'post-2', mentionsUser: true });
    expect(shown).toHaveLength(0);
  });

  it('notifies the open thread when the page is not focused', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    observeThreadMessageAppended({ threadId: 'thread-open', messageId: 'post-3', mentionsUser: true });
    expect(shown).toHaveLength(1);
  });

  it('accepts only a well-formed hint', () => {
    expect(isThreadMessageAppendedHint({ threadId: 't', messageId: 'm' })).toBe(true);
    expect(isThreadMessageAppendedHint({ threadId: 't', messageId: 'm', mentionsUser: true, catId: 'c' })).toBe(true);
    expect(isThreadMessageAppendedHint({ threadId: '', messageId: 'm' })).toBe(false);
    expect(isThreadMessageAppendedHint({ threadId: 't' })).toBe(false);
    expect(isThreadMessageAppendedHint({ threadId: 't', messageId: 'm', mentionsUser: 'yes' })).toBe(false);
    expect(isThreadMessageAppendedHint(null)).toBe(false);
  });
});
