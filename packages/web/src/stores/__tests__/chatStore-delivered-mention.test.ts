import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_THREAD_STATE, useChatStore } from '../chatStore';

const NOW = 1700000000000;

function serverMsg(id: string, opts?: { catId?: string; content?: string; mentionsUser?: boolean }) {
  return {
    id,
    content: opts?.content ?? `msg-${id}`,
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

  it('keeps private mention content out of the OS notification and retains the canonical jump', () => {
    vi.stubGlobal('document', { hasFocus: () => false });
    const privateContent = `private-plan-${'do-not-expose'.repeat(20)}-secret-tail`;

    useChatStore
      .getState()
      .markMessagesDelivered('thread-1', ['m-private'], NOW + 1, [
        serverMsg('m-private', { catId: 'opus', content: privateContent, mentionsUser: true }),
      ]);

    expect(notifySpy).toHaveBeenCalledTimes(1);
    const options = notifySpy.mock.calls[0]?.[1] as NotificationOptions;
    expect(options.body).toBe('点击打开对应对话查看完整内容');
    expect(options.body).not.toContain('secret-tail');
    expect(options.body).not.toContain('do-not-expose');

    const instance = notifySpy.mock.instances[0] as unknown as Notification;
    expect(typeof instance.onclick).toBe('function');
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
          ...DEFAULT_THREAD_STATE,
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

  it('active thread: merges queued callback delivery into existing rich-block placeholder', () => {
    const audioBlock = {
      id: 'voice-1',
      kind: 'audio' as const,
      v: 1 as const,
      url: '/api/tts/audio/voice-1.wav',
      text: '五一快乐',
    };

    useChatStore.setState({
      currentThreadId: 'thread-1',
      messages: [
        {
          id: 'msg-inv-1-opus',
          type: 'assistant',
          catId: 'opus',
          content: '',
          origin: 'stream',
          isStreaming: true,
          timestamp: NOW - 10,
          extra: {
            stream: { invocationId: 'inv-1' },
            rich: { v: 1, blocks: [audioBlock] },
          },
        },
      ],
      threadStates: {},
    });

    useChatStore.getState().markMessagesDelivered('thread-1', ['server-msg-1'], NOW + 1, [
      {
        id: 'server-msg-1',
        content: '五一快乐',
        catId: 'opus',
        timestamp: NOW,
        origin: 'callback',
        extra: {
          stream: { invocationId: 'inv-1' },
          rich: { v: 1, blocks: [audioBlock] },
        },
      },
    ]);

    const messages = useChatStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: 'server-msg-1',
      type: 'assistant',
      catId: 'opus',
      content: '五一快乐',
      origin: 'callback',
      isStreaming: false,
      deliveredAt: NOW + 1,
    });
    expect(messages[0]?.extra?.rich?.blocks).toEqual([audioBlock]);
  });

  it('keeps already-published cat speech at its publication position on terminal delivery', () => {
    useChatStore.setState({
      currentThreadId: 'thread-1',
      messages: [
        {
          id: 'published-seed',
          type: 'assistant',
          catId: 'codex-sol',
          content: 'source-cat seed',
          timestamp: NOW,
        },
        {
          id: 'reply-after-seed',
          type: 'assistant',
          catId: 'opus',
          content: 'reply',
          timestamp: NOW + 10,
        },
      ],
      threadStates: {},
    });
    const serverMessages = [
      {
        id: 'published-seed',
        content: 'source-cat seed',
        catId: 'codex-sol',
        timestamp: NOW,
        timelineOrderAt: NOW,
      },
    ];

    useChatStore.getState().markMessagesDelivered('thread-1', ['published-seed'], NOW + 50, serverMessages);

    const messages = useChatStore.getState().messages;
    expect(messages.map((message) => message.id)).toEqual(['published-seed', 'reply-after-seed']);
    expect(messages[0]?.deliveredAt).toBe(NOW + 50);
  });

  it('terminalizes an existing queued user bubble in place without duplicating it', () => {
    useChatStore.setState({
      currentThreadId: 'thread-1',
      messages: [
        {
          id: 'queued-user',
          type: 'user',
          content: 'follow-up',
          timestamp: NOW,
          extra: {
            queueReceipt: {
              version: 1,
              entryId: 'entry-1',
              targets: [{ catId: 'opus', state: 'queued' }],
              reminderAttempts: [],
            },
          },
        },
        {
          id: 'later-reply',
          type: 'assistant',
          catId: 'opus',
          content: 'later',
          timestamp: NOW + 10,
        },
      ],
      threadStates: {},
    });

    useChatStore.getState().markMessagesDelivered('thread-1', ['queued-user'], NOW + 50, [
      {
        id: 'queued-user',
        content: 'follow-up',
        catId: null,
        timestamp: NOW,
        timelineOrderAt: NOW,
        extra: {
          queueReceipt: {
            version: 1,
            entryId: 'entry-1',
            targets: [
              {
                catId: 'opus',
                state: 'handled',
                invocationId: 'inv-1',
                seenAt: NOW + 20,
                outcome: {
                  invocationId: 'inv-1',
                  disposition: 'completed_with_turn',
                  evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv-1' },
                  handledAt: NOW + 50,
                },
              },
            ],
            reminderAttempts: [],
          },
        },
      },
    ]);

    const messages = useChatStore.getState().messages;
    expect(messages.map((message) => message.id)).toEqual(['queued-user', 'later-reply']);
    expect(messages[0]?.deliveredAt).toBe(NOW + 50);
    expect(messages[0]?.extra?.queueReceipt?.targets[0]).toMatchObject({
      state: 'handled',
      seenAt: NOW + 20,
    });
  });
});
