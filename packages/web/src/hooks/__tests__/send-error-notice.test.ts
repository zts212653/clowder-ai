// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '@/stores/chatStore';
import { sendErrorNoticeId, settleAdmittedSendNotices, settleSendErrorNotice } from '../send-error-notice';

const THREAD = 'thread-1';

function publishNotice(attemptId: string, content = 'Failed to send message: timeout') {
  useChatStore.getState().addMessageToThread(THREAD, {
    id: sendErrorNoticeId(attemptId),
    type: 'system',
    variant: 'error',
    content,
    timestamp: Date.now(),
  });
}

function noticeIds(): string[] {
  return useChatStore
    .getState()
    .getThreadState(THREAD)
    .messages.filter((row) => row.variant === 'error')
    .map((row) => row.id);
}

describe('settleSendErrorNotice', () => {
  beforeEach(() => {
    useChatStore.setState({
      currentThreadId: THREAD,
      messages: [],
      queue: [],
      queueFull: false,
      queueFullSource: undefined,
      deletedMessageIds: {},
      threadStates: {},
    });
  });

  it('takes back the notice of the attempt the server admitted', () => {
    publishNotice('attempt-a');
    expect(noticeIds()).toEqual([sendErrorNoticeId('attempt-a')]);

    expect(settleSendErrorNotice(THREAD, 'attempt-a')).toBe(true);
    expect(noticeIds()).toEqual([]);
  });

  it('leaves a different attempt’s notice alone, so a real failure still shows', () => {
    publishNotice('attempt-a');
    publishNotice('attempt-b');

    expect(settleSendErrorNotice(THREAD, 'attempt-b')).toBe(true);
    expect(noticeIds()).toEqual([sendErrorNoticeId('attempt-a')]);
  });

  it('reports no settlement when the notice is already gone', () => {
    expect(settleSendErrorNotice(THREAD, 'never-failed')).toBe(false);
  });

  it('settles nothing for an event with no attempt key, rather than guessing', () => {
    publishNotice('attempt-a');
    expect(settleSendErrorNotice(THREAD, undefined)).toBe(false);
    expect(settleSendErrorNotice(THREAD, null)).toBe(false);
    expect(noticeIds()).toEqual([sendErrorNoticeId('attempt-a')]);
  });

  it('clears the deletion tombstone it recorded, so a later failure still shows', () => {
    publishNotice('attempt-a');
    settleSendErrorNotice(THREAD, 'attempt-a');
    expect(useChatStore.getState().deletedMessageIds[THREAD]?.has(sendErrorNoticeId('attempt-a')) ?? false).toBe(false);

    publishNotice('attempt-a', 'Failed to send message: second try');
    expect(noticeIds()).toEqual([sendErrorNoticeId('attempt-a')]);
    expect(useChatStore.getState().getThreadState(THREAD).messages[0]?.content).toContain('second try');
  });

  it('settles only the attempts that were actually admitted', () => {
    publishNotice('attempt-a');
    publishNotice('attempt-c');

    expect(settleAdmittedSendNotices(THREAD, ['attempt-a', undefined, 'attempt-b'])).toBe(1);
    expect(noticeIds()).toEqual([sendErrorNoticeId('attempt-c')]);
  });
});
